/**
 * pi-missions · roles/models
 *
 * 角色模型策略(I7 · 成本优化核心)。配置在仓库里(I6):missions/models.json
 *
 * 模型不可用(Q19):回退到会话当前模型 + 显式告知,mission 不阻断 ——
 * 模型策略是优化项不是正确性项。thinking level 始终按角色设置。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { Role } from "../core/types.ts";

export interface RoleModelConfig {
	provider?: string;
	model?: string;
	thinking?: string;
}

export type ModelsConfig = Partial<Record<Role, RoleModelConfig>>;

export const DEFAULT_THINKING: Record<Role, string> = {
	planner: "high",
	executor: "medium",
	verifier: "off",
	escalator: "high",
};

/** pi 的 thinking 档位(models.md)。具体模型可能只支持其中一部分 */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export const ROLE_ORDER: Role[] = ["planner", "executor", "verifier", "escalator"];

export const ROLE_DESC: Record<Role, string> = {
	planner: "FRAME 定义问题 + PLAN 设计 AC",
	executor: "DO 写代码(主力消耗)",
	verifier: "子进程独立核对 AC —— 判定权外置(I3)",
	escalator: "ACT 一轮失败诊断",
};

/** 循环切换 thinking 档位;传 null 表示当前用的是角色默认值 */
export function cycleThinking(current: string | undefined, role: Role, step = 1): string {
	const cur = current ?? DEFAULT_THINKING[role];
	const i = THINKING_LEVELS.indexOf(cur as (typeof THINKING_LEVELS)[number]);
	const next = (i < 0 ? 0 : i + step + THINKING_LEVELS.length) % THINKING_LEVELS.length;
	return THINKING_LEVELS[next];
}

export type RoleModelState = "configured" | "unavailable" | "inherit";

/**
 * 某个角色实际生效的模型。判别联合:只有 unavailable 才有"配的 / 实际的"两半,
 * 别退化成两个可选字段 —— 那会让每个读取点都得写一遍永不触发的 `?? 兜底`。
 */
export type RoleModelView = {
	role: Role;
	/** 实际会用到的模型的人类可读名(纯文本形态直接用它) */
	label: string;
	thinking: string;
	/** thinking 是角色默认值(没显式配过) */
	thinkingIsDefault: boolean;
} & (
	| { state: "configured" | "inherit" }
	| {
			state: "unavailable";
			/** 配置里写的那个;面板窄的时候优先牺牲它 */
			configured: string;
			/** 实际会用的那个;这是模型页存在的理由,绝不能被截掉 */
			actual: string;
	  }
);

/**
 * 由可选模型列表构造可用性判定。拿不到列表时一律按"可用"处理 ——
 * 不敢断言不可用好过满屏假警报。命令卡片与模型页必须用同一条规则。
 */
export function availabilityOf(models: Array<{ provider: string; id: string }>): (p: string, m: string) => boolean {
	const set = new Set(models.map((m) => `${m.provider}/${m.id}`));
	return (p, m) => set.size === 0 || set.has(`${p}/${m}`);
}

/**
 * 解析某个角色**实际生效**的模型,而不是配置里写了什么。
 *
 * 这个区分是必须的:applyRole() 在模型不可用时会静默回退到会话当前模型
 * (只 warn 一次)。面板若只显示配置值,你会以为 verifier 在用便宜模型,
 * 实际一直拿会话模型在烧钱。
 */
export function resolveRoleView(
	cfg: ModelsConfig,
	role: Role,
	isAvailable: (provider: string, model: string) => boolean,
	sessionLabel: string,
): RoleModelView {
	const rc = cfg[role];
	const thinking = rc?.thinking ?? DEFAULT_THINKING[role];
	const thinkingIsDefault = !rc?.thinking;

	if (!rc?.provider || !rc?.model) {
		return { role, state: "inherit", label: `${sessionLabel}(跟随会话)`, thinking, thinkingIsDefault };
	}
	const id = `${rc.provider}/${rc.model}`;
	return isAvailable(rc.provider, rc.model)
		? { role, state: "configured", label: id, thinking, thinkingIsDefault }
		: {
				role,
				state: "unavailable",
				label: `${id} → 实际用 ${sessionLabel}`,
				configured: id,
				actual: sessionLabel,
				thinking,
				thinkingIsDefault,
			};
}

/** 写回 missions/models.json。空配置也写文件 —— 面板改过就该有痕迹 */
export function saveModelsConfig(file: string, cfg: ModelsConfig): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");
}

export function loadModelsConfig(file: string): ModelsConfig {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8")) as ModelsConfig;
	} catch {
		return {};
	}
}

export interface SavedProfile {
	/** 进程内直接持有 Model 对象;跨会话接力时从 provider/modelId 重新解析 */
	model?: unknown;
	provider?: string;
	modelId?: string;
	thinking: string;
}

/** mission 开始时记录用户现场,RESTORE 时还原 */
export function saveProfile(pi: any, ctx: any): SavedProfile {
	const m = ctx.model as { provider?: string; id?: string } | undefined;
	return { model: m, provider: m?.provider, modelId: m?.id, thinking: pi.getThinkingLevel() };
}

/** 可持久化形态(进 STATE 同级的 profile.json,Model 对象不可序列化) */
export function profileToJson(p: SavedProfile): { provider?: string; modelId?: string; thinking: string } {
	return { provider: p.provider, modelId: p.modelId, thinking: p.thinking };
}

export function profileFromJson(j: { provider?: string; modelId?: string; thinking?: string }): SavedProfile {
	return { provider: j.provider, modelId: j.modelId, thinking: j.thinking ?? "medium" };
}

/**
 * 应用角色配置。pi/ctx 用 any:extension 类型在包外不可达,
 * 这里只用到 setModel/setThinkingLevel/getThinkingLevel/modelRegistry。
 */
export async function applyRole(
	pi: any,
	ctx: any,
	role: Role,
	cfg: ModelsConfig,
	warn: (msg: string) => void,
): Promise<void> {
	const rc = cfg[role];
	pi.setThinkingLevel((rc?.thinking ?? DEFAULT_THINKING[role]) as never);

	if (rc?.provider && rc?.model) {
		const m = ctx.modelRegistry.find(rc.provider, rc.model);
		if (!m) {
			warn(`${role} 配置的模型 ${rc.provider}/${rc.model} 不可用,回退到当前模型(thinking 仍按角色设置)`);
			return;
		}
		const ok = await pi.setModel(m);
		if (!ok) warn(`${role} 切换模型 ${rc.provider}/${rc.model} 失败,回退到当前模型`);
	}
}

export async function restoreProfile(pi: any, ctx: any, saved: SavedProfile | null): Promise<void> {
	if (!saved) return;
	pi.setThinkingLevel(saved.thinking as never);
	if (saved.model) {
		await pi.setModel(saved.model);
	} else if (saved.provider && saved.modelId) {
		// 跨会话接力:Model 对象已随旧会话销毁,按 provider/id 重新解析
		const m = ctx.modelRegistry.find(saved.provider, saved.modelId);
		if (m) await pi.setModel(m);
	}
}

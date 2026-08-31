/**
 * pi-missions · roles/models
 *
 * 角色模型策略(I7 · 成本优化核心)。配置在仓库里(I6):missions/models.json
 *
 * 模型不可用(Q19):回退到会话当前模型 + 显式告知,mission 不阻断 ——
 * 模型策略是优化项不是正确性项。thinking level 始终按角色设置。
 */

import * as fs from "node:fs";
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

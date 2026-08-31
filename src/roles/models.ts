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
	model: unknown | undefined;
	thinking: string;
}

/** mission 开始前记录用户现场,RESTORE 时还原 */
export function saveProfile(pi: any, ctx: any): SavedProfile {
	return { model: ctx.model, thinking: pi.getThinkingLevel() };
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

export async function restoreProfile(pi: any, saved: SavedProfile | null): Promise<void> {
	if (!saved) return;
	pi.setThinkingLevel(saved.thinking as never);
	if (saved.model) await pi.setModel(saved.model);
}

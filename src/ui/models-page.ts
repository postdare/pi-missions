/**
 * pi-missions · ui/models-page
 *
 * /missions 面板的「模型」页:角色 → 模型 / thinking 的映射,写 missions/models.json。
 *
 * 这一页最重要的设计点是**显示实际生效的值,而不是配置里写了什么**:
 * applyRole() 在模型不可用时会静默回退到会话模型,只 warn 一次。面板若照抄配置,
 * 你会以为 verifier 在用便宜模型,实际一直拿会话模型烧钱。
 *
 * 渲染是纯函数(theme 只做上色),便于单测。
 */

import type { Role } from "../core/types.ts";
import {
	DEFAULT_THINKING,
	ROLE_DESC,
	ROLE_ORDER,
	resolveRoleView,
	type ModelsConfig,
} from "../roles/models.ts";

interface Theme {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

export interface ModelOption {
	provider: string;
	id: string;
	name?: string;
}

export interface ModelsPageData {
	config: ModelsConfig;
	/** 可选模型(ctx.scopedModels 优先) */
	models: ModelOption[];
	/** 会话当前模型的可读名 */
	sessionLabel: string;
	/** 活动 mission 的按角色花费;无活动 mission 为空 */
	cost: Partial<Record<Role, number>>;
	/** 活动 mission 的相位角色(用于标出"当前正在用") */
	activeRole: Role | null;
	dirName: string;
}

export const STATE_ICON: Record<string, string> = {
	configured: "●",
	unavailable: "⚠",
	inherit: "○",
};

const STATE_COLOR: Record<string, string> = {
	configured: "success",
	unavailable: "error",
	inherit: "dim",
};

function pad(s: string, width: number, visible: (s: string) => number): string {
	return s + " ".repeat(Math.max(0, width - visible(s)));
}

/** 角色行。selected 为高亮行 */
export function modelRows(d: ModelsPageData, selected: number, t: Theme, visible: (s: string) => number): string[] {
	const available = new Set(d.models.map((m) => `${m.provider}/${m.id}`));
	const isAvailable = (p: string, m: string) =>
		// 拿不到模型列表时不敢断言"不可用",按已配置显示,避免满屏假警报
		available.size === 0 || available.has(`${p}/${m}`);

	const lines: string[] = [];
	for (const [i, role] of ROLE_ORDER.entries()) {
		const v = resolveRoleView(d.config, role, isAvailable, d.sessionLabel);
		const cursor = pad(i === selected ? "▸" : " ", 2, visible);
		const name = pad(role, 11, visible);
		const icon = t.fg(STATE_COLOR[v.state] ?? "dim", STATE_ICON[v.state] ?? "?");
		const label = v.state === "unavailable" ? t.fg("error", v.label) : t.fg(v.state === "inherit" ? "dim" : "fg", v.label);
		const thinking = v.thinkingIsDefault ? t.fg("dim", `${v.thinking}(默认)`) : t.fg("accent", v.thinking);
		const spent = d.cost[role];
		const money = spent ? t.fg("dim", `  $${spent.toFixed(4)}`) : "";
		const here = d.activeRole === role ? t.fg("accent", " ←当前相位") : "";
		lines.push(
			`${cursor}${i === selected ? t.bold(name) : t.fg("dim", name)}${icon} ${pad(label, 40, visible)} ${thinking}${money}${here}`,
		);
		lines.push(`   ${t.fg("dim", ROLE_DESC[role])}`);
	}
	return lines;
}

/** 页脚说明:哪里落盘、三个图标什么意思 */
export function modelsFooter(d: ModelsPageData, t: Theme): string[] {
	return [
		"",
		t.fg("dim", `写入 ${d.dirName}/models.json · ${STATE_ICON.configured} 已配置  ${STATE_ICON.unavailable} 配了但不可用(实际跟随会话)  ${STATE_ICON.inherit} 未配置`),
		t.fg("dim", "verifier 是判定权外置(I3)的那一环 —— 与执行者同源的模型会共享同一批盲点。"),
	];
}

/** 模型选择器的可见条目(带过滤) */
export function filterModels(models: ModelOption[], filter: string): ModelOption[] {
	const f = filter.trim().toLowerCase();
	if (!f) return models;
	return models.filter((m) => `${m.provider}/${m.id} ${m.name ?? ""}`.toLowerCase().includes(f));
}

/** 选择器行 */
export function pickerRows(
	models: ModelOption[],
	selected: number,
	current: { provider?: string; model?: string } | undefined,
	t: Theme,
): string[] {
	if (models.length === 0) return [t.fg("dim", "  (没有匹配的模型;Esc 取消)")];
	return models.map((m, i) => {
		const id = `${m.provider}/${m.id}`;
		const mark = current?.provider === m.provider && current?.model === m.id ? "✓" : " ";
		const line = `  ${i === selected ? "▸" : " "} ${mark} ${id}${m.name ? t.fg("dim", `  ${m.name}`) : ""}`;
		return i === selected ? t.bold(line) : line;
	});
}

/** 角色默认 thinking 的说明(清除配置时用) */
export function defaultThinkingOf(role: Role): string {
	return DEFAULT_THINKING[role];
}

/**
 * pi-missions · ui/models-page
 *
 * /missions 面板的「模型」页:角色 → 模型 / thinking 的映射,写 missions/models.json。
 *
 * 这一页最重要的设计点是**显示实际生效的值,而不是配置里写了什么**:
 * applyRole() 在模型不可用时会静默回退到会话模型,只 warn 一次。面板若照抄配置,
 * 你会以为 verifier 在用便宜模型,实际一直拿会话模型烧钱。
 *
 * 渲染是纯函数(theme 只做上色),便于单测。视觉约定见 ui/chrome.ts 头部。
 */

import { visibleWidth } from "@earendil-works/pi-tui";
import type { Role } from "../core/types.ts";
import {
	availabilityOf,
	DEFAULT_THINKING,
	ROLE_DESC,
	ROLE_ORDER,
	resolveRoleView,
	type ModelsConfig,
	type RoleModelView,
} from "../roles/models.ts";
import { clip, CURSOR, pad } from "./chrome.ts";

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

/** "配的 → 实际的" 中间那个箭头。宽度要参与列宽计算,只许有一处定义 */
const ARROW = " → ";

const COL_CURSOR = 2;
const COL_ROLE = 11;
const COL_ICON = 2;
const COL_THINKING = 13;
const COL_COST = 10;

/**
 * 「配的是 A,实际用的是 B」放不下时,牺牲 A 而不是 B。
 * B 才是这一页存在的理由 —— 截掉它等于把面板变回"照抄配置",
 * 而照抄配置正是这个模块开头说的那种误导。
 */
function unavailableLabel(configured: string, actual: string, width: number, t: Theme): string {
	const room = width - visibleWidth(ARROW + actual);
	if (room >= 4) return t.fg("error", clip(configured, room)) + t.fg("muted", ARROW) + actual;
	// 连 B 都放不下:只显示 B,前面加个 ⚠ 已经说明"配的那个没生效"
	return t.fg("muted", clip(actual, width));
}

/**
 * 角色行。selected 行加光标 + 加粗,并在下方展开一行角色说明。
 * width 是盒内宽,用来算模型名那一列能占多少 —— 窄屏优先保住模型名。
 */
export function modelRows(d: ModelsPageData, selected: number, t: Theme, width = 92): string[] {
	const isAvailable = availabilityOf(d.models);

	// 窄屏按重要性丢列:先丢「当前相位」尾标,再丢花费,最后把 thinking 缩成裸值 ——
	// 模型名(尤其是"实际生效"的那个)是这一页的主信息,最后才让位
	const showTag = width >= 76;
	const showCost = width >= 68;
	const thinkingW = width >= 68 ? COL_THINKING : 8;
	const room = Math.max(
		18,
		width - COL_CURSOR - COL_ROLE - COL_ICON - thinkingW - (showCost ? COL_COST : 0) - (showTag ? 11 : 1),
	);

	const views = ROLE_ORDER.map((role) => resolveRoleView(d.config, role, isAvailable, d.sessionLabel));
	// 列宽取**实际渲染出来最长的那个** + 一格留白,而不是一律吃满剩余空间 ——
	// 否则模型名短的时候 thinking 会被推到半屏之外,读起来根本对不上是谁的。
	// 注意 unavailable 行渲染成 "配的 → 实际的",比 v.label 短(少了"实际用"三个字)
	const shown = (v: RoleModelView) =>
		v.state === "unavailable" ? visibleWidth(v.configured + ARROW + v.actual) : visibleWidth(v.label);
	const labelW = Math.min(room, Math.max(...views.map(shown)) + 2);

	const lines: string[] = [];
	for (const [i, role] of ROLE_ORDER.entries()) {
		const on = i === selected;
		const v = views[i];
		const cursor = on ? t.fg("accent", CURSOR) + " " : " ".repeat(COL_CURSOR);
		const name = pad(role, COL_ROLE);
		const icon = pad(t.fg(STATE_COLOR[v.state] ?? "dim", STATE_ICON[v.state] ?? "?"), COL_ICON);
		// 已配置且可用的那一行用默认前景色 —— 主题里没有名为 "fg" 的颜色,
		// 传进去 pi 会抛 Unknown theme color 并把整个 TUI 带崩
		const label =
			v.state === "unavailable"
				? unavailableLabel(v.configured, v.actual, labelW - 1, t)
				: v.state === "inherit"
					? t.fg("dim", clip(v.label, labelW - 1))
					: clip(v.label, labelW - 1);
		const thinkingText = v.thinkingIsDefault
			? t.fg("dim", showCost ? `${v.thinking}(默认)` : v.thinking)
			: t.fg("accent", v.thinking);
		const thinking = pad(thinkingText, thinkingW);
		const spent = d.cost[role];
		const money = showCost ? pad(spent ? t.fg("muted", `$${spent.toFixed(4)}`) : "", COL_COST) : "";
		// 窄屏放不下这个尾标,直接不显示 —— 截成 "← …" 反而看不懂
		const here = d.activeRole === role && showTag ? t.fg("accent", "← 当前相位") : "";
		const row = `${cursor}${on ? t.bold(name) : t.fg("muted", name)}${icon}${pad(label, labelW)}${thinking}${money}${here}`;
		lines.push(row);
		if (on) lines.push(" ".repeat(COL_CURSOR + COL_ROLE + COL_ICON) + t.fg("dim", ROLE_DESC[role]));
	}
	return lines;
}

/** 页脚说明:三个图标什么意思、哪里落盘。只留看图必需的,不放设计说教 */
export function modelsFooter(d: ModelsPageData, t: Theme): string[] {
	return [
		"",
		t.fg("dim", `${STATE_ICON.configured} 已配置   ${STATE_ICON.unavailable} 配了但不可用(实际跟随会话)   ${STATE_ICON.inherit} 未配置   写入 ${d.dirName}/models.json`),
	];
}

/** 模型选择器的可见条目(带过滤) */
export function filterModels(models: ModelOption[], filter: string): ModelOption[] {
	const f = filter.trim().toLowerCase();
	if (!f) return models;
	return models.filter((m) => `${m.provider}/${m.id} ${m.name ?? ""}`.toLowerCase().includes(f));
}

/** 选择器行:▎ 光标条,✓ 标出当前生效的那一个 */
export function pickerRows(
	models: ModelOption[],
	selected: number,
	current: { provider?: string; model?: string } | undefined,
	t: Theme,
): string[] {
	if (models.length === 0) return [t.fg("dim", "   (没有匹配的模型;Esc 取消)")];
	return models.map((m, i) => {
		const on = i === selected;
		const id = `${m.provider}/${m.id}`;
		const isCurrent = current?.provider === m.provider && current?.model === m.id;
		const cursor = on ? t.fg("accent", CURSOR) + " " : "  ";
		const mark = isCurrent ? t.fg("success", "✓") : " ";
		const line = `${cursor}${mark} ${id}${m.name ? t.fg("dim", `  ${m.name}`) : ""}`;
		return on ? t.bold(line) : line;
	});
}

/** 角色默认 thinking 的说明(清除配置时用) */
export function defaultThinkingOf(role: Role): string {
	return DEFAULT_THINKING[role];
}

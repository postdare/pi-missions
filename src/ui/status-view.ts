/**
 * pi-missions · ui/status-view
 *
 * /mission status 的 TUI 形态:带页签的浮层(open-tui settings 风格)。
 * Tab/←→ 切页,↑/↓ 页内滚动,r 立即刷新(另每 2s 自动),q/Esc 关闭。
 * 非 TUI 环境退化为 entry 卡片(renderStatusDashboard)。
 */

import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { MissionState } from "../core/types.ts";
import type { MissionPlan } from "../store/mission.ts";
import {
	acLines,
	overviewLines,
	renderStatusDashboard,
	taskLines,
	type EvidenceSummary,
} from "./dashboard.ts";

export interface StatusViewData {
	plan: MissionPlan;
	state: MissionState;
	evidence: EvidenceSummary;
	logLines: string[];
	dirName: string;
}

type TabId = "overview" | "tasks" | "ac" | "log";
const TABS: Array<{ id: TabId; label: string }> = [
	{ id: "overview", label: "概览" },
	{ id: "tasks", label: "任务" },
	{ id: "ac", label: "验收" },
	{ id: "log", label: "日志" },
];

/** 可视窗口高度(内容区行数) */
const VIEWPORT = 18;

interface Theme {
	fg(color: string, text: string): string;
	bg(color: string, text: string): string;
	bold(text: string): string;
}

function clip(line: string, width: number): string {
	if (visibleWidth(line) <= width) return line;
	let out = line;
	while (out.length > 0 && visibleWidth(`${out}…`) > width) out = out.slice(0, -1);
	return `${out}…`;
}

function tabContent(tab: TabId, d: StatusViewData): string[] {
	switch (tab) {
		case "overview":
			return overviewLines(d.plan, d.state);
		case "tasks":
			return taskLines(d.plan, d.state);
		case "ac":
			return acLines(d.plan, d.evidence, d.dirName);
		case "log":
			return d.logLines.length > 0 ? d.logLines : ["(暂无日志)"];
	}
}

export async function openStatusView(ctx: any, getData: () => StatusViewData | null): Promise<void> {
	// 非 TUI:退化为一次性卡片
	if (!ctx.hasUI) return;

	await ctx.ui.custom(
		(tui: any, theme: Theme, _kb: any, done: (r: void) => void) => {
			let data = getData();
			let tab: TabId = "overview";
			const scroll: Record<TabId, number> = { overview: 0, tasks: 0, ac: 0, log: 0 };
			let closed = false;

			const refresh = () => {
				try {
					data = getData() ?? data;
				} catch {
					/* keep last good */
				}
				if (!closed) tui.requestRender();
			};
			const timer = setInterval(refresh, 2_000);

			const close = () => {
				if (closed) return;
				closed = true;
				clearInterval(timer);
				done(undefined);
			};

			const switchTab = (offset: number) => {
				const idx = TABS.findIndex((t) => t.id === tab);
				tab = TABS[(idx + offset + TABS.length) % TABS.length].id;
			};

			return {
				render: (w: number) => {
					const t = theme;
					const inner = Math.max(44, Math.min(w - 6, 100));
					const border = (s: string) => t.fg("borderAccent", s);
					const row = (content: string) => {
						const c = clip(content, inner - 4);
						const pad = Math.max(0, inner - 4 - visibleWidth(c));
						return t.bg("customMessageBg", `${border("│")} ${c}${" ".repeat(pad)} ${border("│")}`);
					};

					// 标题栏
					const title = data ? ` ${data.state.missionId} · ${data.state.tier} · ${data.state.phase} ` : " mission ";
					const tabBar = TABS.map((tb) =>
						tb.id === tab ? t.fg("accent", t.bold(`[${tb.label}]`)) : t.fg("dim", ` ${tb.label} `),
					).join(" ");
					const lines: string[] = [
						t.bg(
							"customMessageBg",
							border("╭─") +
								t.bold(t.fg("accent", title)) +
								// 左右不对称:左边 ╭─(2 列),右边只有 ╮(1 列) → n = inner - 3 - titleW
								// title 先截断:窄屏时 title 可能比 inner 还宽,不截断会超宽炸 TUI
								border("─".repeat(Math.max(1, inner - 3 - visibleWidth(truncateToWidth(title, inner - 6))))) +
								border("╮"),
						),
						row(tabBar),
						row(t.fg("dim", "─".repeat(Math.min(48, inner - 8)))),
					];

					if (!data) {
						lines.push(row(t.fg("dim", "无活动 mission")));
					} else {
						// 内容区:固定窗口 + 滚动
						const content = tabContent(tab, data);
						const maxOffset = Math.max(0, content.length - VIEWPORT);
						scroll[tab] = Math.min(scroll[tab], maxOffset);
						const off = scroll[tab];
						const slice = content.slice(off, off + VIEWPORT);
						for (const l of slice) lines.push(row(l));
						for (let i = slice.length; i < VIEWPORT; i++) lines.push(row(""));
						if (maxOffset > 0) {
							lines.push(row(t.fg("dim", `  ${off + 1}-${Math.min(off + VIEWPORT, content.length)}/${content.length} 行 · ↑↓ 滚动`)));
						}
					}

					lines.push(
						t.bg(
							"customMessageBg",
							border("╰─") +
								t.fg("dim", " Tab/←→ 切页 · ↑↓ 滚动 · r 刷新 · q/Esc 关闭 ") +
								// 同 header:左边 ╰─(2),右边 ╯(1) → n = inner - 3 - hintW;hint 先截断防窄屏超宽
								border("─".repeat(Math.max(1, inner - 3 - visibleWidth(truncateToWidth(" Tab/←→ 切页 · ↑↓ 滚动 · r 刷新 · q/Esc 关闭 ", inner - 6))))) +
								border("╯"),
						),
					);
					return lines;
				},
				invalidate: () => {},
				handleInput: (input: string) => {
					if (matchesKey(input, Key.escape) || matchesKey(input, "q")) return close();
					if (matchesKey(input, Key.tab) || matchesKey(input, Key.right)) {
						switchTab(1);
						return tui.requestRender();
					}
					if (matchesKey(input, Key.shift("tab")) || matchesKey(input, Key.left)) {
						switchTab(-1);
						return tui.requestRender();
					}
					if (matchesKey(input, Key.up)) {
						scroll[tab] = Math.max(0, scroll[tab] - 1);
						return tui.requestRender();
					}
					if (matchesKey(input, Key.down)) {
						if (data) {
							const maxOffset = Math.max(0, tabContent(tab, data).length - VIEWPORT);
							scroll[tab] = Math.min(maxOffset, scroll[tab] + 1);
						}
						return tui.requestRender();
					}
					if (matchesKey(input, "r")) return refresh();
				},
			};
		},
		{ overlay: true, overlayOptions: { anchor: "center", width: "76%", margin: 1 } },
	);
}

/** 非 TUI 环境的降级输出 */
export function statusFallbackText(d: StatusViewData): string {
	return renderStatusDashboard(d.plan, d.state, d.evidence, d.logLines.slice(-5), d.dirName);
}

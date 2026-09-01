/**
 * pi-missions · ui/status-view
 *
 * /mission status 的 TUI 形态:双栏内联页(编排器风格圆角盒,非 overlay ——
 * 替换编辑器区域,聊天记录留在上方)。
 *
 *   ╭─ m-20260901-1402 · standard ──────────────────── 43min · $1.37 ─╮
 *   │ ● 执行  ████░░░░░░  1/4 任务                                     │
 *   ├──────────────────────────────────────────────────────────────────┤
 *   │ 概览 ─────────────────  │ 任务 3/9 ──────────────────            │
 *   │ 目标      迁移鉴权…      │  ✓ T1 引入 JwtProvider                 │
 *   │ 验收 ─────────────────  │ 日志 12 行 ────────────────            │
 *   ╰──────────────────────────────────────────────────────────────────╯
 *    Tab 切面板   ↑↓ 滚动   R 刷新   Esc 关闭
 *
 * 三块内容(概览+验收 / 任务 / 日志)各自滚动,Tab 切换焦点 ——
 * 焦点段的标题用 accent 加粗,其余 muted,配 ruleLabel 的横线把段落切开。
 * 非 TUI 环境退化为 entry 卡片(renderStatusDashboard)。
 */

import { Key, matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import {
	boxBot,
	boxRow,
	boxSep,
	boxTop,
	clip,
	contentBudget,
	tabs,
	hintBar,
	miniBar,
	pad,
	ruleLabel,
} from "./chrome.ts";
import type { MissionState } from "../core/types.ts";
import type { MissionPlan } from "../store/mission.ts";
import {
	acLines,
	costTotal,
	fmtDuration,
	overviewLines,
	PHASE_STYLE,
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

type Focus = 0 | 1 | 2; // 0 = 左栏(概览+验收) 1 = 任务 2 = 日志

/** 盒内宽小于这个数就放弃双栏 —— 两条 20 来列的细缝比一栏更难读 */
const NARROW = 72;

interface Theme {
	fg(color: string, text: string): string;
	bg(color: string, text: string): string;
	bold(text: string): string;
}

/** 进度条头:● 执行  ████░░░░░░  1/4 任务 */
function headerLine(d: StatusViewData, t: Theme, width: number): string {
	const s = d.state;
	const st = PHASE_STYLE[s.phase] ?? PHASE_STYLE.halted;
	const done = Object.values(s.tasks).filter((x) => x.status === "done").length;
	const total = s.taskOrder.length;
	const label = `${st.icon} ${st.label}`;
	const barW = Math.max(6, Math.min(18, width - visibleWidth(label) - 16));
	const head = `${t.fg(st.color, t.bold(label))}  ${miniBar(t, done, total, barW)}  ${t.fg("dim", `${done}/${total} 任务`)}`;
	return clip(head, width);
}

/** 盒顶右侧的 meta:已运行时长 · 总花费 */
function headerMeta(d: StatusViewData, now: number): string | undefined {
	const bits: string[] = [];
	const elapsed = d.plan.createdAt ? fmtDuration(d.plan.createdAt, now) : null;
	if (elapsed && elapsed !== "0min") bits.push(elapsed);
	const cost = costTotal(d.state);
	if (cost >= 0.005) bits.push(`$${cost.toFixed(2)}`);
	return bits.length > 0 ? bits.join(" · ") : undefined;
}

export interface StatusView {
	theme: Theme;
	width: number;
	rows: number;
	now: number;
	data: StatusViewData | null;
	focus: Focus;
	/** 三块的滚动偏移;renderStatus 会夹取到合法区间并原地写回 */
	scroll: [number, number, number];
	canResume: boolean;
}

/** 状态页全部行(含盒外提示条)。纯函数,scroll 就地夹取 */
export function renderStatus(v: StatusView): string[] {
	const t = v.theme;
	const width = Math.max(56, v.width);
	const inner = width - 4;
	const budget = contentBudget(v.rows);
	const bodyH = Math.max(6, budget - 3); // 盒顶 / 头行 / 分隔 / 盒底 / 提示条

	const hints: Array<[string, string]> = [
		["Tab", "切面板"],
		["↑↓", "滚动"],
		...(v.canResume ? ([["Ctrl+R", "恢复"]] as Array<[string, string]>) : []),
		["R", "刷新"],
		["Esc", "关闭"],
	];

	if (!v.data) {
		const out = [boxTop(t, width, "mission")];
		for (let i = 0; i < bodyH; i++) out.push(boxRow(t, width, i === 0 ? t.fg("dim", "无活动 mission") : ""));
		out.push(boxBot(t, width), hintBar(t, width, [["Esc", "关闭"]]));
		return out;
	}

	const d = v.data;
	const out: string[] = [
		// mission id 是从目标自动生成的 slug,可能很长 —— 截断它,把顶边留给 meta
		boxTop(t, width, `${clip(d.state.missionId, 32)} · ${d.state.tier}`, headerMeta(d, v.now)),
		boxRow(t, width, headerLine(d, t, inner)),
		boxSep(t, width),
	];

	// 竖分隔连同两侧留白占 3 列;左右基本对半 —— 左栏是「标签 值」,右栏是日志,都吃宽度
	const narrow = inner < NARROW;
	const rightW = Math.max(24, Math.floor(inner * 0.52));
	const leftW = narrow ? inner : Math.max(16, inner - 3 - rightW);

	// 盒标题给了 id/档位,头行给了相位与进度 —— 概览栏不再重复,空间留给目标
	const overview = overviewLines(d.plan, d.state, { now: v.now, theme: t, width: leftW, omitIdentity: true });
	const ac = acLines(d.plan, d.evidence, d.dirName, t, leftW);
	const taskAll = taskLines(d.plan, d.state, t, narrow ? inner : rightW);
	const logAll = d.logLines.length > 0 ? d.logLines.map((l) => t.fg("dim", l)) : [t.fg("dim", "(暂无日志)")];

	const clamp = (i: Focus, len: number, winH: number) => {
		v.scroll[i] = Math.max(0, Math.min(v.scroll[i], Math.max(0, len - winH)));
		return v.scroll[i];
	};

	// 段标题的计数说明的是**内容条目数**(任务数 / 日志行数),不是渲染行数 ——
	// 任务的失败原因/签名会各占一行,拿行数当任务数会数错
	const scrolled = (off: number, win: number, len: number) =>
		len > win ? ` · 行 ${off + 1}-${Math.min(off + win, len)}/${len}` : "";
	const taskCount = d.plan.milestones.reduce((n, ms) => n + ms.tasks.length, 0);
	const taskDone = Object.values(d.state.tasks).filter((x) => x.status === "done").length;

	// ── 窄屏:双栏会挤成两条细缝,退化成单栏 —— 只渲染焦点段,Tab 切换 ──
	if (narrow) {
		const secs: Array<{ label: string; lines: string[] }> = [
			{ label: "概览/验收", lines: [...overview, "", ruleLabel(t, inner, "验收"), ...ac] },
			{ label: `任务 ${taskDone}/${taskCount}`, lines: taskAll },
			{ label: `日志 ${d.logLines.length} 行`, lines: logAll },
		];
		const winH = bodyH - 1;
		const off = clamp(v.focus, secs[v.focus].lines.length, winH);
		out.push(
			boxRow(t, width, tabs(t, secs.map((sec, i) => ({ id: String(i), label: sec.label })), String(v.focus))),
		);
		const body = secs[v.focus].lines.slice(off, off + winH);
		for (let i = 0; i < winH; i++) out.push(boxRow(t, width, clip(body[i] ?? "", inner)));
		out.push(boxBot(t, width));
		out.push(hintBar(t, width, hints, scrolled(off, winH, secs[v.focus].lines.length).replace(" · ", "")));
		return out;
	}

	// ── 左栏:概览段 + 验收段,共用一个滚动条 ──
	const leftAll = [
		ruleLabel(t, leftW, "概览", v.focus === 0),
		...overview,
		"",
		ruleLabel(t, leftW, "验收", v.focus === 0),
		...ac,
	];
	const leftOff = clamp(0, leftAll.length, bodyH);
	const leftLines = leftAll.slice(leftOff, leftOff + bodyH).map((l) => clip(l, leftW));
	while (leftLines.length < bodyH) leftLines.push("");

	// ── 右栏:任务段 + 日志段,各自滚动;任务占一半(上限其内容 + 段头),日志吃剩余 ──
	const taskSecH = Math.min(taskAll.length + 1, Math.max(3, Math.floor(bodyH / 2)));
	const taskWinH = taskSecH - 1;
	const logWinH = Math.max(1, bodyH - taskSecH - 1);
	const taskOff = clamp(1, taskAll.length, taskWinH);
	const logOff = clamp(2, logAll.length, logWinH);
	const rightLines: string[] = [
		ruleLabel(t, rightW, `任务 ${taskDone}/${taskCount}${scrolled(taskOff, taskWinH, taskAll.length)}`, v.focus === 1),
	];
	for (const l of taskAll.slice(taskOff, taskOff + taskWinH)) rightLines.push(clip(l, rightW));
	while (rightLines.length < taskSecH) rightLines.push("");
	rightLines.push(
		ruleLabel(t, rightW, `日志 ${d.logLines.length} 行${scrolled(logOff, logWinH, logAll.length)}`, v.focus === 2),
	);
	for (const l of logAll.slice(logOff, logOff + logWinH)) rightLines.push(clip(l, rightW));
	while (rightLines.length < bodyH) rightLines.push("");

	// 拼双栏:左栏 │ 右栏(分隔两侧各留一格,不让文字贴着竖线)
	const divider = t.fg("borderMuted", "│");
	for (let i = 0; i < bodyH; i++) {
		const lcell = pad(clip(leftLines[i] ?? "", leftW), leftW);
		const rcell = clip(rightLines[i] ?? "", rightW);
		out.push(boxRow(t, width, `${lcell} ${divider} ${rcell}`));
	}

	out.push(boxBot(t, width));
	out.push(hintBar(t, width, hints));
	return out;
}

export async function openStatusView(
	ctx: any,
	getData: () => StatusViewData | null,
	opts?: { onResume?: (missionId: string) => void },
): Promise<void> {
	// 非 TUI:退化为一次性卡片
	if (!ctx.hasUI) return;

	await ctx.ui.custom((tui: any, theme: Theme, _kb: any, done: (r: void) => void) => {
		let data = getData();
		let focus: Focus = 0;
		const scroll: [number, number, number] = [0, 0, 0]; // 左栏 / 任务 / 日志
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

		return {
			render: (w: number) =>
				renderStatus({
					theme,
					width: w,
					rows: Number(tui.terminal?.rows) || 24,
					now: Date.now(),
					data,
					focus,
					scroll,
					canResume: !!opts?.onResume,
				}),
			invalidate: () => {},
			handleInput: (input: string) => {
				if (matchesKey(input, Key.escape) || matchesKey(input, "q")) return close();
				if (matchesKey(input, Key.ctrl("r"))) {
					// 从 missions 面板进入的 detail 页可直接恢复执行
					if (opts?.onResume && data) {
						const id = data.state.missionId;
						close();
						opts.onResume(id);
					}
					return;
				}
				if (matchesKey(input, Key.tab)) {
					focus = ((focus + 1) % 3) as Focus;
					return tui.requestRender();
				}
				if (matchesKey(input, Key.shift("tab"))) {
					focus = ((focus + 2) % 3) as Focus;
					return tui.requestRender();
				}
				if (matchesKey(input, Key.up)) {
					scroll[focus] = Math.max(0, scroll[focus] - 1);
					return tui.requestRender();
				}
				if (matchesKey(input, Key.down)) {
					scroll[focus] = scroll[focus] + 1;
					return tui.requestRender();
				}
				if (matchesKey(input, "r")) return refresh();
			},
		};
	});
}

/** 非 TUI 环境的降级输出 */
export function statusFallbackText(d: StatusViewData): string {
	return renderStatusDashboard(d.plan, d.state, d.evidence, d.logLines.slice(-5), d.dirName);
}

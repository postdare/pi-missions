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
 * 焦点在任务区时,↑↓ 逐项选择任务,Enter 进入同一组件内的任务详情页。
 * 非 TUI 环境退化为 entry 卡片(renderStatusDashboard)。
 */

import { Key, matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import {
	boxBot,
	boxRow,
	boxSep,
	boxTop,
	clip,
	bodyHeight,
	CURSOR,
	tabs,
	hintBar,
	miniBar,
	pad,
	ruleLabel,
	windowLines,
} from "./chrome.ts";
import type { MissionState } from "../core/types.ts";
import { allTasks, findMilestoneOf, type MissionPlan } from "../store/mission.ts";
import type { TaskEvidenceAttempt } from "../store/evidence.ts";
import type { CheckState } from "../store/check.ts";
import {
	acLines,
	costTotal,
	fmtDuration,
	overviewLines,
	PHASE_STYLE,
	renderStatusDashboard,
	taskBlocks,
	type EvidenceSummary,
	type TaskBlock,
} from "./dashboard.ts";
import { renderTaskDetail } from "./task-detail.ts";

export interface StatusViewData {
	plan: MissionPlan;
	state: MissionState;
	evidence: EvidenceSummary;
	taskEvidence?: Record<string, TaskEvidenceAttempt[]>;
	spikeReports?: Record<string, string>;
	checkState?: CheckState | null;
	logLines: string[];
	dirName: string;
	verifyScriptPath: string;
}

export type StatusMode = "mission" | "task-detail";

type Focus = 0 | 1 | 2; // 0 = 左栏(概览+验收) 1 = 任务 2 = 日志

/** 盒内宽小于这个数就放弃双栏 —— 两条 20 来列的细缝比一栏更难读 */
const NARROW = 72;

interface Theme {
	fg(color: string, text: string): string;
	bg?(color: string, text: string): string;
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
	canAbort?: boolean;
	/** CHECK 进行中且 Verifier 正在运行时,允许按 S 补充核验指令 */
	canSteer?: boolean;
	mode?: StatusMode;
	selectedTask?: number;
	taskDetailScroll?: number;
}

/** 为任务块附加光标与选中背景,并计算每个任务块在展开行中的起止区间 */
function decorateTaskBlocks(
	blocks: TaskBlock[],
	selectedIdx: number,
	isFocused: boolean,
	t: Theme,
	colWidth: number,
): { allLines: string[]; ranges: Array<{ start: number; end: number }> } {
	const allLines: string[] = [];
	const ranges: Array<{ start: number; end: number }> = [];

	for (const [bi, b] of blocks.entries()) {
		const start = allLines.length;
		const isSelected = isFocused && bi === selectedIdx;

		for (const line of b.lines) {
			if (isSelected && line.startsWith("  ") && !line.startsWith("   ")) {
				const decorated = line.replace(/^  /, `${t.fg("accent", CURSOR)} `);
				const painted = t.bg ? t.bg("selectedBg", pad(decorated, colWidth)) : decorated;
				allLines.push(painted);
			} else {
				allLines.push(line);
			}
		}
		ranges.push({ start, end: allLines.length });
	}

	return { allLines, ranges };
}

/** 状态页全部行(含盒外提示条)。纯函数,scroll 就地夹取 */
export function renderStatus(v: StatusView): string[] {
	const t = v.theme;
	const width = Math.max(56, v.width);
	const inner = width - 4;
	const bodyH = bodyHeight(v.rows, 4, 6); // 盒顶 / 头行 / 分隔 / 盒底 / 提示条

	if (!v.data) {
		const out = [boxTop(t, width, "mission")];
		for (let i = 0; i < bodyH; i++) out.push(boxRow(t, width, i === 0 ? t.fg("dim", "无活动 mission") : ""));
		out.push(boxBot(t, width), hintBar(t, width, [["Esc", "关闭"]]));
		return out;
	}

	const d = v.data;
	const tasks = allTasks(d.plan);
	const taskCount = tasks.length;
	const taskDone = Object.values(d.state.tasks).filter((x) => x.status === "done").length;
	const selectedTaskIdx = Math.max(0, Math.min(v.selectedTask ?? 0, Math.max(0, taskCount - 1)));
	const mode = v.mode ?? "mission";

	// ── 任务详情页 ──
	if (mode === "task-detail" && taskCount > 0) {
		const currentTask = tasks[selectedTaskIdx];
		const ms = findMilestoneOf(d.plan, currentTask.id);
		const taskState = d.state.tasks[currentTask.id];
		const attempts = d.taskEvidence?.[currentTask.id] ?? [];
		const spikeReport = d.spikeReports?.[currentTask.id];
		const detailLines = renderTaskDetail(
			{
				task: currentTask,
				taskState,
				milestone: ms,
				criteria: d.plan.acceptanceCriteria,
				attempts,
				spikeReport,
				tier: d.state.tier,
				checkState: d.checkState?.taskId === currentTask.id ? d.checkState : null,
				now: v.now,
			},
			t,
			inner,
		);

		const detailOff = Math.max(0, Math.min(v.taskDetailScroll ?? 0, Math.max(0, detailLines.length - bodyH)));
		if (v.taskDetailScroll !== undefined) v.taskDetailScroll = detailOff;

		const out: string[] = [
			boxTop(
				t,
				width,
				`${clip(d.state.missionId, 24)} · 详情 ${currentTask.id}`,
				`任务 ${selectedTaskIdx + 1}/${taskCount}`,
			),
			boxRow(t, width, headerLine(d, t, inner)),
			boxSep(t, width),
		];

		const visibleDetail = detailLines.slice(detailOff, detailOff + bodyH);
		for (let i = 0; i < bodyH; i++) {
			out.push(boxRow(t, width, clip(visibleDetail[i] ?? "", inner)));
		}

		out.push(boxBot(t, width));
		const detailHints: Array<[string, string]> = [
			["↑↓", "滚动"],
			["Esc", "返回任务列表"],
			["R", "刷新"],
			["Q", "关闭"],
		];
		const pos =
			detailLines.length > bodyH
				? `行 ${detailOff + 1}-${Math.min(detailOff + bodyH, detailLines.length)}/${detailLines.length}`
				: undefined;
		out.push(hintBar(t, width, detailHints, pos));
		return out;
	}

	// ── Mission 状态总览页 ──
	const hints: Array<[string, string]> = [
		["Tab", "切面板"],
		...(v.focus === 1 && taskCount > 0
			? ([["↑↓", "选择任务"], ["Enter", "任务详情"]] as Array<[string, string]>)
			: ([["↑↓", "滚动"]] as Array<[string, string]>)),
		...(v.canResume ? ([["Ctrl+R", "恢复"]] as Array<[string, string]>) : []),
		...(v.canAbort ? ([["Ctrl+A", "中止"]] as Array<[string, string]>) : []),
		...(v.canSteer ? ([["S", "补充指令"]] as Array<[string, string]>) : []),
		["R", "刷新"],
		["Esc", "关闭"],
	];

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
	const overview = overviewLines(d.plan, d.state, {
		now: v.now,
		theme: t,
		width: leftW,
		omitIdentity: true,
		checkState: d.checkState,
	});
	const ac = acLines(d.plan, d.evidence, d.dirName, t, leftW, d.verifyScriptPath);
	const logAll = d.logLines.length > 0 ? d.logLines.map((l) => t.fg("dim", l)) : [t.fg("dim", "(暂无日志)")];

	const clamp = (i: Focus, len: number, winH: number) => {
		v.scroll[i] = Math.max(0, Math.min(v.scroll[i], Math.max(0, len - winH)));
		return v.scroll[i];
	};

	const scrolled = (off: number, win: number, len: number) =>
		len > win ? ` · 行 ${off + 1}-${Math.min(off + win, len)}/${len}` : "";

	// ── 窄屏:双栏会挤成两条细缝,退化成单栏 —— 只渲染焦点段,Tab 切换 ──
	if (narrow) {
		const rawBlocks = taskBlocks(d.plan, d.state, t, inner);
		const { allLines: allTaskLines, ranges } = decorateTaskBlocks(
			rawBlocks,
			selectedTaskIdx,
			v.focus === 1,
			t,
			inner,
		);
		const finalTaskLines = allTaskLines.length > 0 ? allTaskLines : [t.fg("dim", "(计划尚未冻结,无任务列表)")];

		const winH = bodyH - 1;
		let off = 0;
		if (v.focus === 1 && rawBlocks.length > 0) {
			const anchor = ranges[selectedTaskIdx] ?? null;
			const win = windowLines(finalTaskLines, v.scroll[1], winH, anchor);
			v.scroll[1] = win.offset;
			off = win.offset;
		} else {
			off = clamp(v.focus, v.focus === 0 ? overview.length + ac.length + 2 : logAll.length, winH);
		}

		const secs: Array<{ label: string; lines: string[] }> = [
			{ label: "概览/验收", lines: [...overview, "", ruleLabel(t, inner, "验收"), ...ac] },
			{ label: `任务 ${taskDone}/${taskCount}`, lines: finalTaskLines },
			{ label: `日志 ${d.logLines.length} 行`, lines: logAll },
		];

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
	const rawBlocks = taskBlocks(d.plan, d.state, t, rightW);
	const { allLines: allTaskLines, ranges } = decorateTaskBlocks(
		rawBlocks,
		selectedTaskIdx,
		v.focus === 1,
		t,
		rightW,
	);
	const finalTaskLines = allTaskLines.length > 0 ? allTaskLines : [t.fg("dim", "(计划尚未冻结,无任务列表)")];

	const taskSecH = Math.min(finalTaskLines.length + 1, Math.max(3, Math.floor(bodyH / 2)));
	const taskWinH = taskSecH - 1;
	const logWinH = Math.max(1, bodyH - taskSecH - 1);

	const anchor = rawBlocks.length > 0 ? (ranges[selectedTaskIdx] ?? null) : null;
	const win = windowLines(finalTaskLines, v.scroll[1], taskWinH, anchor);
	v.scroll[1] = win.offset;
	const taskOff = win.offset;
	const logOff = clamp(2, logAll.length, logWinH);

	const rightLines: string[] = [
		ruleLabel(
			t,
			rightW,
			`任务 ${taskDone}/${taskCount}${scrolled(taskOff, taskWinH, finalTaskLines.length)}`,
			v.focus === 1,
		),
	];
	for (const l of win.lines) rightLines.push(clip(l, rightW));
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

export interface StatusViewOpts {
	onResume?: (missionId: string) => void;
	onAbort?: (missionId: string) => void;
	/** CHECK 进行中按 S 补充核验指令;由 Runtime 审计进 CHECK.json/LOG.md。 */
	onSteer?: (missionId: string, text: string) => void;
	/** Ctrl+R 只对真正可恢复的 mission 显示/生效(被 halt、中断或未附着的) */
	canResume?: (d: StatusViewData) => boolean;
	/** Ctrl+A 只对附着在本 Runtime 上、仍在运行的 mission 显示/生效 */
	canAbort?: (d: StatusViewData) => boolean;
	/** 自动刷新时只读轻量 CHECK.json,避免每 2 秒重扫全部历史证据。 */
	getCheckState?: () => CheckState | null;
}

export async function openStatusView(
	ctx: any,
	getData: () => StatusViewData | null,
	opts?: StatusViewOpts,
): Promise<void> {
	// 非 TUI:退化为一次性卡片
	if (!ctx.hasUI) return;

	await ctx.ui.custom((tui: any, theme: Theme, _kb: any, done: (r: void) => void) => {
		let data = getData();
		let focus: Focus = 0;
		let mode: StatusMode = "mission";
		let selectedTask = 0;
		let taskDetailScroll = 0;
		const scroll: [number, number, number] = [0, 0, 0]; // 左栏 / 任务 / 日志
		let closed = false;

		const refresh = () => {
			try {
				data = getData() ?? data;
			} catch {
				/* keep last good */
			}
			if (data) {
				const taskCount = allTasks(data.plan).length;
				if (taskCount > 0) {
					selectedTask = Math.max(0, Math.min(selectedTask, taskCount - 1));
				} else {
					selectedTask = 0;
					if (mode === "task-detail") mode = "mission";
				}
			}
			if (!closed) tui.requestRender();
		};
		const pollCheck = () => {
			if (closed || data?.state.phase !== "check") return;
			const previous = data.checkState;
			if (previous && (previous.stage === "completed" || previous.stage === "error")) {
				refresh();
				return;
			}
			if (!opts?.getCheckState) {
				refresh();
				return;
			}
			let next: CheckState | null;
			try {
				next = opts.getCheckState();
			} catch {
				return;
			}
			if (!next) return;
			if (next.updatedAt === previous?.updatedAt) {
				// CHECK 内容没变化时仍刷新计时文本,不重读完整日志/证据。
				tui.requestRender();
				return;
			}
			data = { ...data, checkState: next };
			if (next.stage === "completed" || next.stage === "error") {
				refresh();
			} else {
				tui.requestRender();
			}
		};
		const timer = setInterval(pollCheck, 2_000);

		const close = () => {
			if (closed) return;
			closed = true;
			clearInterval(timer);
			done(undefined);
		};

		// 恢复/中止/补充指令的可行性随 data 变化,渲染与按键共用同一份判定
		const resumeAllowed = () =>
			!!opts?.onResume && !!data && (opts.canResume ? opts.canResume(data) : data.state.phase !== "done");
		const abortAllowed = () =>
			!!opts?.onAbort &&
			!!data &&
			(opts.canAbort ? opts.canAbort(data) : data.state.phase !== "done" && data.state.phase !== "halted");
		const steerAllowed = () =>
			!!opts?.onSteer && data?.state.phase === "check" && data?.checkState?.verifier?.status === "running";

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
					canResume: resumeAllowed(),
					canAbort: abortAllowed(),
					canSteer: steerAllowed(),
					mode,
					selectedTask,
					taskDetailScroll,
				}),
			invalidate: () => {},
			handleInput: (input: string) => {
				const taskCount = data ? allTasks(data.plan).length : 0;
				if (taskCount > 0) {
					selectedTask = Math.max(0, Math.min(selectedTask, taskCount - 1));
				} else {
					selectedTask = 0;
					if (mode === "task-detail") mode = "mission";
				}

				// ── 任务详情模式 ──
				if (mode === "task-detail") {
					if (matchesKey(input, Key.escape) || matchesKey(input, Key.backspace)) {
						mode = "mission";
						taskDetailScroll = 0;
						return tui.requestRender();
					}
					if (matchesKey(input, "q")) return close();
					if (matchesKey(input, Key.up)) {
						taskDetailScroll = Math.max(0, taskDetailScroll - 1);
						return tui.requestRender();
					}
					if (matchesKey(input, Key.down)) {
						taskDetailScroll = taskDetailScroll + 1;
						return tui.requestRender();
					}
					if (matchesKey(input, "r")) return refresh();
					return;
				}

				// ── Mission 状态总览模式 ──
				if (matchesKey(input, Key.escape) || matchesKey(input, "q")) return close();
				if (matchesKey(input, Key.ctrl("r"))) {
					// 从 missions 面板进入的 detail 页可直接恢复执行
					if (resumeAllowed() && data) {
						const id = data.state.missionId;
						close();
						opts!.onResume!(id);
					}
					return;
				}
				if (matchesKey(input, Key.ctrl("a"))) {
					if (abortAllowed() && data) {
						const id = data.state.missionId;
						close();
						opts!.onAbort!(id);
					}
					return;
				}
				if (matchesKey(input, "s") && steerAllowed()) {
					// 补充核验指令:只影响当前这次 CHECK 的抽查重点,冻结的 AC 不受影响
					const id = data!.state.missionId;
					void (async () => {
						const text = await ctx.ui.input(
							"补充核验指令",
							"只补充本次核验的抽查重点;验收标准已冻结,改不了",
						);
						if (text?.trim() && steerAllowed()) opts!.onSteer!(id, text.trim());
					})();
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
					if (focus === 1 && taskCount > 0) {
						selectedTask = Math.max(0, selectedTask - 1);
					} else {
						scroll[focus] = Math.max(0, scroll[focus] - 1);
					}
					return tui.requestRender();
				}
				if (matchesKey(input, Key.down)) {
					if (focus === 1 && taskCount > 0) {
						selectedTask = Math.min(taskCount - 1, selectedTask + 1);
					} else {
						scroll[focus] = scroll[focus] + 1;
					}
					return tui.requestRender();
				}
				if (matchesKey(input, Key.enter)) {
					if (focus === 1 && taskCount > 0) {
						mode = "task-detail";
						taskDetailScroll = 0;
						return tui.requestRender();
					}
					return;
				}
				if (matchesKey(input, "r")) return refresh();
			},
		};
	});
}

/** 非 TUI 环境的降级输出 */
export function statusFallbackText(d: StatusViewData): string {
	return renderStatusDashboard(
		d.plan,
		d.state,
		d.evidence,
		d.logLines.slice(-5),
		d.dirName,
		Date.now(),
		d.checkState,
		d.verifyScriptPath,
	);
}

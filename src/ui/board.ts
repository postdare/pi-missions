/**
 * pi-missions · ui/board —— 子 agent 执行看板(输入框下方那块)
 *
 * # 它解决什么
 *
 * 独立核验一跑就是三四分钟、二三十次工具调用,而在此之前人在界面上只看得到
 * 一行状态词。真机原话:「我现在完全看不到独立核验的进展」。轨迹数据一直都在
 * (`CheckState.verifier.trace`),只是没有出口。
 *
 * # 两条硬约束,决定了它长这样
 *
 * 1. **widget 有 10 行硬上限**(pi 的 `MAX_WIDGET_LINES`,超出会被截断成
 *    "... (widget truncated)")。所以看板必须自己分页,不能靠内容自然长度。
 * 2. **widget 收不了按键**(`setWidget` 的组件从不进 pi-tui 的 focus 链)。
 *    按键要靠 `ctx.ui.onTerminalInput` 在外面截,而那是另一个文件的事 ——
 *    这里只是纯函数:接一个描述"当前该显示什么"的对象,返回行数组。
 *
 * 所以这个模块不知道按键、不持有状态。展开与否、选中第几行,都由调用方传进来。
 */

import type { CheckState } from "../store/check.ts";
import type { ScoutFanoutProgress } from "../core/scout.ts";
import { clip, CURSOR, windowLines } from "./chrome.ts";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { LineTheme } from "./dashboard.ts";
import { fmtCheckDuration, shortenActivity } from "./dashboard.ts";

/**
 * 按宽度装配一行:主体必留,尾巴(提示语)放得下才加。
 *
 * 直接拼完交给 clip 是不行的 —— 那样窄终端上被咬掉的恰好是排在最后的提示,
 * 而人看到半截 "↑↓ 选 ·…" 只会以为界面坏了。宁可不显示,也不显示一半。
 */
function fit(t: LineTheme, body: string, tails: string[], width: number): string {
	const lead = "  ";
	const gap = "   ";
	const base = visibleWidth(lead) + visibleWidth(body) + visibleWidth(gap);
	// tails 按从宽到窄排,取第一个放得下的。全都放不下就只留主体。
	for (const tail of tails) {
		if (base + visibleWidth(tail) <= width) return `${lead}${body}${gap}${t.fg("dim", tail)}`;
	}
	return clip(`${lead}${body}`, width);
}

/**
 * 按优先级从右往左丢,直到放得下。
 *
 * parts 从最重要排到最次要 —— 第一个永远保留(放不下也由 clip 兜)。
 * 这条规矩来自 CLAUDE.md:允许截断的账目行必须把最重要的排在最左边。
 */
function byPriority(t: LineTheme, parts: string[], width: number): string {
	for (let keep = parts.length; keep > 1; keep--) {
		const line = parts.slice(0, keep).join(t.fg("dim", " · "));
		if (visibleWidth(line) + 2 <= width) return line;
	}
	return parts[0] ?? "";
}

/** 看板正文最多占几行(不含标题行)。widget 总上限 10 行,标题 + 提示各占一行 */
export const BOARD_BODY_LINES = 7;

export interface BoardView {
	/** 展开与否。收起时只出一行 */
	expanded: boolean;
	/** 展开时选中第几条轨迹(0 基)。-1 表示跟随最新一条 */
	selected: number;
	/** 滚动偏移,由调用方持有并写回 */
	scroll: number;
	check?: CheckState | null;
	scout?: { startedAt: number; progress: ScoutFanoutProgress } | null;
	now: number;
	width: number;
}

/** 当前有没有子 agent 在跑 —— 没有就整块不出现,别占那一行 */
export function boardActive(v: Pick<BoardView, "check" | "scout">): boolean {
	if (v.scout && v.scout.progress.total > 0) return true;
	const s = v.check?.verifier?.status;
	return s === "running";
}

/**
 * 取当前要展示的轨迹。verifier 与 scout 同时只会有一个在跑
 * (scout 在 PLAN、verifier 在 CHECK),所以不必考虑合并。
 */
export function boardTrace(v: Pick<BoardView, "check" | "scout">): string[] {
	if (v.scout && v.scout.progress.total > 0) {
		const p = v.scout.progress;
		// scout 没有逐路 trace(它不落盘),能给的是每一路此刻在干什么
		return Object.entries(p.activity).map(([id, act]) => `${id} ${act}`);
	}
	return v.check?.verifier?.trace ?? [];
}

/** 这块看板此刻在讲谁 */
function boardTitle(v: Pick<BoardView, "check" | "scout">): string {
	return v.scout && v.scout.progress.total > 0 ? "侦查扇出" : "独立核验";
}

/** 跑了多久。scout 从扇出起算,verifier 优先用已结算的 durationMs */
function boardElapsed(v: BoardView): string {
	if (v.scout && v.scout.progress.total > 0) {
		return `${v.scout.progress.done}/${v.scout.progress.total} · ${fmtCheckDuration(v.now - v.scout.startedAt)}`;
	}
	const ver = v.check?.verifier;
	const ms = ver?.durationMs ?? (ver?.startedAt == null ? null : v.now - ver.startedAt);
	const task = v.check ? `${v.check.taskId} a=${v.check.attempt}` : "";
	return [task, ms == null ? "" : fmtCheckDuration(ms)].filter(Boolean).join(" · ");
}

function headline(v: BoardView, t: LineTheme): string {
	if (v.scout && v.scout.progress.total > 0) {
		const p = v.scout.progress;
		const el = fmtCheckDuration(v.now - v.scout.startedAt);
		return `${t.fg("accent", "侦查扇出")} ${t.fg("dim", `${p.done}/${p.total} · ${el}`)}`;
	}
	const ver = v.check?.verifier;
	const task = v.check ? `${v.check.taskId} a=${v.check.attempt}` : "";
	const ms = ver?.durationMs ?? (ver?.startedAt == null ? null : v.now - ver.startedAt);
	const bits = [task, ms == null ? "" : fmtCheckDuration(ms)].filter(Boolean);
	if (ver?.turns) bits.push(`${ver.turns} 轮`);
	if (ver?.toolCalls) bits.push(`${ver.toolCalls} 次调用`);
	return `${t.fg("accent", "独立核验")} ${t.fg("dim", bits.join(" · "))}`;
}

/**
 * 渲染看板。没有子 agent 在跑时返回空数组 —— 调用方据此把 widget 摘掉。
 *
 * 收起态只有一行,因为它是**常驻**的:输入框下面永久多出的每一行都是永久成本。
 */
export function renderBoard(v: BoardView, t: LineTheme): string[] {
	if (!boardActive(v)) return [];
	const trace = boardTrace(v);
	const head = headline(v, t);

	if (!v.expanded) {
		// 收起态把"最新一条动作"也带上:多数时候人只想知道它还活着、在动什么,
		// 那这一行就够了,不必展开。
		// 窄终端上先牺牲"当前动作"再牺牲提示 —— 排在最左边的「在跑什么·多久了」
		// 是这一行存在的理由,后面两截是加分项。
		// 优先级:是什么 > 跑了多久 > **在干什么** > 轮数/调用数。
		// 「在干什么」排在轮数前面 —— 它才是这一行存在的理由(判断它还活着),
		// 轮数与调用数在展开态和常驻卡上都看得到。
		const last = trace.length > 0 ? shortenActivity(trace[trace.length - 1]) : "";
		const ver = v.check?.verifier;
		const parts = [
			t.fg("accent", boardTitle(v)),
			t.fg("dim", boardElapsed(v)),
			...(last ? [t.fg("dim", last)] : []),
			...(ver?.turns ? [t.fg("dim", `${ver.turns} 轮 ${ver.toolCalls ?? 0} 调用`)] : []),
		].filter(Boolean);
		// 提示语放不下就不放,但绝不放半截 —— 人得知道有 ↓ 这条路,
		// 而看到 "↑↓ 选 ·…" 只会以为界面坏了。
		return [fit(t, byPriority(t, parts, v.width - 10), ["↓ 展开", "↓"], v.width)];
	}

	const rows = trace.map((line, i) => {
		const cur = i === (v.selected < 0 ? trace.length - 1 : v.selected);
		const mark = cur ? t.fg("accent", CURSOR) : " ";
		// 选中行**不上色**,留默认前景 —— 对比来自"其余都是 dim"。
		// 这里一度写成 t.fg("fg", …),而 "fg" 不是合法颜色名:pi 的 theme.fg
		// 遇到未知名字直接抛,而渲染在 TUI 主循环里,那是整个进程崩掉,不是掉色。
		const text = shortenActivity(line);
		return clip(`  ${mark} ${cur ? text : t.fg("dim", text)}`, v.width);
	});
	// 选中行必须留在窗口里 —— 否则按了半天上下键,屏幕上什么都没变
	const sel = v.selected < 0 ? Math.max(0, trace.length - 1) : v.selected;
	const win = windowLines(rows, v.scroll, BOARD_BODY_LINES, { start: sel, end: sel + 1 });

	const pos = trace.length > BOARD_BODY_LINES ? `${win.start + 1}-${win.end}/${trace.length}` : `${trace.length} 条`;
	return [
		fit(t, head, ["↑↓ 选 · ↵ 详情 · esc 收起", "↑↓ · ↵ · esc"], v.width),
		...win.lines,
		clip(`  ${t.fg("dim", pos)}`, v.width),
	];
}

/** 展开态下按键之后的新滚动位置。分出来是为了让按键壳不必知道窗口算法 */
export function boardScrollFor(traceLen: number, selected: number, scroll: number): number {
	const rows = Array.from({ length: traceLen }, (_, i) => String(i));
	const sel = selected < 0 ? Math.max(0, traceLen - 1) : selected;
	return windowLines(rows, scroll, BOARD_BODY_LINES, { start: sel, end: sel + 1 }).offset;
}

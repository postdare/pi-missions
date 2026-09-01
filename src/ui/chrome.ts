/**
 * pi-missions · ui/chrome
 *
 * 编排器风格的"圆角盒内联页"框架(组件替换编辑器区域,非 overlay):
 *   ╭─ MISSIONS ──────────────────────────────── 5 个 mission ─╮
 *   │  任务  模型                                              │ ← 活动页签是背景色药丸
 *   │ ▸ ● 执行  3min  ███░░ 3/8  CMS 重构                      │ ← 选中行整行铺 selectedBg
 *   ╰──────────────────────────────────────────────────────────╯
 *    ↑↓ 导航   Enter 选择                              1-4 of 5   ← 盒外提示条
 *
 * 视觉约定(改这里之前先读一遍,乱用会让整个面板花掉):
 *   - 外框 border,盒内分隔线 borderMuted —— 内部结构必须比外框更弱
 *   - 选中态 = selectedBg 铺满整行;行光标是 ▸,页签用背景色药丸。
 *     **不要在贴着边框的位置放竖线**(▎│┃):它会被读成边框的一部分
 *   - 强调只有一种:accent。success/warning/error 只表达语义状态,不做装饰
 *   - 字形一律取窄宽(块元素/箭头),不引入新的 ambiguous-width 符号
 *
 * 调用点:panel.ts(/missions)、status-view.ts(/mission status)。
 * 全部纯函数,可单测(见 test/chrome.test.ts)。
 */

import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

export interface ChromeTheme {
	fg(color: string, text: string): string;
	/** 背景色。pi 的 bg 只重置背景(\x1b[49m),可以安全包住带前景色的内容 */
	bg?(color: string, text: string): string;
	bold(text: string): string;
}

/** 外框色 */
const FRAME = "border";
/** 盒内分隔线色 —— 刻意比外框弱一档 */
const RULE = "borderMuted";

/**
 * 行光标。刻意用三角而不是竖条:竖条紧挨着盒子左边框时会被读成"边框裂了一道",
 * 三角一眼就是指针。选中态的主要视觉是整行背景,这个符号只是补充。
 */
export const CURSOR = "▸";

/**
 * 截断到可见宽度(ANSI 安全)。truncateToWidth 认识转义序列,
 * 不会像手搓 slice 那样把颜色码拦腰截断。
 */
export function clip(line: string, width: number): string {
	return truncateToWidth(line, Math.max(1, width), "…");
}

/** 按可见宽度右补空格(CJK 宽 2,padEnd 按码位算会对不齐) */
export function pad(s: string, width: number): string {
	return s + " ".repeat(Math.max(0, width - visibleWidth(s)));
}

// ─────────────────────────── 圆角盒 ───────────────────────────

function frame(t: ChromeTheme, s: string): string {
	return t.fg(FRAME, s);
}

/**
 * 盒顶边:╭─ TITLE ─────────── meta ─╮
 * title 加粗嵌在左侧,meta(可选)dim 靠右 —— 计数/位置这类次要信息放这里,
 * 省掉一整行。空间不够时 meta 先被丢弃,title 再截断。
 */
export function boxTop(t: ChromeTheme, width: number, title?: string, meta?: string): string {
	const w = Math.max(4, width);
	if (!title) return frame(t, "╭" + "─".repeat(w - 2) + "╮");
	const label = clip(` ${title} `, w - 4);
	const used = visibleWidth(label);
	const tail = meta ? ` ${meta} ` : "";
	const tailW = visibleWidth(tail);
	// ╭─(2) + label + ─…(fillW) + tail + ─╮(2) 恰好 = w;放不下 meta 就退回无 meta
	const fillW = w - 4 - used - tailW;
	if (tail && fillW >= 2) {
		return (
			frame(t, "╭─") +
			t.bold(label) +
			frame(t, "─".repeat(fillW)) +
			t.fg("dim", tail) +
			frame(t, "─╮")
		);
	}
	return frame(t, "╭─") + t.bold(label) + frame(t, "─".repeat(Math.max(0, w - 3 - used)) + "╮");
}

/**
 * 盒内容行:│ <内容> │,总宽恰好 = width。
 * highlight 时整个内宽(含两侧留白)铺 selectedBg —— 这是选中态的主要视觉,
 * 比 ">" 前缀显眼得多,且不占内容列。主题没给 bg 时自动退化为纯内容。
 */
export function boxRow(t: ChromeTheme, width: number, content = "", opts?: { highlight?: boolean }): string {
	const w = Math.max(4, width);
	const inner = w - 4;
	// 放得下就别走 clip:truncateToWidth 会再逐簇量一遍宽,而这行每帧跑 ~25 次
	const c = visibleWidth(content) <= inner ? content : clip(content, inner);
	const body = " " + pad(c, inner) + " ";
	const painted = opts?.highlight && t.bg ? t.bg("selectedBg", body) : body;
	return frame(t, "│") + painted + frame(t, "│");
}

/** 盒内分隔线:├──────────┤(内部结构用 borderMuted,比外框弱) */
export function boxSep(t: ChromeTheme, width: number): string {
	const w = Math.max(4, width);
	return frame(t, "├") + t.fg(RULE, "─".repeat(w - 2)) + frame(t, "┤");
}

/** 盒底边 */
export function boxBot(t: ChromeTheme, width: number): string {
	const w = Math.max(4, width);
	return frame(t, "╰" + "─".repeat(w - 2) + "╯");
}

// ─────────────────────────── 盒内元素 ───────────────────────────

/**
 * 带标签的弱分隔线(盒内分组):`标签 ─────────────`。
 * 用于把一栏里的多个段落切开,比空行更能说明"这是另一段"。
 */
export function ruleLabel(t: ChromeTheme, width: number, label: string, active = false): string {
	const text = active ? t.fg("accent", t.bold(label)) : t.fg("muted", label);
	const fill = Math.max(0, width - visibleWidth(label) - 1);
	return `${text} ${t.fg(RULE, "─".repeat(fill))}`;
}

/**
 * 进度条。已完成用实心块,未完成用细横线做轨道 ——
 * 不用 ░:它在很多等宽字体里渲染成一整块实心灰板,0 进度时就是一坨脏东西。
 * panel / status-view / widget 三处共用,避免各画各的。
 */
export function miniBar(t: ChromeTheme, done: number, total: number, width: number): string {
	const w = Math.max(1, width);
	if (total <= 0) return t.fg(RULE, "─".repeat(w));
	const filled = Math.max(0, Math.min(w, Math.round((done / total) * w)));
	const color = done >= total ? "success" : "accent";
	return t.fg(color, "█".repeat(filled)) + t.fg(RULE, "─".repeat(w - filled));
}

/**
 * 按可见宽度折行。拉丁文优先在空格处断,中文没有空格就硬断:目标/失败原因这类
 * 长句截断等于把最重要的信息丢掉,折行才是对的。断行规则(含 CJK 与字素簇)由
 * pi-tui 统一维护,这里只补一个 maxLines 夹取。
 */
export function wrap(text: string, width: number, maxLines = 0): string[] {
	const w = Math.max(8, width);
	const out = wrapTextWithAnsi(text, w);
	if (maxLines > 0 && out.length > maxLines) {
		const kept = out.slice(0, maxLines);
		kept[maxLines - 1] = clip(kept[maxLines - 1], w - 1) + "…";
		return kept;
	}
	return out.length > 0 ? out : [""];
}

/**
 * 页签:活动项是一颗背景色药丸(前后各留一格),非活动项同样留格但只是 dim 文字。
 * 两种状态占同样的列宽,切页时标签不会左右跳;主题没给 bg 时退化成 accent 加粗。
 */
export function tabs(t: ChromeTheme, items: Array<{ id: string; label: string }>, activeId: string): string {
	return items
		.map((it) => {
			const body = ` ${it.label} `;
			if (it.id !== activeId) return t.fg("dim", body);
			return t.bg ? t.bg("selectedBg", t.bold(t.fg("accent", body))) : t.fg("accent", t.bold(body));
		})
		.join(" ");
}

// ─────────────────────────── 盒外提示条 ───────────────────────────

/**
 * 键位提示条(盒外独立一行):键名 accent + dim 描述,
 * right(如 "1-4 of 5")右对齐。超宽时整体截断。
 */
export function hintBar(
	t: ChromeTheme,
	width: number,
	hints: Array<[key: string, desc: string]>,
	right?: string,
): string {
	const left = " " + hints.map(([k, d]) => `${t.fg("accent", k)} ${t.fg("dim", d)}`).join("   ");
	if (!right) return clip(left, width);
	const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
	return clip(left + " ".repeat(gap) + t.fg("dim", right), width);
}

// ─────────────────────────── 高度与窗口 ───────────────────────────

/**
 * 内联页的内容高度上限:组件占了编辑器区域,渲染太高会把聊天区挤没。
 * 预留 ~6 行给聊天/footer,夹在 [10, 30] 之间。
 */
export function contentBudget(terminalRows: number): number {
	return Math.max(10, Math.min(30, terminalRows - 6));
}

export interface WindowResult {
	lines: string[];
	/** 实际使用的起始偏移(可能因选中项可见性被调整) */
	offset: number;
	/** 窗口实际覆盖的行区间 [start, end) */
	start: number;
	end: number;
}

/**
 * 窗口化一个行数组:保证 [anchorStart, anchorEnd) 这一段完整可见。
 * offset 为调用方持有的滚动状态;返回值里的 offset 应写回。
 * 超出窗口的行直接裁掉 —— 位置指示交给盒外的 hintBar("1-4 of 5")。
 */
export function windowLines(
	all: string[],
	offset: number,
	height: number,
	anchor: { start: number; end: number } | null,
): WindowResult {
	if (all.length <= height) return { lines: all, offset: 0, start: 0, end: all.length };
	let off = Math.max(0, Math.min(offset, all.length - height));
	if (anchor) {
		if (anchor.start < off) off = anchor.start;
		if (anchor.end > off + height) off = Math.max(0, anchor.end - height);
	}
	return { lines: all.slice(off, off + height), offset: off, start: off, end: Math.min(all.length, off + height) };
}

/**
 * pi-missions · ui/define-review
 *
 * mission_define 的自绘范围确认页(ctx.ui.custom 圆角盒内联页)。
 *
 * 它替换的是 pi 原生的 ctx.ui.confirm Yes/No 弹窗:原生弹窗只塞得下一面纯文本,
 * resolved 问答记录、验证接缝一个字都看不到 —— 等于让人确认一份没读过的范围。
 * 这一页把整份定义摊开(目标 / 完成条件 / 明确不做 / 约束 / 验证接缝 / 问答记录),
 * Enter 确认,E 进意见输入(拒绝时给理由),Esc 直接拒绝。
 *
 * 拒绝意见不在这里收:ui.custom 里再嵌一层 ui.editor 会把 TUI 叠坏(见 plan-review
 * 头注释)。这一页只区分确认与拒绝,意见由调用方(runtime.define)在关页之后用
 * ui.editor 收 —— 与 plan-review 的打回意见同形。
 *
 * 渲染是纯函数 renderDefineReview(),与输入处理分离 —— 可单测,也能离线预览。
 *
 * 何时弹由 core/define.ts 的 needsScopeConfirm() 判定(complex 恒确认、
 * standard 问过才确认、quick 不确认),判定不在这里 —— 这里只负责把确认做对。
 */

import { Input, Key, matchesKey } from "@earendil-works/pi-tui";
import type { Definition } from "../store/mission.ts";
import {
	boxBot,
	boxRow,
	boxSep,
	boxTop,
	clip,
	contentBudget,
	hintBar,
	ruleLabel,
	windowLines,
	wrap,
} from "./chrome.ts";
import type { LineTheme } from "./dashboard.ts";

export interface DefineReviewView {
	theme: LineTheme & { bg?(color: string, s: string): string };
	width: number;
	rows: number;
	goal: string;
	definition: Definition;
	/** 当前聚焦的段落下标(用于滚动锚定;↑↓ 在段落间移动) */
	focus: number;
	/** 是否在写拒绝意见 */
	editing: boolean;
	/** 拒绝意见草稿 */
	draft: string;
	scroll: number;
}

export interface DefineReviewRender {
	lines: string[];
	scroll: number;
}

const SECTION_TITLES = ["目标", "完成条件", "明确不做", "已确认的约束", "验证接缝", "DEFINE 问答"] as const;

/** 一段内容行。段落为空时返回 dim 占位,但段落本身保留(盒高稳定,人知道"没有"≠"忘了展示") */
function sectionBody(goal: string, d: Definition, idx: number, t: LineTheme, inner: number): string[] {
	switch (idx) {
		case 0:
			return wrap(goal || "(空)", Math.max(12, inner)).map((l) => t.fg("text", l));
		case 1:
			return d.doneWhen.length === 0
				? [t.fg("dim", "(无完成条件 —— 这不该发生,doneWhen 为空的 define 会被拒)")]
				: d.doneWhen.flatMap((dw) => {
						const head = `  ${t.fg("accent", dw.id)} `;
						const indent = " ".repeat(head.length);
						return wrap(dw.text, Math.max(12, inner - head.length)).map((l, i) => (i === 0 ? head + l : indent + l));
					});
		case 2:
			return d.nonGoals.length === 0
				? [t.fg("dim", "(未声明)")]
				: d.nonGoals.flatMap((n) => wrap(`  ✕ ${n}`, Math.max(12, inner)));
		case 3:
			return d.constraints.length === 0
				? [t.fg("dim", "(未声明)")]
				: d.constraints.flatMap((c) => wrap(`  · ${c}`, Math.max(12, inner)));
		case 4:
			return [d.verifySeam ? t.fg("text", `  ${d.verifySeam}`) : t.fg("dim", "(未声明 —— PLAN 会自己定验证接缝)")];
		case 5:
			return d.resolved.length === 0
				? [t.fg("dim", "(没有调用过 mission_ask)")]
				: d.resolved.flatMap((r) => {
						const qs = wrap(`  问 ${r.q}`, Math.max(12, inner));
						const as = wrap(`  答 ${r.a}`, Math.max(12, inner));
						return [...qs, ...as.map((l) => t.fg("muted", l)), ""].slice(0, -1);
					});
		default:
			return [];
	}
}

export function renderDefineReview(view: DefineReviewView): DefineReviewRender {
	const width = Math.max(40, view.width);
	const inner = width - 4;
	const t = view.theme;

	const lines: string[] = [
		boxTop(t as never, width, `DEFINE 范围确认 · ${view.definition.doneWhen.length} 条完成条件`, "冻结后只读"),
		boxSep(t as never, width),
	];

	// 每段的 [起始行, 结束行) —— 供滚动窗口锚定当前段落
	const sectionRanges: Array<{ start: number; end: number }> = [];
	const body: string[] = [];
	for (let i = 0; i < SECTION_TITLES.length; i++) {
		if (i > 0) body.push("");
		body.push(ruleLabel(t as never, inner, SECTION_TITLES[i]));
		const start = body.length;
		body.push(...sectionBody(view.goal, view.definition, i, t, inner));
		sectionRanges.push({ start, end: body.length });
	}
	const bodyStart = lines.length;

	const height = Math.max(6, contentBudget(view.rows) - (lines.length - 1));
	const range = sectionRanges[Math.min(view.focus, sectionRanges.length - 1)];
	const win = windowLines(body, view.scroll, height, { start: bodyStart + range.start, end: bodyStart + range.end });
	for (const l of win.lines) lines.push(boxRow(t as never, width, clip(l, inner)));
	for (let i = win.lines.length; i < height; i++) lines.push(boxRow(t as never, width));

	lines.push(boxBot(t as never, width));

	// 编辑态:盒底接一行意见输入(pi-tui Input,不嵌 ui.editor)
	if (view.editing) {
		lines.push(...wrap(`拒绝意见(planner 会读到,写进 LOG):${view.draft}`, width).map((l) => t.fg("warning", l)));
	}

	const hints: Array<[string, string]> = view.editing
		? [
				["Enter", "拒绝并回传意见"],
				["Esc", "放弃意见"],
			]
		: [
				["Enter", "确认范围,进 PLAN"],
				["E", "拒绝并写意见"],
				["↑↓", "翻段"],
				["Esc", "拒绝"],
			];
	const pos = body.length > height ? `${win.start + 1}-${win.end} of ${body.length}` : undefined;
	lines.push(hintBar(t as never, width, hints, pos));

	return { lines, scroll: win.offset };
}

// ─────────────────────────── 组件外壳 ───────────────────────────

export type DefineReviewResult = { status: "confirmed" } | { status: "rejected"; comment?: string };

/**
 * 打开范围确认页,阻塞到人裁决。
 * E 进意见输入(关页后由调用方收更详细的意见 —— 见头注释),Esc = 无意见拒绝。
 */
export async function openDefineReview(ctx: any, goal: string, definition: Definition): Promise<DefineReviewResult> {
	if (!ctx.hasUI) return { status: "confirmed" };

	return await ctx.ui.custom(
		(tui: any, theme: DefineReviewView["theme"], _kb: any, done: (r: DefineReviewResult) => void) => {
			let focus = 0;
			let scroll = 0;
			let editing = false;
			let draft = "";
			let closed = false;
			const input = new Input();
			input.onSubmit = (value: string) => {
				draft = value;
				close({ status: "rejected", comment: draft.trim() || undefined });
			};
			input.onEscape = () => {
				editing = false;
				tui.requestRender();
			};

			const close = (r: DefineReviewResult) => {
				if (closed) return;
				closed = true;
				done(r);
			};

			return {
				render: (w: number) => {
					const r = renderDefineReview({
						theme,
						width: w,
						rows: Number(tui.terminal?.rows) || 24,
						goal,
						definition,
						focus,
						editing,
						draft,
						scroll,
					});
					scroll = r.scroll;
					return editing ? [...r.lines.slice(0, -1), ...input.render(w)] : r.lines;
				},
				invalidate: () => {},
				handleInput: (data: string) => {
					if (editing) {
						input.handleInput(data);
						return tui.requestRender();
					}
					if (matchesKey(data, Key.escape)) return close({ status: "rejected" });
					if (matchesKey(data, Key.up)) {
						focus = Math.max(0, focus - 1);
						return tui.requestRender();
					}
					if (matchesKey(data, Key.down)) {
						focus = Math.min(SECTION_TITLES.length - 1, focus + 1);
						return tui.requestRender();
					}
					if (data === "e" || data === "E") {
						editing = true;
						input.setValue(draft);
						return tui.requestRender();
					}
					if (matchesKey(data, Key.enter)) return close({ status: "confirmed" });
				},
			};
		},
	);
}

/**
 * pi-missions · ui/ask-review
 *
 * DEFINE 相位的交互问答页(ctx.ui.custom 圆角盒内联页,与 plan-review 同形态)。
 *
 * 它替换的是原来的静态卡片 + 聊天回话:卡片把答案留在上下文里,
 * 换脑即丢,mission_define.resolved 靠模型转抄 —— 转抄丢了,提问额度就白烧了。
 * 这一页把答案直接收进工具结果(信封),同时由 runtime 落进 state(DEFINE_ANSWERED)。
 *
 * 交互(与 rpiv-ask-user-question 的差距是刻意的:DEFINE 问题本质是 2-3 个决策,
 * 不做 multiSelect、不做 preview 面板):
 *   ↑↓ 选选项(推荐项默认选中并高亮)
 *   Tab 切问题(≤3 题,页签);E 进自定义输入(单行 Input,不嵌 ui.editor —— 会把 TUI 叠坏)
 *   Enter 确认当前问题并前进;最后一题 Enter = 提交
 *   Esc 中断 —— 模型收到"人中断"信封,轮次照样烧掉(否则模型可以反复问反复中断原地打转)
 *
 * 渲染是纯函数 renderAskReview(),与输入处理分离 —— 可单测,也能离线预览。
 */

import { Input, Key, matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import type { AskAnswer, AskQuestion } from "../core/define.ts";
import {
	boxBot,
	boxRow,
	boxSep,
	boxTop,
	clip,
	contentBudget,
	hintBar,
	pad,
	ruleLabel,
	tabs,
	windowLines,
	wrap,
} from "./chrome.ts";
import type { LineTheme } from "./dashboard.ts";
import { optionLabel, optionPreview, type AskOption } from "../core/define.ts";

export interface AskView {
	theme: LineTheme & { bg?(color: string, s: string): string };
	width: number;
	rows: number;
	questions: AskQuestion[];
	/** 当前问题下标 */
	qi: number;
	/** 每题的选中行:0..options.length-1 = 选项,= options.length 表示进入自定义输入 */
	sel: number[];
	/** 每题的自定义文本(进入输入前已敲的内容,渲染在 E 行下方) */
	draft: string[];
	/** 当前题是否在自定义输入模式 */
	editing: boolean;
	/** 滚动偏移,由外壳持有;渲染返回夹取后的值写回 */
	scroll: number;
}

export interface AskRender {
	lines: string[];
	scroll: number;
}

const CUSTOM_LABEL = "自定义答案(E)";

/** 单题内容行:题干 + 选项列表 + 自定义行。返回 [选中项起始行, 选中项结束行) 供窗口锚定 */
function questionLines(view: AskView, qi: number, inner: number): { lines: string[]; selStart: number; selEnd: number } {
	const t = view.theme;
	const q = view.questions[qi];
	const lines: string[] = [];

	for (const l of wrap(q.text, Math.max(12, inner))) lines.push(t.fg("text", l));
	for (const l of wrap(`它会改变:${q.impact}`, Math.max(12, inner))) lines.push(t.fg("muted", l));
	for (const l of wrap(`推荐:${q.recommend}`, Math.max(12, inner))) lines.push(t.fg("accent", l));
	lines.push("");

	const selStart = lines.length;
	const options = q.options ?? [];
	// 没有选项的开放式问题:推荐项本身作为唯一可选行
	const rows: Array<{ label: string; preview?: string; isRecommended?: boolean; isCustom?: boolean }> = options.map((o) => ({
		label: optionLabel(o),
		preview: optionPreview(o),
		isRecommended: optionLabel(o) === q.recommend,
	}));
	rows.push({ label: CUSTOM_LABEL, isCustom: true });

	for (const [i, row] of rows.entries()) {
		const selected = !view.editing && view.sel[qi] === i;
		const cursor = selected ? "▸" : " ";
		const mark = row.isCustom ? (view.draft[qi]?.trim() ? "·" : "▢") : row.isRecommended ? "★" : "▢";
		const text =
			`${cursor} ${mark} ${row.label}` +
			(row.isCustom && view.draft[qi]?.trim() ? `:${view.draft[qi]}` : "") +
			(row.isRecommended && !row.isCustom ? "(推荐)" : "");
		const painted = row.isCustom ? t.fg("dim", text) : text;
		lines.push(painted);
	}
	const selEnd = lines.length;

	if (view.editing && view.sel[qi] === options.length) {
		lines.push(`  ${t.fg("accent", "输入:")}${view.draft[qi]}▁`);
	}
	return { lines, selStart, selEnd };
}

/** 整页渲染。行数随题切换会变,窗口保证选中项完整可见 */
export function renderAskReview(view: AskView): AskRender {
	const width = Math.max(40, view.width);
	const inner = width - 4;
	const t = view.theme;

	const meta = `${view.qi + 1}/${view.questions.length} 题`;
	const lines: string[] = [
		boxTop(t as never, width, `DEFINE 问答 · 需要你拍板`, meta),
		boxRow(
			t as never,
			width,
			clip(
				tabs(
					t as never,
					view.questions.map((q, i) => ({ id: String(i), label: `Q${i + 1}` })),
					String(view.qi),
				),
				inner,
			),
		),
		boxSep(t as never, width),
	];

	const bodyStart = lines.length;
	const q = questionLines(view, view.qi, inner);

	// 选中选项的 ASCII 示意图(可选):盒内下半区,ruleLabel 隔开。
	// 字符画逐行 clip 不折行 —— 列对齐就是它的语义,折了就碎了。
	// 没图(选项未带 preview / 自定义行 / 开放式问题)不画这个区,下半区保持空行。
	const selRow = view.sel[view.qi];
	const options = view.questions[view.qi].options ?? [];
	const preview = selRow >= 0 && selRow < options.length ? optionPreview(options[selRow]) : undefined;
	const previewLabel = preview ? `选中 preview · ${optionLabel(options[selRow])}` : "已确认";
	const body = [
		...q.lines,
		"",
		...(preview
			? [ruleLabel(t as never, inner, previewLabel),
				...preview.split("\n").map((l) => t.fg("dim", clip(l, inner)))]
			: []),
		"",
		ruleLabel(t as never, inner, `已确认 ${view.qi}/${view.questions.length}`),
	];
	const height = Math.max(6, contentBudget(view.rows) - (lines.length - 1));
	const anchorStart = bodyStart + q.selStart;
	const anchorEnd = bodyStart + q.selEnd;
	const win = windowLines(body, view.scroll, height, {
		start: anchorStart,
		end: anchorEnd,
	});
	for (const [i, l] of win.lines.entries()) {
		// 选中行整行铺 selectedBg —— 主要视觉;行内容本身不再加边框色
		const isSel = view.sel[view.qi] >= 0 && bodyStart + win.start + i === anchorStart + view.sel[view.qi];
		lines.push(boxRow(t as never, width, l, { highlight: isSel && !view.editing }));
	}
	for (let i = win.lines.length; i < height; i++) lines.push(boxRow(t as never, width));

	lines.push(boxBot(t as never, width));

	const hints: Array<[string, string]> = [
		["↑↓", "选"],
		["Tab", "切题"],
		["E", "自定义"],
		["Enter", view.qi === view.questions.length - 1 ? "提交" : "确认并下一题"],
		["Esc", "中断"],
	];
	const pos = body.length > height ? `${win.start + 1}-${win.end} of ${body.length}` : undefined;
	lines.push(hintBar(t as never, width, hints, pos));

	return { lines, scroll: win.offset };
}

// ─────────────────────────── 组件外壳 ───────────────────────────

export type AskReviewResult =
	| { status: "answered"; answers: (AskAnswer | undefined)[] }
	| { status: "cancelled" };

/**
 * 打开问答页,阻塞到人答完或中断。
 * 自定义输入用 pi-tui 的单行 Input,不嵌 ctx.ui.editor(plan-review 头注释里的事故)。
 */
export async function openAskReview(ctx: any, questions: AskQuestion[]): Promise<AskReviewResult> {
	return await ctx.ui.custom(
		(
			tui: any,
			theme: AskView["theme"],
			_kb: any,
			done: (r: AskReviewResult) => void,
		) => {
			let qi = 0;
			const sel: number[] = questions.map((q) => {
				if (!q.options?.length) return 0;
				const i = q.options.findIndex((o) => optionLabel(o) === q.recommend);
				// 推荐项不在 options 里时退回第一项 —— 默认不能落在自定义答案上,人没敲字就提交会落成空答案
				return Math.max(0, i);
			});
			const draft: string[] = questions.map(() => "");
			let editing = false;
			let scroll = 0;
			let closed = false;
			const input = new Input();
			input.onSubmit = (value: string) => {
				draft[qi] = value;
				commit();
			};
			input.onEscape = () => {
				editing = false;
				tui.requestRender();
			};

			const close = (r: AskReviewResult) => {
				if (closed) return;
				closed = true;
				done(r);
			};

			const commit = () => {
				// 自定义输入提交:把该题答案落成 custom
				if (editing) {
					answers[qi] = { kind: "custom", value: draft[qi] ?? "" };
				} else {
					const q = questions[qi];
					const options = q.options ?? [];
					if (sel[qi] === options.length) {
						answers[qi] = draft[qi]?.trim() ? { kind: "custom", value: draft[qi] } : { kind: "none" };
					} else {
						answers[qi] = { kind: "option", value: options[sel[qi]] !== undefined ? optionLabel(options[sel[qi]]) : q.recommend };
					}
				}
				if (qi < questions.length - 1) {
					qi += 1;
					scroll = 0;
					editing = questions[qi].options?.length ? editing : false;
					tui.requestRender();
				} else {
					close({ status: "answered", answers: [...answers] });
				}
			};

			const answers: (AskAnswer | undefined)[] = questions.map(() => undefined);

			return {
				render: (w: number) => {
					const r = renderAskReview({
						theme,
						width: w,
						rows: Number(tui.terminal?.rows) || 24,
						questions,
						qi,
						sel,
						draft,
						editing,
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
					const q = questions[qi];
					const options = q.options ?? [];
					if (matchesKey(data, Key.escape)) return close({ status: "cancelled" });
					if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
						qi = (qi + 1) % questions.length;
						scroll = 0;
						return tui.requestRender();
					}
					if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
						qi = (qi - 1 + questions.length) % questions.length;
						scroll = 0;
						return tui.requestRender();
					}
					if (matchesKey(data, Key.up)) {
						sel[qi] = Math.max(0, sel[qi] - 1);
						return tui.requestRender();
					}
					if (matchesKey(data, Key.down)) {
						sel[qi] = Math.min(options.length, sel[qi] + 1);
						return tui.requestRender();
					}
					if (data === "e" || data === "E") {
						editing = true;
						sel[qi] = options.length;
						input.setValue(draft[qi] ?? "");
						return tui.requestRender();
					}
					if (matchesKey(data, Key.enter)) return commit();
				},
			};
		},
	);
}

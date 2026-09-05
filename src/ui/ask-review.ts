/**
 * pi-missions · ui/ask-review
 *
 * DEFINE 相位的交互问答页(ctx.ui.custom 圆角盒内联页,与 plan-review 同形态)。
 *
 * 它替换的是原来的静态卡片 + 聊天回话:卡片把答案留在上下文里,
 * 换脑即丢,mission_define.resolved 靠模型转抄 —— 转抄丢了,提问额度就白烧了。
 * 这一页把答案直接收进工具结果(信封),同时由 runtime 落进 state(DEFINE_ANSWERED)。
 *
 * 交互:
 *   ↑↓ 选(推荐项默认选中);选中项带 ASCII 示意图时,在盒内下半区展示
 *   Tab 切问题(≤3 题,页签);E 进自定义输入(单行 Input,不嵌 ui.editor —— 会把 TUI 叠坏)
 *   Enter 确认当前问题并前进;最后一题 Enter = 提交。已确认的答案列在下半区
 *   Esc 中断 —— 模型收到"人中断"信封,轮次照样烧掉(否则模型可以反复问反复中断原地打转)
 *
 * **单选,不做多选。** 理由不是"DEFINE 只有 2-3 个决策"(这条撑不住,见下),
 * 而是**提问的经济学**:推荐项默认选中、人回车即过,一轮成本接近零 ——
 * "standard 2 轮 / complex 3 轮"这个预算付得起,全靠这一点。多选把它变成
 * 逐项判断勾不勾,单题成本立刻上去,而轮次预算没变。
 * 更大的风险是它会把 DEFINE 从**做决策**滑向**收集范围**:多选天然邀请模型问
 * "以下哪些要做?"然后列一串复选框 —— 那正是 phases/define.md 的"不要没话找话"
 * 与范围确认卡在防的事。
 *
 * 已知的反证,留给下一个人判断:模型会**手工枚举组合**来绕过这个限制 ——
 * 真实例子是「副屏放什么」列出「组件和书签都能放 / 只放组件 / 只放书签」,
 * 那是一个两元素集合的幂集。两个元素还能忍,三个就要 7 个选项。
 * 再遇到一两次这种题,就说明缺口是真的,该加了;只有一例时,逼模型拍平成
 * 三个选项反而更逼它想清楚哪个组合才是真选项。
 *
 * > 这段注释原来写的是"与 rpiv-ask-user-question 的差距是刻意的……不做 multiSelect、
 * > 不做 preview 面板" —— 一个理由撑两个结论,而其中的 preview 后来加了(47ec59a),
 * > 注释没跟着改。一句话里半句是假的,就不能再拿它当"这是刻意设计"的依据了。
 *
 * 渲染是纯函数 renderAskReview(),与输入处理分离 —— 可单测(ask-review.snapshot.test.ts),
 * 也能离线预览(scripts/preview-ask-review.ts,default / open / done 三态)。
 */

import { Input, Key, matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import type { AskAnswer, AskQuestion } from "../core/define.ts";
import {
	boxBot,
	boxRow,
	boxSep,
	boxTop,
	clip,
	bodyHeight,
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
	/** 已确认的答案(与 questions 同序;undefined = 还没确认)。盒内下半区据此列账 */
	answers?: (AskAnswer | undefined)[];
	/** 滚动偏移,由外壳持有;渲染返回夹取后的值写回 */
	scroll: number;
}

/**
 * 一题的可选行。**行模型必须共享** —— 渲染与提交都按它取,不许各自做索引算术。
 *
 * 旧实现两边都写死"`sel === options.length` 就是自定义行",于是开放式问题
 * (options 省略)整页只剩一个「自定义答案」:推荐语只是上面一行说明文字,
 * 不是可选项。人直接回车 → 落成 { kind: "none" },一次提问额度就这么没了,
 * 而人以为自己接受了推荐。
 */
export interface AskRow {
	label: string;
	preview?: string;
	/** option = 模型给的选项;recommend = 开放式问题合成出来的推荐行;custom = 自定义输入 */
	kind: "option" | "recommend" | "custom";
	recommended: boolean;
}

export function askRows(q: AskQuestion): AskRow[] {
	const opts = q.options ?? [];
	const rows: AskRow[] =
		opts.length > 0
			? opts.map((o) => ({
					label: optionLabel(o),
					preview: optionPreview(o),
					kind: "option" as const,
					recommended: optionLabel(o) === q.recommend,
				}))
			: [{ label: q.recommend, kind: "recommend" as const, recommended: true }];
	rows.push({ label: CUSTOM_LABEL, kind: "custom", recommended: false });
	return rows;
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
	// 这里原来还有一行 `推荐:${q.recommend}`。删掉了 —— 推荐项就在下面的列表里,
	// 逐字重复一遍是纯开销。推荐这件事由行尾的一个词承载(见下),它跟着行走,
	// 游标移开也还在;而 core 的闸门保证了 recommend 一定命中某一行。
	lines.push("");

	const selStart = lines.length;
	for (const [i, row] of askRows(q).entries()) {
		const selected = !view.editing && view.sel[qi] === i;
		// 选中态只有两个信号:游标 + 整行高亮。**不再画方框** ——
		// 旧实现的 ▢ 与 sel 无关、永远勾不上,却让人以为这是可勾选的多选框(实为单选)。
		const cursor = selected ? "▸" : " ";
		const draft = view.draft[qi]?.trim();
		const label = row.kind === "custom" && draft ? `${row.label}:${draft}` : row.label;
		const body = `${cursor} ${label}`;
		lines.push(row.kind === "custom" && !draft ? t.fg("dim", body) : body);
		if (row.recommended) lines[lines.length - 1] += t.fg("dim", "   推荐");
	}
	const selEnd = lines.length;

	if (view.editing && askRows(q)[view.sel[qi]]?.kind === "custom") {
		lines.push(`  ${t.fg("accent", "输入:")}${view.draft[qi]}▁`);
	}
	return { lines, selStart, selEnd };
}

/** 盒内下半区的「已确认」账目:哪题答了什么。没答过的不列 */
function confirmedLines(view: AskView, inner: number): string[] {
	const t = view.theme;
	const answers = view.answers ?? [];
	const out: string[] = [];
	for (const [i, a] of answers.entries()) {
		if (!a) continue;
		const q = view.questions[i];
		if (!q) continue;
		const text =
			a.kind === "custom" ? (a.value.trim() || "(空)") : a.kind === "none" ? `${q.recommend}(未选,回落推荐)` : a.value;
		out.push(`${t.fg("accent", `Q${i + 1}`)} ${clip(text, Math.max(8, inner - 4))}`);
	}
	return out;
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
	const rows = askRows(view.questions[view.qi]);
	const preview = rows[view.sel[view.qi]]?.preview;
	const confirmed = confirmedLines(view, inner);
	// 计数用**真实已答数**,不是当前页签下标 —— 旧实现写的是 view.qi,
	// Tab 回第一题就显示 0/3,和答没答过毫无关系。
	const done = (view.answers ?? []).filter(Boolean).length;
	const body = [
		...q.lines,
		"",
		...(preview
			? [
					ruleLabel(t as never, inner, `选中示意 · ${rows[view.sel[view.qi]].label}`),
					...preview.split("\n").map((l) => t.fg("dim", clip(l, inner))),
					"",
				]
			: []),
		ruleLabel(t as never, inner, `已确认 ${done}/${view.questions.length}`),
		...(confirmed.length > 0 ? confirmed : [t.fg("dim", "  (还没确认任何一题)")]),
	];
	const height = bodyHeight(view.rows, lines.length, 6);
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
			// 默认落在推荐行上。开放式问题(无 options)也有推荐行 —— 见 askRows,
			// 它正是为了不让默认落到"自定义答案"上(人没敲字就回车 = 空答案)。
			// recommend 一定命中某一行:core 的 evaluateAsk 已经拦过。
			const sel: number[] = questions.map((q) => Math.max(0, askRows(q).findIndex((r) => r.recommended)));
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
					const row = askRows(questions[qi])[sel[qi]];
					if (!row || row.kind === "custom") {
						answers[qi] = draft[qi]?.trim() ? { kind: "custom", value: draft[qi] } : { kind: "none" };
					} else {
						// option 与 recommend 两种行都是"选了一个给定答案",落成同一种 AskAnswer
						answers[qi] = { kind: "option", value: row.label };
					}
				}
				if (qi < questions.length - 1) {
					qi += 1;
					scroll = 0;
					editing = false;
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
						answers,
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
					const rows = askRows(questions[qi]);
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
						sel[qi] = Math.min(rows.length - 1, sel[qi] + 1);
						return tui.requestRender();
					}
					if (data === "e" || data === "E") {
						editing = true;
						sel[qi] = rows.length - 1; // 自定义行永远是最后一行
						input.setValue(draft[qi] ?? "");
						return tui.requestRender();
					}
					if (matchesKey(data, Key.enter)) return commit();
				},
			};
		},
	);
}

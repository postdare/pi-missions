/**
 * pi-missions · ui/human-review
 *
 * quick 档 `judge: "human"` 的人工终审页(ctx.ui.custom 圆角盒内联页,
 * 与 ask-review / plan-review 同形态)。
 *
 * 它替换的是 `ctx.ui.select` + `ctx.ui.input` 两次内置弹窗。换掉不是为了好看 ——
 * 内置控件表达不出这个面的三条纪律,而这三条是 human 证据能算 I3(判定在执行者
 * 之外)的全部依据。少一条,human 就退化成 soft(执行者自述)的变体:
 *
 *  1. **没有默认值**。首次进入 `sel = -1`,两个选项都不预选,人必须先按一次 ↑↓。
 *     做成"回车即过"的话,人没看,只是按了键。这跟 ask-review 刻意把游标停在
 *     推荐项上正好相反 —— 那边是压低提问成本,这边是必须换来一个真实的动作。
 *  2. **取消 ≠ 通过,且与"裁判缺席"是两回事**。Esc 返回 cancelled,不产出证据,
 *     由 judge() 规则 4 判 inconclusive,还能再来一轮;非 TUI 环境是裁判根本
 *     弹不出来,走 cause=judge 直接停机。区别以前只活在代码里,现在写在提示条上。
 *  3. **不通过必须给理由**,理由进 LOG 并成为下一轮 ACT 的输入。追问不再是第二个
 *     弹窗,而是同一页的第二态(stage="reason")—— 弹窗叠弹窗时 Esc 该退到哪一层
 *     没人说得清,同页两态则 Esc 语义单一:回上一步。
 *
 * **判据正文一律折行,不截断。** 它是人要照着逐条核对的东西,截掉哪一条都可能
 * 让"通过"变成误判 —— 这正是 CLAUDE.md 里"截断等于把最该看的信息丢掉"的原型场景。
 *
 * 渲染是纯函数 renderHumanReview(),与输入处理分离 —— 可单测
 * (human-review.snapshot.test.ts),也能离线预览(scripts/preview-human-review.ts)。
 */

import { Input, Key, matchesKey } from "@earendil-works/pi-tui";
import {
	boxBot,
	boxRow,
	boxTop,
	clip,
	contentBudget,
	hintBar,
	ruleLabel,
	windowLines,
	wrap,
} from "./chrome.ts";
import type { LineTheme } from "./dashboard.ts";
import { shortId } from "./dashboard.ts";

export const PASS_LABEL = "通过 —— 收工";
export const FAIL_LABEL = "不通过 —— 我来说哪里不对";

/** 判定行。索引即语义:0 = 通过,1 = 不通过。sel = -1 表示还没选(纪律 1) */
export const DECISION_ROWS = [PASS_LABEL, FAIL_LABEL] as const;

export interface HumanReviewView {
	theme: LineTheme & { bg?(color: string, s: string): string };
	width: number;
	rows: number;
	missionId: string;
	/** 冻结的判据正文(QuickCriterion.text)。折行展示,绝不截断 */
	criterionText: string;
	/** decide = 选通过/不通过;reason = 已选不通过,正在写理由 */
	stage: "decide" | "reason";
	/** -1 = 未选(首次进入),0/1 = DECISION_ROWS 下标 */
	sel: number;
	/** 理由草稿(stage="reason" 时渲染) */
	reason: string;
	scroll: number;
}

export interface HumanReviewRender {
	lines: string[];
	scroll: number;
}

/** 判据段:标签线 + 折行正文 */
function criterionLines(view: HumanReviewView, inner: number): string[] {
	const t = view.theme;
	return [
		ruleLabel(t as never, inner, "判据 · 冻结于进 DO 之前"),
		...wrap(view.criterionText, Math.max(12, inner - 2)).map((l) => `  ${l}`),
	];
}

export function renderHumanReview(view: HumanReviewView): HumanReviewRender {
	const width = Math.max(40, view.width);
	const inner = width - 4;
	const t = view.theme;

	// 盒顶之后不接 boxSep:中间没有头行,两条横线贴在一起是白占一行
	const lines: string[] = [boxTop(t as never, width, "人工终审 · 需要你判定", `quick · ${shortId(view.missionId)}`)];
	const bodyStart = lines.length;

	const body: string[] = [...criterionLines(view, inner), ""];
	// 选中行的锚点区间(供 windowLines 保证可见);reason 态没有可选行
	let anchorOffset = -1;

	if (view.stage === "decide") {
		body.push(ruleLabel(t as never, inner, "判定"));
		anchorOffset = body.length;
		for (const [i, label] of DECISION_ROWS.entries()) {
			const cursor = view.sel === i ? "▸" : " ";
			body.push(`${cursor} ${label}`);
		}
		if (view.sel < 0) {
			// 未选态要说清"为什么没有默认" —— 否则人会以为页面没加载好
			body.push("");
			body.push(t.fg("dim", "  两项都不预选:回车即过等于没看就按键,那不是外部判定"));
		}
	} else {
		body.push(ruleLabel(t as never, inner, "哪里不对?"));
		body.push(`  ${view.reason}▁`);
		body.push("");
		body.push(t.fg("dim", "  会写进 LOG,并作为下一轮 ACT 的输入"));
	}

	// 高度按内容收,不铺满 contentBudget —— 这一页内容短且固定,
	// 铺满会留出十几行空白,看着像渲染坏了(plan-review 那种长列表才需要铺满)
	const height = Math.max(4, Math.min(contentBudget(view.rows) - (lines.length - 1), body.length));
	const win = windowLines(
		body,
		view.scroll,
		height,
		anchorOffset >= 0 ? { start: bodyStart + anchorOffset, end: bodyStart + anchorOffset + DECISION_ROWS.length } : null,
	);
	for (const [i, l] of win.lines.entries()) {
		const isSel =
			view.stage === "decide" && view.sel >= 0 && win.start + i === anchorOffset + view.sel;
		lines.push(boxRow(t as never, width, l, { highlight: isSel }));
	}
	for (let i = win.lines.length; i < height; i++) lines.push(boxRow(t as never, width));
	lines.push(boxBot(t as never, width));

	const hints: Array<[string, string]> =
		view.stage === "decide"
			? [
					["↑↓", "选"],
					["Enter", "确认"],
					["Esc", "取消 = 本轮无结论(不是通过)"],
				]
			: [
					["Enter", "提交理由"],
					["Esc", "回上一步"],
				];
	const pos = body.length > height ? `${win.start + 1}-${win.end} of ${body.length}` : undefined;
	lines.push(hintBar(t as never, width, hints, pos));

	return { lines, scroll: win.offset };
}

// ─────────────────────────── 组件外壳 ───────────────────────────

export type HumanReviewResult =
	| { status: "decided"; passed: true }
	| { status: "decided"; passed: false; reason: string }
	| { status: "cancelled" };

/**
 * 打开终审页,阻塞到人做出判定或取消。
 *
 * 返回 cancelled 时**不要**当成失败,也不要当成通过 —— 调用方(check-runner)
 * 不产出证据,让 judge() 判 inconclusive。理由输入用 pi-tui 的单行 Input,
 * 不嵌 ctx.ui.editor(会把 TUI 叠坏,见 plan-review 头注释)。
 */
export async function openHumanReview(
	ctx: any,
	opts: { missionId: string; criterionText: string },
): Promise<HumanReviewResult> {
	return await ctx.ui.custom(
		(tui: any, theme: HumanReviewView["theme"], _kb: any, done: (r: HumanReviewResult) => void) => {
			let stage: "decide" | "reason" = "decide";
			let sel = -1; // 纪律 1:不预选
			let reason = "";
			let scroll = 0;
			let closed = false;

			const close = (r: HumanReviewResult) => {
				if (closed) return;
				closed = true;
				done(r);
			};

			const input = new Input();
			input.onSubmit = (value: string) => {
				reason = value;
				submitReason();
			};
			input.onEscape = () => {
				stage = "decide";
				scroll = 0;
				tui.requestRender();
			};

			const submitReason = () => {
				// 理由留空不许落成 pass,也不许把空字符串写进 LOG
				close({ status: "decided", passed: false, reason: reason.trim() || "人工终审未通过(未说明原因)" });
			};

			return {
				render: (w: number) => {
					const r = renderHumanReview({
						theme,
						width: w,
						rows: Number(tui.terminal?.rows) || 24,
						missionId: opts.missionId,
						criterionText: opts.criterionText,
						stage,
						sel,
						reason,
						scroll,
					});
					scroll = r.scroll;
					return stage === "reason" ? [...r.lines.slice(0, -1), ...input.render(w)] : r.lines;
				},
				invalidate: () => {},
				handleInput: (data: string) => {
					if (stage === "reason") {
						input.handleInput(data);
						return tui.requestRender();
					}
					if (matchesKey(data, Key.escape)) return close({ status: "cancelled" });
					if (matchesKey(data, Key.up)) {
						sel = sel <= 0 ? DECISION_ROWS.length - 1 : sel - 1;
						return tui.requestRender();
					}
					if (matchesKey(data, Key.down)) {
						sel = sel < 0 || sel >= DECISION_ROWS.length - 1 ? 0 : sel + 1;
						return tui.requestRender();
					}
					if (matchesKey(data, Key.enter)) {
						// 未选时回车什么也不做 —— 纪律 1 的落点就在这一行
						if (sel < 0) return;
						if (sel === 0) return close({ status: "decided", passed: true });
						stage = "reason";
						scroll = 0;
						return tui.requestRender();
					}
				},
				dispose: () => {},
			};
		},
	);
}

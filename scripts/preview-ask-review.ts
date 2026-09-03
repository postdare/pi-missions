/**
 * ask-review 离线预览:不起 pi,直接把 DEFINE 问答页渲染到 stdout。
 *
 * 用法:
 *   node --experimental-strip-types scripts/preview-ask-review.ts
 *   COLUMNS=56 node --experimental-strip-types scripts/preview-ask-review.ts
 *   node --experimental-strip-types scripts/preview-ask-review.ts open   # 开放式问题(无 options)
 *   node --experimental-strip-types scripts/preview-ask-review.ts done   # 答过两题之后
 */
import { renderAskReview } from "../src/ui/ask-review.ts";
import type { AskAnswer, AskQuestion } from "../src/core/define.ts";

const theme = {
	fg: (_c: string, s: string) => `\x1b[90m${s}\x1b[0m`,
	bg: (_c: string, s: string) => s,
	bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

const width = Number(process.env.COLUMNS) || 96;
const mode = process.argv[2] ?? "default";

const questions: AskQuestion[] = [
	{
		id: "Q1",
		text: "副屏上允许放什么内容?",
		impact: "决定完成条件是否包含『书签分组可以出现在副屏』,以及副屏是否要复用 HomeLinkList 那套分组+拖拽坐标体系",
		recommend: "组件和书签分组都能放",
		options: [
			{ label: "组件和书签分组都能放", preview: "┌ 首屏 ────┐  ┌ 副屏 ────────┐\n│ 时钟/搜索 │  │ [天气] [书签组] │\n└──────────┘  └──────────────┘" },
			{ label: "副屏只放小组件", preview: "┌ 首屏 ────┐  ┌ 副屏 ────────┐\n│ 时钟/搜索 │  │ [天气] [AI]     │\n│ /书签     │  │ [待办] [日历]   │\n└──────────┘  └──────────────┘\n副屏 = 纯组件画布,书签仍全在首屏" },
			"副屏只放书签分组",
		],
	},
	{ id: "Q2", text: "副屏的默认列数按什么定?", impact: "决定布局数据模型是固定栅格还是自适应", recommend: "按视口宽度自适应,3 列起步" },
	{ id: "Q3", text: "副屏要不要支持拖拽排序?", impact: "决定是否复用现有拖拽坐标体系", recommend: "支持,复用现有实现", options: ["支持,复用现有实现", "先不做,后续迭代"] },
];

const answers: (AskAnswer | undefined)[] =
	mode === "done"
		? [{ kind: "option", value: "组件和书签分组都能放" }, { kind: "custom", value: "固定 4 列,不自适应" }, undefined]
		: [undefined, undefined, undefined];

const qi = mode === "open" ? 1 : mode === "done" ? 2 : 0;
const r = renderAskReview({
	theme,
	width,
	rows: 34,
	questions,
	qi,
	sel: [1, 0, 0],
	draft: ["", "", ""],
	editing: false,
	answers,
	scroll: 0,
});
console.log(r.lines.join("\n"));

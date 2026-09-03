/**
 * pi-missions · ask-review 样式快照
 *
 * 这一页原来是三道防线里唯一缺快照的(render.test.ts 卡宽度、theme-colors 卡色名,
 * 观感没人卡)。缺的代价是真的:▢ 假 checkbox、「推荐」重复四遍、「已确认」区
 * 永远是 0/N 且不列答案 —— 四个问题一起躺在那儿,直到有人截图才发现。
 *
 * 快照存的是剥离 ANSI 后的纯文本;观感变了就红,确认是想要的改动后:
 *   UPDATE_SNAPSHOTS=1 node --test test/ask-review.snapshot.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderAskReview } from "../src/ui/ask-review.ts";
import type { AskAnswer, AskQuestion } from "../src/core/define.ts";

const here = dirname(fileURLToPath(import.meta.url));
const SNAP = join(here, "__snapshots__", "ask-review.txt");
const UPDATE = process.env.UPDATE_SNAPSHOTS === "1";

const theme = {
	fg: (c: string, s: string) => `\x1b[90m${s}\x1b[0m`,
	bg: (_c: string, s: string) => s,
	bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

const QUESTIONS: AskQuestion[] = [
	{
		id: "Q1",
		text: "副屏上允许放什么内容?",
		impact: "决定完成条件是否包含『书签分组可以出现在副屏』,以及副屏是否要复用 HomeLinkList 那套分组+拖拽坐标体系",
		recommend: "组件和书签分组都能放",
		options: [
			{ label: "组件和书签分组都能放", preview: "┌ 首屏 ────┐  ┌ 副屏 ────────┐\n│ 时钟/搜索 │  │ [天气] [书签组] │\n└──────────┘  └──────────────┘" },
			{ label: "副屏只放小组件", preview: "┌ 首屏 ────┐  ┌ 副屏 ──────┐\n│ 时钟/搜索 │  │ [天气] [AI] │\n└──────────┘  └────────────┘" },
			"副屏只放书签分组",
		],
	},
	// 开放式问题:没有 options。推荐必须自己成为一个可选行,否则默认落在"自定义答案"上
	{ id: "Q2", text: "副屏的默认列数按什么定?", impact: "决定布局数据模型是固定栅格还是自适应", recommend: "按视口宽度自适应,3 列起步" },
	{ id: "Q3", text: "副屏要不要支持拖拽排序?", impact: "决定是否复用现有拖拽坐标体系", recommend: "支持,复用现有实现", options: ["支持,复用现有实现", "先不做,后续迭代"] },
];

const ANSWERED: (AskAnswer | undefined)[] = [
	{ kind: "option", value: "组件和书签分组都能放" },
	{ kind: "custom", value: "固定 4 列,不自适应" },
	undefined,
];

interface Case {
	name: string;
	width: number;
	qi: number;
	sel: number[];
	answers?: (AskAnswer | undefined)[];
	editing?: boolean;
	draft?: string[];
}

const CASES: Case[] = [
	{ name: "Q1 选中推荐项(带示意图)· w=96", width: 96, qi: 0, sel: [0, 0, 0] },
	{ name: "Q1 选中非推荐项 · w=96", width: 96, qi: 0, sel: [1, 0, 0] },
	{ name: "Q1 选中无示意图的项 · w=96", width: 96, qi: 0, sel: [2, 0, 0] },
	{ name: "Q2 开放式(推荐自成一行)· w=96", width: 96, qi: 1, sel: [0, 0, 0] },
	{ name: "Q2 落在自定义行 · w=96", width: 96, qi: 1, sel: [0, 1, 0] },
	{ name: "Q3 已答两题(列账)· w=96", width: 96, qi: 2, sel: [0, 0, 0], answers: ANSWERED },
	{ name: "自定义输入态 · w=96", width: 96, qi: 0, sel: [3, 0, 0], editing: true, draft: ["只放天气和待办", "", ""] },
	{ name: "窄终端 · w=56", width: 56, qi: 0, sel: [1, 0, 0] },
	{ name: "窄终端 · 已答两题 · w=56", width: 56, qi: 2, sel: [0, 0, 0], answers: ANSWERED },
];

function renderLines(c: Case): string {
	const r = renderAskReview({
		theme,
		width: c.width,
		rows: 32,
		questions: QUESTIONS,
		qi: c.qi,
		sel: c.sel,
		draft: c.draft ?? ["", "", ""],
		editing: c.editing ?? false,
		answers: c.answers,
		scroll: 0,
	});
	return r.lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, "")).join("\n");
}

/** 快照条目 = 标题 + 渲染结果。断言只看渲染结果,别把标题里的字也数进去 */
function renderCase(c: Case): string {
	return `── ${c.name} ──\n` + renderLines(c);
}

test("ask-review:样式与快照一致", () => {
	const current = CASES.map(renderCase).join("\n\n") + "\n";
	if (UPDATE) {
		mkdirSync(dirname(SNAP), { recursive: true });
		writeFileSync(SNAP, current, "utf8");
		console.log(`快照已重生成: ${SNAP}(${CASES.length} 个用例)`);
		return;
	}
	assert.equal(
		current,
		readFileSync(SNAP, "utf8"),
		"ask-review 观感变了。若是想要的改动:UPDATE_SNAPSHOTS=1 node --test test/ask-review.snapshot.test.ts",
	);
});

test("没有任何一行画出永远勾不上的方框 —— 选中态只有游标 + 整行高亮", () => {
	for (const c of CASES) {
		const text = renderLines(c);
		for (const glyph of ["▢", "☐", "◯", "★", "[ ]"]) {
			assert.ok(!text.includes(glyph), `${c.name} 出现了 ${glyph}`);
		}
	}
});

test("「推荐」在一题里只出现一次 —— 旧版重复到四次", () => {
	// 行尾后缀 ×1。曾经是:上方「推荐:」行 + ★ 标记 + 行尾「(推荐)」+ 模型自己写进 label 的
	for (const c of CASES) {
		const body = renderLines(c).split("已确认")[0];
		assert.equal((body.match(/推荐/g) ?? []).length, 1, `${c.name} 的「推荐」出现次数不对`);
	}
});

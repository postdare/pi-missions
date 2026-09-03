/**
 * pi-missions · human-review 样式快照
 *
 * 快照存的是剥离 ANSI 后的纯文本;观感变了就红,确认是想要的改动后:
 *   UPDATE_SNAPSHOTS=1 node --test test/human-review.snapshot.test.ts
 *
 * 除了观感,这里还卡住三条纪律的可见形态(不预选 / 取消≠通过要写在提示条上 /
 * 判据不截断)。纪律的**行为**在 runtime.smoke.test.ts 里按真实按键驱动。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { visibleWidth } from "@earendil-works/pi-tui";
import { DECISION_ROWS, renderHumanReview, type HumanReviewView } from "../src/ui/human-review.ts";

const here = dirname(fileURLToPath(import.meta.url));
const SNAP = join(here, "__snapshots__", "human-review.txt");
const UPDATE = process.env.UPDATE_SNAPSHOTS === "1";

const theme = {
	fg: (_c: string, s: string) => `\x1b[90m${s}\x1b[0m`,
	bg: (_c: string, s: string) => s,
	bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

/** 真实判据长这样 —— 一段要人照着逐条核对的话,不是一句"过不过" */
const CRITERION =
	"在新标签页实际验证:把一个小组件卡片和一个书签分组移到副屏后,通过指示点(ScreenDots 第二点亮起)或 → 方向键切到副屏,副屏上能实际看到该卡片(标题栏+内容)和该书签分组(分组标题+链接图标)渲染出来,而不是空白;同时任务答复中给出了导致副屏空白的具体代码级原因(定位到文件与逻辑)。";

interface Case {
	name: string;
	width: number;
	stage: "decide" | "reason";
	sel: number;
	reason?: string;
}

const CASES: Case[] = [
	{ name: "未选(进入时的样子)· w=96", width: 96, stage: "decide", sel: -1 },
	{ name: "选中通过 · w=96", width: 96, stage: "decide", sel: 0 },
	{ name: "选中不通过 · w=96", width: 96, stage: "decide", sel: 1 },
	{ name: "写理由 · w=96", width: 96, stage: "reason", sel: 1, reason: "副屏切过去还是空的,ScreenDots 第二点也没亮" },
	{ name: "窄终端 · 未选 · w=56", width: 56, stage: "decide", sel: -1 },
	{ name: "窄终端 · 写理由 · w=56", width: 56, stage: "reason", sel: 1, reason: "还是空白" },
];

function view(c: Case): HumanReviewView {
	return {
		theme,
		width: c.width,
		rows: 32,
		missionId: "2026-09-03-mission-mtll5d8t",
		criterionText: CRITERION,
		stage: c.stage,
		sel: c.sel,
		reason: c.reason ?? "",
		scroll: 0,
	};
}

function renderLines(c: Case): string {
	return renderHumanReview(view(c))
		.lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""))
		.join("\n");
}

function renderCase(c: Case): string {
	return `── ${c.name} ──\n` + renderLines(c);
}

test("human-review:样式与快照一致", () => {
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
		"human-review 观感变了。若是想要的改动:UPDATE_SNAPSHOTS=1 node --test test/human-review.snapshot.test.ts",
	);
});

test("判据正文一字不少 —— 截掉哪一条都可能让'通过'变成误判", () => {
	// CJK 折行按可见宽度硬断,逐字符核对
	for (const width of [40, 56, 72, 96, 120]) {
		const text = renderLines({ name: "x", width, stage: "decide", sel: -1 });
		for (const ch of CRITERION) {
			assert.ok(text.includes(ch), `w=${width} 判据被截断,丢了「${ch}」`);
		}
	}
});

test("进入时不预选任何一项 —— 回车即过等于人没看只是按了键", () => {
	const text = renderLines({ name: "x", width: 96, stage: "decide", sel: -1 });
	assert.equal((text.match(/▸/g) ?? []).length, 0, "未选态不许有行游标");
	for (const label of DECISION_ROWS) assert.ok(text.includes(label), `选项 ${label} 要在页上`);
	assert.ok(text.includes("回车即过"), "要说明为什么没有默认值,否则人以为页面没加载好");
});

test("提示条把'取消 = 无结论'写出来 —— 这条区别以前只活在代码里", () => {
	const decide = renderLines({ name: "x", width: 96, stage: "decide", sel: 0 });
	// 用 includes 而不是正则:提示条里是全角括号,正则里手写成半角就变成捕获组,
	// 匹配的是"本轮无结论不是通过"这个不存在的串 —— 踩过一次
	assert.ok(decide.includes("Esc 取消 = 本轮无结论(不是通过)"), `实际提示条:${decide.split("\n").pop()}`);
	// 写理由态的 Esc 是回上一步,不是取消整页 —— 弹窗叠弹窗时这点说不清
	const reason = renderLines({ name: "x", width: 96, stage: "reason", sel: 1, reason: "x" });
	assert.ok(reason.includes("回上一步"));
	assert.ok(!reason.includes("本轮无结论"));
});

test("盒行宽度恰好等于 width(差一列就把盒子撕开)", () => {
	for (const width of [40, 56, 72, 96, 120, 200]) {
		for (const stage of ["decide", "reason"] as const) {
			const lines = renderHumanReview(view({ name: "x", width, stage, sel: 1, reason: "还是空白" })).lines;
			// 末行是提示条(不入盒),其余每行都是盒行
			for (const l of lines.slice(0, -1)) {
				assert.equal(visibleWidth(l), width, `w=${width} ${stage} 盒行宽度不对:${l}`);
			}
			assert.ok(visibleWidth(lines[lines.length - 1]) <= width, "提示条不许越界");
		}
	}
});

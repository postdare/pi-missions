/**
 * pi-missions · mission_scout 工具块的渲染防线
 *
 * 这是一条新渲染路径,而且跑在 TUI 主循环里,所以三层都要有:
 *   · 宽度不变式(这里)—— 行越界会炸 TUI,不是排版难看
 *   · 主题色名合法性 —— 在 test/theme-colors.test.ts(编一个色名会炸整个 pi 进程)
 *   · 观感 —— 离线预览 scripts/preview-scout.ts;这一页没有快照,
 *     因为它的内容全部来自入参(不像 plan-review 有固定版面),快照只会锁住测试数据
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	renderScoutCall,
	renderScoutResult,
	scoutResultComponent,
	type ScoutToolDetails,
} from "../src/ui/scout-view.ts";
import type { ScoutFinding } from "../src/core/scout.ts";

const theme = { fg: (_c: string, s: string) => s, bold: (s: string) => s };

const QUESTIONS = [
	{ id: "S1", text: "旧 ORM 的私有 API 在哪些文件里被用到、共几处?按文件列出来" },
	{ id: "S2", text: "有没有现成的集成测试能挂 AC" },
	{ id: "S3", text: "分页参数是从哪个配置读的" },
	{ id: "S4", text: "短" },
];

const FINDINGS: ScoutFinding[] = [
	{
		id: "S1",
		question: QUESTIONS[0].text,
		assume: "3 处左右,集中在 repo 层",
		answer: "11 处,集中在 src/repo 下的 4 个文件,另有 2 处在 scripts/ 的迁移脚本里",
		status: "answered",
		citations: ["src/repo/user.ts:88", "src/repo/order.ts:31"],
		surprised: true,
	},
	{
		id: "S2",
		question: QUESTIONS[1].text,
		assume: "有",
		answer: "有,test/orm/*.test.ts 共 12 个用例",
		status: "answered",
		citations: ["test/orm/user.test.ts"],
		surprised: false,
	},
	{
		id: "S3",
		question: QUESTIONS[2].text,
		assume: "从 config.yaml 读",
		answer: "未查明(超过 180s 或被中止)。沿用假设:从 config.yaml 读",
		status: "unanswered",
		citations: [],
		surprised: false,
	},
];

const PROGRESS: ScoutToolDetails = {
	kind: "progress",
	progress: {
		done: 1,
		total: 4,
		activity: { S1: "已交回结论", S2: "读 src/repo/user.ts", S3: "搜 privateApi", S4: "排队中" },
		running: ["S2", "S3", "S4"],
	},
};

const WIDTHS = [40, 56, 72, 100, 160];

function allLines(width: number): string[] {
	return [
		...renderScoutCall({ theme, width, questions: QUESTIONS }),
		...renderScoutResult({ theme, width, expanded: false, details: PROGRESS }),
		...renderScoutResult({ theme, width, expanded: false, details: { kind: "done", round: 1, findings: FINDINGS } }),
		...renderScoutResult({ theme, width, expanded: true, details: { kind: "done", round: 1, findings: FINDINGS } }),
	];
}

test("任何宽度下都不许有行越界 —— 越界会炸 TUI,不是排版难看", () => {
	for (const width of WIDTHS) {
		for (const line of allLines(width)) {
			assert.ok(visibleWidth(line) <= width, `w=${width} 越界(${visibleWidth(line)}):${JSON.stringify(line)}`);
		}
	}
});

test("字形只用仓库既有的那几个,且不在行首贴竖线", () => {
	// ◌ ◍ ◑ ░ ▒ 在不少等宽字体里会糊成大圆盘/灰板(相位图标和进度条各踩过一次)
	for (const line of allLines(100)) {
		for (const bad of ["◌", "◍", "◑", "░", "▒"]) {
			assert.ok(!line.includes(bad), `出现了 ${bad}:${line}`);
		}
		assert.ok(!/^[▎│┃]/.test(line), `行首贴竖线会被读成"边框裂了":${line}`);
	}
});

test("调用块只印问题,不印 why/assume —— 它会永远留在回滚记录里", () => {
	const text = renderScoutCall({ theme, width: 100, questions: QUESTIONS }).join("\n");
	assert.ok(text.includes("S1"), "问题 id 要在");
	assert.ok(text.includes("旧 ORM"), "问题正文要在");
	assert.ok(text.includes("4 路"), "路数要在标题上");
	assert.ok(!text.includes("假设"), "assume 不该出现在调用块里");
});

test("调用块的长问题折行不截断,续行悬挂对齐", () => {
	const lines = renderScoutCall({ theme, width: 44, questions: [QUESTIONS[0]] });
	assert.ok(lines.length >= 3, "44 列装不下这条问题,应该折行");
	// 首行的问题起始列 = 续行的缩进量
	const col = lines[1].indexOf("旧");
	assert.equal(lines[2].search(/\S/), col, "续行要悬挂到问题列,差一列会看着像另起一段");
	assert.ok(lines.join("").includes("按文件列出来"), "折行不能把尾巴丢掉");
});

test("跑的过程中:一路一行,还在跑的和已回的图标不同", () => {
	const lines = renderScoutResult({ theme, width: 100, expanded: false, details: PROGRESS });
	assert.match(lines[0], /1\/4/);
	const body = lines.slice(1);
	assert.equal(body.length, 4, "四路各占一行");
	assert.match(body[0], /^\s+✓ S1/, "已回的是 ✓");
	assert.match(body[1], /^\s+● S2/, "在跑的是 ●");
	assert.match(body[3], /^\s+○ S4/, "排队的是 ○");
});

test("回来之后:折叠态一路一行,展开态才印出处与原假设", () => {
	const done = { kind: "done", round: 1, findings: FINDINGS } as const;
	const collapsed = renderScoutResult({ theme, width: 100, expanded: false, details: done });
	const expanded = renderScoutResult({ theme, width: 100, expanded: true, details: done });

	assert.equal(collapsed.length, 1 + FINDINGS.length, "折叠态:摘要 + 一路一行");
	assert.match(collapsed[0], /查明 2 · 未查明 1 · 与假设有出入 1/);
	assert.ok(!collapsed.join("\n").includes("出处"), "折叠态不印出处");

	const text = expanded.join("\n");
	assert.ok(text.includes("出处 src/repo/user.ts:88"), "展开态要印出处 —— 没有出处的结论不算结论");
	assert.ok(text.includes("原假设:3 处左右"), "有出入时要把原假设摆出来,差值才是这轮买到的东西");
	assert.ok(!text.includes("原假设:有"), "假设被证实的那一路不必再印一遍");
});

test("未查明的那一路用 ? 而不是 ✓ —— 它绝不能看起来像一条结论", () => {
	const lines = renderScoutResult({
		theme,
		width: 100,
		expanded: false,
		details: { kind: "done", round: 1, findings: FINDINGS },
	});
	const s3 = lines.find((l) => l.includes("S3"))!;
	assert.match(s3, /\?\s+S3/);
	assert.ok(!s3.includes("✓"));
});

test("认不出 details 时仍然返回组件,并把那句话原样印出来", () => {
	// pi 拿到返回值直接 addChild —— 给它 undefined 是在赌宿主的容错。
	// 而被闸门拒掉的调用,details 是 { ok:false },那句拒绝理由必须让人看见
	const c = scoutResultComponent({ ok: false }, "已拒绝:一轮最多扇出 4 路,你给了 6 个。", false, theme);
    assert.ok(c, "永远要有组件");
	const out = c.render(60).join("\n");
	assert.ok(out.includes("一轮最多扇出 4 路"), "拒绝理由不能被藏起来");
	for (const line of c.render(40)) assert.ok(visibleWidth(line) <= 40, `兜底文本也不许越界:${line}`);

	// details 缺失、content 也是空的:给出空数组而不是抛
	assert.deepEqual(scoutResultComponent(undefined, "", false, theme).render(60), []);
});

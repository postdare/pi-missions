/**
 * pi-missions · 主题色名合法性
 *
 * pi 的 theme.fg 遇到未知颜色名会 **抛异常**,而渲染发生在 TUI 主循环里 ——
 * 一个编出来的颜色名(比如 "fg")会把整个 pi 进程带崩,而不是掉个色。
 * 这类错误在宽松的 mock 主题下完全测不出来,所以这里用严格主题跑一遍所有渲染。
 *
 * 颜色名单来自 pi 的 docs/themes.md。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { initialState } from "../src/core/machine.ts";
import type { MissionPlan } from "../src/store/mission.ts";
import { acLines, overviewLines, renderWidgetCard, taskBlocks, taskLines } from "../src/ui/dashboard.ts";
import { modelRows, modelsFooter, pickerRows, type ModelsPageData } from "../src/ui/models-page.ts";
import { renderTaskDetail } from "../src/ui/task-detail.ts";
import { renderStatus } from "../src/ui/status-view.ts";
import { renderPlanReview, SECTION_IDS, type ReviewSection } from "../src/ui/plan-review.ts";
import { renderAskReview } from "../src/ui/ask-review.ts";

/** docs/themes.md 的前景色名(仅列本项目可能用到的部分) */
const FG = new Set([
	"accent",
	"border",
	"borderAccent",
	"borderMuted",
	"success",
	"error",
	"warning",
	"muted",
	"dim",
	"text",
	"thinkingText",
]);
const BG = new Set(["selectedBg", "userMessageBg", "customMessageBg", "toolPendingBg", "toolSuccessBg", "toolErrorBg"]);

/** 与 pi 同样的行为:未知颜色名直接抛 */
const strictTheme = {
	fg: (color: string, s: string) => {
		if (!FG.has(color)) throw new Error(`Unknown theme color: ${color}`);
		return s;
	},
	bg: (color: string, s: string) => {
		if (!BG.has(color)) throw new Error(`Unknown theme color: ${color}`);
		return s;
	},
	bold: (s: string) => s,
};

const plan: MissionPlan = {
	missionId: "m1",
	tier: "standard",
	goal: "g",
	acceptanceCriteria: [{ id: "AC1", text: "t", verify: "b1", covers: ["DW1"] }],
	milestones: [
		{
			id: "M1",
			title: "m",
			tasks: [
				{ id: "T1", title: "impl", verify: ["b1"] },
				{ id: "T2", title: "探针", kind: "spike", question: "q?", verify: [] },
			],
		},
	],
	verifyScript: "",
	createdAt: Date.now(),
};

function modelsData(): ModelsPageData {
	return {
		config: {
			planner: { provider: "anthropic", model: "opus", thinking: "high" },
			verifier: { provider: "openai", model: "不存在的模型" },
		},
		models: [{ provider: "anthropic", id: "opus" }],
		sessionLabel: "anthropic/opus",
		cost: { planner: 0.5 },
		activeRole: "planner",
		dirName: "missions",
	};
}

test("模型页的三种状态都不会用到不存在的颜色名", () => {
	const d = modelsData();
	const width = (s: string) => s.length;
	assert.doesNotThrow(() => modelRows(d, 0, strictTheme, width));
	assert.doesNotThrow(() => modelsFooter(d, strictTheme));
	assert.doesNotThrow(() => pickerRows(d.models, 0, d.config.planner, strictTheme));
	assert.doesNotThrow(() => pickerRows([], 0, undefined, strictTheme));
});

test("状态面板与 widget 的颜色名都合法(含 spike / define 相位)", () => {
	for (const phase of ["define", "plan", "do", "check", "act", "done", "halted"] as const) {
		const s = initialState({ missionId: "m1", tier: "standard", taskOrder: ["T1", "T2"] });
		s.phase = phase;
		s.currentTask = phase === "done" ? null : "T2";
		s.tasks.T2 = { ...s.tasks.T2, kind: "spike", status: "running", attempts: 1 };
		assert.doesNotThrow(() => renderWidgetCard(strictTheme, plan, s, Date.now(), 100), `widget @${phase}`);
		assert.doesNotThrow(() => overviewLines(plan, s), `overview @${phase}`);
		assert.doesNotThrow(() => taskLines(plan, s), `tasks @${phase}`);
		assert.doesNotThrow(() => taskBlocks(plan, s, strictTheme, 100), `taskBlocks @${phase}`);
	}
	assert.doesNotThrow(() => acLines(plan, { latest: {} }, "missions"));
});

test("任务详情页与状态视图在 strictTheme 下颜色名均合法", () => {
	const s = initialState({ missionId: "m1", tier: "standard", taskOrder: ["T1", "T2"] });
	s.phase = "do";
	s.currentTask = "T1";
	s.tasks.T1 = { ...s.tasks.T1, status: "failed", attempts: 2, sameSignatureCount: 1, lastFailureReason: "断言失败" };
	s.tasks.T2 = { ...s.tasks.T2, kind: "spike", status: "done", attempts: 1 };

	const detailDataT1 = {
		tier: "standard",
		task: plan.milestones[0].tasks[0],
		taskState: s.tasks.T1,
		milestone: plan.milestones[0],
		criteria: plan.acceptanceCriteria,
		attempts: [
			{
				taskId: "T1",
				attempt: 1,
				at: Date.now() - 30000,
				evidences: [
					{
						level: "hard" as const,
						acId: "AC1",
						result: "fail" as const,
						raw: "Error on auth",
						exitCode: 1,
						durationMs: 120,
						command: "npm test",
						stdout: "output",
						stderr: "error",
					},
				],
			},
		],
	};
	assert.doesNotThrow(() => renderTaskDetail(detailDataT1, strictTheme, 80));

	const detailDataSpike = {
		tier: "standard",
		task: plan.milestones[0].tasks[1],
		taskState: s.tasks.T2,
		milestone: plan.milestones[0],
		criteria: plan.acceptanceCriteria,
		attempts: [],
		spikeReport: "# Spike 结论\n可行性确认完毕。",
	};
	assert.doesNotThrow(() => renderTaskDetail(detailDataSpike, strictTheme, 80));

	const statusData = {
		plan,
		state: s,
		evidence: { latest: {} },
		taskEvidence: { T1: detailDataT1.attempts },
		spikeReports: { T2: detailDataSpike.spikeReport },
		checkState: {
			taskId: "T1",
			attempt: 2,
			startedAt: Date.now() - 2000,
			updatedAt: Date.now(),
			stage: "running_scripts" as const,
			currentBranch: "AC1",
			completedBranches: [{ acId: "lint", status: "pass" as const, durationMs: 100 }],
			verifier: { status: "pending" as const },
		},
		logLines: ["10:00 start", "10:01 fail"],
		dirName: "missions",
	};

	// 测试 mission 模式（含任务选中）
	assert.doesNotThrow(() =>
		renderStatus({
			theme: strictTheme,
			width: 80,
			rows: 30,
			now: Date.now(),
			data: statusData,
			focus: 1,
			scroll: [0, 0, 0],
			canResume: true,
			canAbort: true,
			mode: "mission",
			selectedTask: 0,
		}),
	);

	// 测试 task-detail 模式
	assert.doesNotThrow(() =>
		renderStatus({
			theme: strictTheme,
			width: 80,
			rows: 30,
			now: Date.now(),
			data: statusData,
			focus: 1,
			scroll: [0, 0, 0],
			canResume: true,
			mode: "task-detail",
			selectedTask: 0,
			taskDetailScroll: 0,
		}),
	);
});

test("计划评审页的五段在 strictTheme 下颜色名均合法", () => {
	const s = initialState({ missionId: "m1", tier: "complex", taskOrder: ["T1", "T2"] });
	s.phase = "plan";
	s.planReview = { rejections: 2, notes: ["AC2 不会红", "任务粒度太粗"] };

	const full: MissionPlan = {
		...plan,
		tier: "complex",
		definition: {
			constraints: ["不动 schema"],
			nonGoals: ["刷新令牌轮换"],
			doneWhen: [{ id: "DW1", text: "旧中间件不再被引用" }],
			verifySeam: "已有集成测试",
			resolved: [{ q: "问", a: "答" }],
			at: Date.now(),
		},
		approach: {
			summary: "引入 JwtProvider",
			decisions: [
				{ id: "D1", text: "不动 User 表", why: "爆炸半径", rejected: "建 token 表", sticky: true },
				{ id: "D2", text: "沿用中间件顺序", why: "限流" },
			],
		},
		acceptanceCriteria: [
			{ id: "AC1", text: "t", verify: "b1", covers: ["DW1"] },
			{ id: "AC2", text: "回归", verify: "b2", baseline: "green", covers: ["DW1"] },
		],
		verifyScript: '#!/usr/bin/env bash\ncase "$1" in\n  b1) exit 1 ;;\nesac\n',
	};

	for (const section of SECTION_IDS as ReviewSection[]) {
		for (const readOnly of [false, true]) {
			assert.doesNotThrow(
				() =>
					renderPlanReview({
						theme: strictTheme,
						width: 88,
						rows: 24,
						data: { plan: full, state: s },
						section,
						scroll: 0,
						readOnly,
					}),
				`renderPlanReview @${section} readOnly=${readOnly}`,
			);
		}
	}

	// 空数据路径(quick 档没有 definition、standard 可以没有 approach)也走一遍 —— 它们有各自的着色分支
	for (const section of SECTION_IDS as ReviewSection[]) {
		assert.doesNotThrow(
			() =>
				renderPlanReview({
					theme: strictTheme,
					width: 44,
					rows: 24,
					data: { plan, state: s },
					section,
					scroll: 0,
				}),
			`renderPlanReview 空数据 @${section}`,
		);
	}
});

test("DEFINE 问答页在 strictTheme 下颜色名均合法(含编辑态)", () => {
	const questions = [
		{ id: "Q1", text: "『快』指首屏还是接口?", options: ["首屏加载", "接口 p95"], recommend: "接口 p95", impact: "决定 DW1 口径" },
		{ id: "Q2", text: "允许改 schema 吗?", recommend: "不允许", impact: "决定方案分支" },
	];
	for (const qi of [0, 1]) {
		for (const editing of [false, true]) {
			assert.doesNotThrow(
				() =>
					renderAskReview({
						theme: strictTheme,
						width: 88,
						rows: 24,
						questions,
						qi,
						sel: [1, 0],
						draft: ["", "草稿"],
						editing,
						scroll: 0,
					}),
				`renderAskReview qi=${qi} editing=${editing}`,
			);
		}
	}
});

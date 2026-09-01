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
	acceptanceCriteria: [{ id: "AC1", text: "t", verify: "b1" }],
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

test("状态面板与 widget 的颜色名都合法(含 spike / frame 相位)", () => {
	for (const phase of ["frame", "plan", "do", "check", "act", "done", "halted"] as const) {
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

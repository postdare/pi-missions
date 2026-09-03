/**
 * pi-missions · 整页渲染的宽度不变式
 *
 * chrome.test.ts 测的是单个积木,这里测拼起来的整页。历史上炸 TUI 的都不是积木
 * 本身,而是拼装时差一列(盒顶右上角对不齐)、或某条内容行忘了截断。
 *
 * 不变式:
 *   ① 盒行(以 │/╭/╰/├ 开头的行)可见宽度**恰好** = width;
 *   ② 盒外提示条 ≤ width;
 *   ③ 任意页 / 任意宽度 / 任意选中态都成立,包括中文、长文本、空数据。
 *
 * 主题用真 ANSI:visibleWidth 会忽略转义序列,用可见字符模拟颜色会污染断言。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { initialState } from "../src/core/machine.ts";
import type { ScannedMission } from "../src/store/evidence.ts";
import type { MissionPlan } from "../src/store/mission.ts";
import { renderPanel } from "../src/ui/panel.ts";
import { renderStatus } from "../src/ui/status-view.ts";
import { renderPlanReview, SECTION_IDS, type ReviewSection } from "../src/ui/plan-review.ts";
import { renderAskReview } from "../src/ui/ask-review.ts";
import type { ModelsPageData } from "../src/ui/models-page.ts";

const theme = {
	fg: (_c: string, s: string) => `\x1b[31m${s}\x1b[0m`,
	bg: (_c: string, s: string) => `\x1b[44m${s}\x1b[49m`,
	bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

const WIDTHS = [40, 56, 64, 80, 96, 120, 200];
const NOW = 1_756_737_000_000;

function mission(id: string, goal: string, phase: string, tier: string, total: number, done: number): ScannedMission {
	const taskOrder = Array.from({ length: total }, (_, i) => `T${i + 1}`);
	const s = initialState({ missionId: id, tier: tier as never, taskOrder });
	s.phase = phase as never;
	s.currentTask = taskOrder[done] ?? null;
	for (const [i, tid] of taskOrder.entries()) {
		s.tasks[tid] = { ...s.tasks[tid], status: i < done ? "done" : i === done ? "running" : "pending", attempts: 2 };
	}
	if (s.currentTask) {
		s.tasks[s.currentTask] = {
			...s.tasks[s.currentTask],
			sameSignatureCount: 2,
			lastSignature: "9f2c1a4b7e30",
			lastFailureReason: "AuthIntegrationTest#refreshToken 断言失败,期望 200 实际 401",
		};
	}
	s.updatedAt = NOW - 3 * 60_000;
	s.cost = { planner: 0.41, executor: 1.2, verifier: 0.09 };
	s.pendingHandoff = phase === "act" ? "escalate L2 on T2" : null;
	s.escalation = { level: 2, history: [{ from: 1, to: 2, taskId: "T2", reason: "同一失败签名 ×3,序列化边界没对齐", at: NOW }] };
	const plan: MissionPlan = {
		missionId: id,
		tier: tier as never,
		goal,
		acceptanceCriteria: [
			{ id: "AC1", text: "登录链路集成测试全绿", verify: "auth-integration", covers: ["DW1"] },
			{ id: "AC2", text: "对外接口契约快照不变", verify: "contract-snapshot", baseline: "green", covers: ["DW2"] },
		],
		milestones: [
			{
				id: "M1",
				title: "鉴权切换",
				tasks: taskOrder.map((tid) => ({ id: tid, title: `任务 ${tid} 的标题可能很长很长很长`, verify: ["auth-integration"] })),
			},
		],
		verifyScript: "",
		createdAt: NOW - 60 * 60_000,
	};
	return { missionId: id, state: s, plan, stateDir: `/tmp/${id}` };
}

const MISSIONS = [
	mission("m-20260901-1402", "把登录鉴权从 session 迁移到 JWT,顺带清掉旧的 cookie 分支", "do", "standard", 4, 1),
	mission("m-20260901-1120", "CMS 管理端 REST 接口重构", "act", "complex", 9, 6),
	mission("m-20260831-2210", "修掉 verify.sh 在 CI 上的路径假设", "done", "quick", 1, 1),
	mission("m-20260831-1730", "把证据归档换成按 attempt 分目录", "halted", "standard", 5, 2),
];

const MODELS: ModelsPageData = {
	config: {
		planner: { provider: "anthropic", model: "claude-opus-5", thinking: "high" },
		verifier: { provider: "openai", model: "一个并不存在的超长模型名字用来撑爆列宽" },
	},
	models: [
		{ provider: "anthropic", id: "claude-opus-5", name: "Opus 5" },
		{ provider: "anthropic", id: "claude-sonnet-5", name: "Sonnet 5" },
		{ provider: "google", id: "gemini-3-pro" },
	],
	sessionLabel: "anthropic/claude-opus-5",
	cost: { planner: 0.412, executor: 1.203 },
	activeRole: "executor",
	dirName: "missions",
};

/** 盒行必须恰好铺满;其它行(提示条)不许超宽 */
function assertWidths(lines: string[], width: number, label: string): void {
	for (const [i, line] of lines.entries()) {
		const w = visibleWidth(line);
		const stripped = line.replace(/\x1b\[[0-9;]*m/g, "");
		if (/^[│╭╰├]/.test(stripped)) {
			assert.equal(w, width, `${label} 第 ${i} 行盒宽应为 ${width},实际 ${w}: ${JSON.stringify(stripped)}`);
		} else {
			assert.ok(w <= width, `${label} 第 ${i} 行超宽(${w} > ${width}): ${JSON.stringify(stripped)}`);
		}
	}
}

const panelBase = {
	theme,
	rows: 30,
	now: NOW,
	missions: MISSIONS,
	filter: "",
	selected: 0,
	detail: false,
	tierIdx: 1,
	roleIdx: 0,
	listScroll: 0,
	picking: null,
	models: MODELS,
	logTail: ["14:18 T2 a=1 verdict=FAIL ev=hard(auth-integration exit=1) sig=9f2c1a4b7e30"],
	page: "missions" as const,
};

test("renderPanel:任务页在各宽度/各选中态下都恰好铺满盒宽", () => {
	for (const width of WIDTHS) {
		for (const selected of [0, 1, 2, 4]) {
			for (const detail of [false, true]) {
				const r = renderPanel({ ...panelBase, width, selected, detail });
				assertWidths(r.lines, Math.max(40, width), `任务页 w=${width} sel=${selected} detail=${detail}`);
			}
		}
	}
});

test("renderPanel:筛选/空结果/无 mission 也不撑破", () => {
	for (const width of WIDTHS) {
		assertWidths(renderPanel({ ...panelBase, width, filter: "重构" }).lines, Math.max(40, width), `筛选 w=${width}`);
		assertWidths(renderPanel({ ...panelBase, width, filter: "不存在的东西" }).lines, Math.max(40, width), `空结果 w=${width}`);
		assertWidths(renderPanel({ ...panelBase, width, missions: [] }).lines, Math.max(40, width), `无 mission w=${width}`);
	}
});

test("renderPanel:模型页(含超长模型名)与选择器子模式都不撑破", () => {
	for (const width of WIDTHS) {
		const mw = Math.max(40, width);
		assertWidths(renderPanel({ ...panelBase, width, page: "models", roleIdx: 2 }).lines, mw, `模型页 w=${width}`);
		assertWidths(
			renderPanel({ ...panelBase, width, page: "models", picking: { role: "verifier", cursor: 1, filter: "cla" } }).lines,
			mw,
			`选择器 w=${width}`,
		);
		assertWidths(renderPanel({ ...panelBase, width, page: "models", models: null }).lines, mw, `无 runtime w=${width}`);
	}
});

test("renderPanel:选中行铺了背景色,未选中的 mission 行没有", () => {
	const r = renderPanel({ ...panelBase, width: 96, selected: 1 });
	const painted = r.lines.filter((x) => x.includes("\x1b[44m"));
	// 页签药丸 + 选中行,正好两处
	assert.equal(painted.length, 2, `带背景的行应为 2(页签 + 选中行),实际 ${painted.length}`);
	assert.ok(
		painted.some((x) => x.includes("session")),
		"选中的第 1 个 mission 必须是带背景的那一行",
	);
	assert.ok(!painted.some((x) => x.includes("CMS")), "未选中的 mission 行不许带背景");
});

test("面板里不出现贴边框的竖线 —— 那会被读成边框裂了一道", () => {
	for (const page of ["missions", "models"] as const) {
		for (const line of renderPanel({ ...panelBase, width: 96, page, selected: 1 }).lines) {
			const stripped = line.replace(/\x1b\[[0-9;]*m/g, "");
			// 详情展开的引导线是有意为之(挂在行下方,不贴边框),这里只查前 3 列
			assert.ok(!/^.{0,2}[▎▍▌┃]/.test(stripped), `${page} 页仍有贴边竖线: ${JSON.stringify(stripped)}`);
		}
	}
});

test("renderStatus:双栏与窄屏单栏在各宽度/各焦点/各任务选中态下都恰好铺满", () => {
	const d = {
		plan: MISSIONS[0].plan!,
		state: MISSIONS[0].state,
		evidence: {
			latest: {
				"auth-integration": {
					result: "fail" as const,
					level: "hard" as const,
					at: NOW,
					taskId: "T2",
					attempt: 2,
					rawTail: "AuthIntegrationTest#refreshToken FAILED\n  expected: 200 but was: 401",
				},
			},
		},
		taskEvidence: {
			T1: [{ taskId: "T1", attempt: 1, at: NOW - 60000, evidences: [{ level: "hard" as const, acId: "auth-integration", result: "pass" as const, raw: "OK", exitCode: 0 }] }],
			T2: [{ taskId: "T2", attempt: 1, at: NOW - 30000, evidences: [{ level: "hard" as const, acId: "auth-integration", result: "fail" as const, raw: "AssertionError: 401", exitCode: 1 }] }],
		},
		spikeReports: {},
		logLines: ["14:02 PLAN_FROZEN ac=2 tasks=4", "14:18 T2 a=1 verdict=FAIL sig=9f2c1a4b7e30"],
		dirName: "missions",
	};
	for (const width of WIDTHS) {
		for (const focus of [0, 1, 2] as const) {
			for (const selectedTask of [0, 1, 3]) {
				const lines = renderStatus({
					theme,
					width,
					rows: 30,
					now: NOW,
					data: d,
					focus,
					scroll: [0, 0, 0],
					canResume: true,
					mode: "mission",
					selectedTask,
				});
				assertWidths(lines, Math.max(56, width), `status w=${width} focus=${focus} selTask=${selectedTask}`);
			}
		}
	}
});

test("renderStatus:任务详情页在各宽度/滚动偏移下都恰好铺满", () => {
	const state = structuredClone(MISSIONS[0].state);
	state.phase = "check";
	const d = {
		plan: MISSIONS[0].plan!,
		state,
		evidence: { latest: {} },
		taskEvidence: {
			T2: [
				{
					taskId: "T2",
					attempt: 1,
					at: NOW - 60000,
					evidences: [{
						level: "hard" as const,
						acId: "auth-integration",
						result: "fail" as const,
						raw: "Error on line 10\nStack trace\nMore info",
						exitCode: 1,
						command: "bash missions/scripts/verify.sh auth-integration",
						startedAt: NOW - 60_000,
						durationMs: 12_345,
						stdout: "超长完整标准输出 ".repeat(20),
						stderr: "超长完整错误输出 ".repeat(20),
					}],
				},
				{
					taskId: "T2",
					attempt: 2,
					at: NOW - 10000,
					evidences: [{ level: "hard" as const, acId: "auth-integration", result: "fail" as const, raw: "Second failure on refresh token", exitCode: 1 }],
				},
			],
		},
		checkState: {
			taskId: "T2",
			attempt: 2,
			startedAt: NOW - 5000,
			updatedAt: NOW,
			stage: "running_verifier" as const,
			completedBranches: [{ acId: "auth-integration", status: "fail" as const, durationMs: 1234 }],
			verifier: { status: "running" as const, startedAt: NOW - 1000 },
		},
		spikeReports: {},
		logLines: [],
		dirName: "missions",
	};
	for (const width of WIDTHS) {
		for (const selectedTask of [0, 1]) {
			for (const taskDetailScroll of [0, 5, 20]) {
				const lines = renderStatus({
					theme,
					width,
					rows: 30,
					now: NOW,
					data: d,
					focus: 1,
					scroll: [0, 0, 0],
					canResume: true,
					mode: "task-detail",
					selectedTask,
					taskDetailScroll,
				});
				assertWidths(lines, Math.max(56, width), `taskDetail w=${width} sel=${selectedTask} scroll=${taskDetailScroll}`);
			}
		}
	}
});

test("状态页与任务详情页不出现贴边框竖线", () => {
	const d = {
		plan: MISSIONS[0].plan!,
		state: MISSIONS[0].state,
		evidence: { latest: {} },
		taskEvidence: {
			T1: [{ taskId: "T1", attempt: 1, at: NOW, evidences: [{ level: "hard" as const, acId: "auth-integration", result: "pass" as const, raw: "ok" }] }],
		},
		spikeReports: {},
		logLines: ["line 1", "line 2"],
		dirName: "missions",
	};
	for (const mode of ["mission", "task-detail"] as const) {
		const lines = renderStatus({
			theme,
			width: 96,
			rows: 30,
			now: NOW,
			data: d,
			focus: 1,
			scroll: [0, 0, 0],
			canResume: true,
			mode,
			selectedTask: 0,
		});
		for (const line of lines) {
			const stripped = line.replace(/\x1b\[[0-9;]*m/g, "");
			assert.ok(!/^.{0,2}[▎▍▌┃]/.test(stripped), `${mode} 模式下仍有贴边竖线: ${JSON.stringify(stripped)}`);
		}
	}
});

test("renderStatus: canSteer 显示补充指令提示,canResume=false 隐藏恢复入口", () => {
	const d = {
		plan: MISSIONS[0].plan!,
		state: { ...MISSIONS[0].state, phase: "check" as const },
		evidence: { latest: {} },
		taskEvidence: {},
		spikeReports: {},
		checkState: {
			taskId: "T1",
			attempt: 1,
			startedAt: NOW,
			updatedAt: NOW,
			stage: "running_verifier" as const,
			completedBranches: [],
			verifier: { status: "running" as const, startedAt: NOW, activity: "独立核验中" },
		},
		logLines: ["line 1"],
		dirName: "missions",
	};
	const strip = (lines: string[]) => lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, "")).join("\n");

	const steered = strip(
		renderStatus({ theme, width: 96, rows: 24, now: NOW, data: d, focus: 0, scroll: [0, 0, 0], canResume: false, canSteer: true }),
	);
	assert.ok(steered.includes("补充指令"), "Verifier 运行中应显示 S 补充指令");
	assert.ok(!steered.includes("Ctrl+R"), "不可恢复的 mission 不显示恢复入口");

	const plain = strip(
		renderStatus({ theme, width: 96, rows: 24, now: NOW, data: d, focus: 0, scroll: [0, 0, 0], canResume: true, canSteer: false }),
	);
	assert.ok(!plain.includes("补充指令"), "Verifier 未运行时不显示补充指令");
	assert.ok(plain.includes("Ctrl+R"), "可恢复时要显示恢复入口");
});

const REVIEW_PLAN: MissionPlan = {
	...MISSIONS[0].plan!,
	definition: {
		constraints: ["不改数据库 schema", "必须兼容仍在用旧 cookie 的移动端"],
		nonGoals: ["刷新令牌轮换", "多端登出"],
		doneWhen: [
			{ id: "DW1", text: "旧 session 中间件不再被任何路由引用" },
			{ id: "DW2", text: "现有登录用例全绿,且不需要改断言 —— 这条完成条件写得特别长是为了逼出折行" },
		],
		verifySeam: "已有集成测试 test/auth/*.test.ts",
		resolved: [{ q: "『快』指首屏还是接口?", a: "接口,p95 口径" }],
		at: NOW,
	},
	approach: {
		summary: "引入 JwtProvider 收口签发与校验;中间件保留旧路径读旧 cookie,直到移动端跟上再删。",
		decisions: [
			{ id: "D1", text: "不动 User 表,令牌里只放 sub+exp", why: "加一张 token 表会把这次改动的爆炸半径扩到迁移脚本", rejected: "建 token 表做服务端吊销", sticky: true },
			{ id: "D2", text: "沿用现有中间件顺序", why: "改顺序会牵动限流" },
		],
	},
	acceptanceCriteria: [
		{ id: "AC1", text: "登录链路集成测试全绿", verify: "auth-integration", covers: ["DW1", "DW2"] },
		{ id: "AC2", text: "对外接口契约快照不变", verify: "contract-snapshot", baseline: "green", covers: ["DW2"] },
	],
	verifyScript:
		'#!/usr/bin/env bash\nset -euo pipefail\ncase "$1" in\n  auth-integration) npm test -- test/auth 这一行故意写得很长很长很长很长很长很长很长很长 ;;\n  contract-snapshot) npm run contract:check ;;\n  *) echo "unknown: $1" >&2; exit 2 ;;\nesac\n',
};

function reviewState(rejections: number) {
	const st = structuredClone(MISSIONS[0].state);
	st.phase = "plan" as never;
	if (rejections > 0) {
		st.planReview = {
			rejections,
			notes: ["AC2 那条根本不会红,换个能判别的写法", "任务粒度太粗了,T1 一个人做不完一个上下文"],
		};
	}
	return st;
}

test("renderPlanReview:五段 × 各宽度 × 各滚动位置都恰好铺满", () => {
	for (const width of WIDTHS) {
		for (const section of SECTION_IDS as ReviewSection[]) {
			for (const scroll of [0, 3, 999]) {
				for (const rejections of [0, 2]) {
					const r = renderPlanReview({
						theme,
						width,
						rows: 30,
						data: { plan: REVIEW_PLAN, state: reviewState(rejections) },
						section,
						scroll,
					});
					assertWidths(r.lines, Math.max(40, width), `review w=${width} sec=${section} scroll=${scroll} rej=${rejections}`);
				}
			}
		}
	}
});

test("renderPlanReview:空方案 / 空 AC / 空脚本 / quick 档无 definition 也不撑破", () => {	const bare: MissionPlan = {
		...MISSIONS[0].plan!,
		definition: undefined,
		approach: undefined,
		acceptanceCriteria: [],
		milestones: [],
		verifyScript: "",
	};
	for (const width of WIDTHS) {
		for (const section of SECTION_IDS as ReviewSection[]) {
			const r = renderPlanReview({
				theme,
				width,
				rows: 24,
				data: { plan: bare, state: reviewState(0) },
				section,
				scroll: 0,
			});
			assertWidths(r.lines, Math.max(40, width), `bare review w=${width} sec=${section}`);
		}
	}
});

test("renderPlanReview:只读模式不给批准/打回入口,评审模式给", () => {
	const data = { plan: REVIEW_PLAN, state: reviewState(1) };
	const ro = renderPlanReview({ theme, width: 96, rows: 24, data, section: "scope", scroll: 0, readOnly: true }).lines.join("\n");
	assert.ok(!ro.includes("批准冻结"));
	assert.ok(!ro.includes("打回并写意见"));
	assert.ok(!ro.includes("上次打回"), "只读查看不是评审现场,不该翻旧账");

	const rw = renderPlanReview({ theme, width: 96, rows: 24, data, section: "scope", scroll: 0 }).lines.join("\n");
	assert.ok(rw.includes("批准冻结"));
	assert.ok(rw.includes("打回 1/3"), "打回次数要摆在盒顶");
	assert.ok(rw.includes("上次打回"), "人最想知道的是'我上次说的改了没有'");
});

test("renderPlanReview:verify.sh 全文可见 —— 不给看它,评审就是走过场", () => {
	const r = renderPlanReview({
		theme,
		width: 120,
		rows: 30,
		data: { plan: REVIEW_PLAN, state: reviewState(0) },
		section: "script",
		scroll: 0,
	});
	const text = r.lines.join("\n");
	assert.ok(text.includes("contract:check"));
	assert.ok(text.includes("auth-integration)"));
});

test("计划评审页不出现贴边框竖线", () => {
	for (const section of SECTION_IDS as ReviewSection[]) {
		for (const line of renderPlanReview({
			theme,
			width: 96,
			rows: 24,
			data: { plan: REVIEW_PLAN, state: reviewState(2) },
			section,
			scroll: 0,
		}).lines) {
			const stripped = line.replace(/\x1b\[[0-9;]*m/g, "");
			if (!/^[│╭╰├]/.test(stripped)) continue;
			assert.ok(!/^.{0,2}[▎▍▌┃]/.test(stripped), `${section} 段仍有贴边竖线: ${JSON.stringify(stripped)}`);
		}
	}
});

test("renderStatus:无活动 mission 时也铺满", () => {
	for (const width of WIDTHS) {
		const lines = renderStatus({ theme, width, rows: 24, now: NOW, data: null, focus: 0, scroll: [0, 0, 0], canResume: false, canAbort: false });
		assertWidths(lines, Math.max(56, width), `空 status w=${width}`);
	}
});

test("renderStatus: 支持 canAbort 与 canResume 组合且宽度安全", () => {
	const d = {
		plan: MISSIONS[0].plan!,
		state: MISSIONS[0].state,
		evidence: { latest: {} },
		taskEvidence: {},
		spikeReports: {},
		logLines: ["line 1", "line 2"],
		dirName: "missions",
	};
	for (const width of WIDTHS) {
		for (const canResume of [false, true]) {
			for (const canAbort of [false, true]) {
				const lines = renderStatus({
					theme,
					width,
					rows: 24,
					now: NOW,
					data: d,
					focus: 0,
					scroll: [0, 0, 0],
					canResume,
					canAbort,
				});
				assertWidths(lines, Math.max(56, width), `status w=${width} resume=${canResume} abort=${canAbort}`);
			}
		}
	}
});

// ─────────────── DEFINE 问答页 ───────────────

const ASK_QUESTIONS = [
	{
		id: "Q1",
		text: "『快』指首屏还是接口?",
		options: [
			"首屏加载",
			{ label: "接口 p95", preview: "┌──────┐   ┌────────────┐   ┌──────┐\n│ 请求 │──▶│ API · p95   │──▶│ 数据 │\n└──────┘   │   < 300ms    │   └──────┘\n           └────────────┘", },
		],
		recommend: "接口 p95",
		impact: "决定 DW1 的度量口径",
	},
	{
		id: "Q2",
		text: "目标多少毫秒?这条问题措辞故意拉长一些,验证题干折行之后盒宽仍然恰好铺满、选中行高亮不断开。",
		recommend: "p95 < 300ms",
		impact: "决定 DW1 的阈值",
	},
];

function askBase(over: Partial<Parameters<typeof renderAskReview>[0]> = {}) {
	return {
		theme,
		width: 96,
		rows: 30,
		questions: ASK_QUESTIONS,
		qi: 0,
		sel: [1, 0],
		draft: ["", ""],
		editing: false,
		scroll: 0,
		...over,
	} as Parameters<typeof renderAskReview>[0];
}

test("renderAskReview:各题 × 各宽 × 选中/编辑态都恰好铺满", () => {
	for (const width of WIDTHS) {
		for (const qi of [0, 1]) {
			for (const editing of [false, true]) {
				for (const scroll of [0, 3, 999]) {
					const r = renderAskReview(askBase({ width, qi, editing, scroll }));
					assertWidths(r.lines, Math.max(40, width), `ask w=${width} qi=${qi} edit=${editing} scroll=${scroll}`);
				}
			}
		}
	}
});

test("renderAskReview:无选项的开放式问题也铺满(推荐项本身成为唯一可选行)", () => {
	const r = renderAskReview(askBase({ questions: [ASK_QUESTIONS[1]], qi: 0, sel: [0] }));
	assertWidths(r.lines, 96, "ask 开放题");
});

test("问答页不出现贴边框竖线", () => {
	for (const qi of [0, 1]) {
		for (const line of renderAskReview(askBase({ qi })).lines) {
			const stripped = line.replace(/\x1b\[[0-9;]*m/g, "");
			if (!/^[│╭╰├]/.test(stripped)) continue;
			assert.ok(!/^.{0,2}[▎▍▌┃]/.test(stripped), `问答页仍有贴边竖线: ${JSON.stringify(stripped)}`);
		}
	}
});

test("问答页短题列表也铺满(盒高不随题跳动)", () => {
	for (const width of WIDTHS) {
		const r = renderAskReview(askBase({ width, questions: [ASK_QUESTIONS[0]], qi: 0, sel: [0] }));
		assertWidths(r.lines, Math.max(40, width), `ask 短题 w=${width}`);
	}
});

// ── DEFINE 范围确认页 ──

import { renderDefineReview } from "../src/ui/define-review.ts";

const DEFINE_DEF = {
	constraints: ["不动 User 表", "沿用现有中间件顺序"],
	nonGoals: ["不做 refresh token 轮换", "不做多端登录互踢"],
	doneWhen: [
		{ id: "DW1", text: "access token 过期前 60s 内自动刷新,集成测试覆盖刷新竞态" },
		{ id: "DW2", text: "刷新失败时降级到登录页,且不丢当前路由的 query 参数" },
		{ id: "DW3", text: "这一行故意写得非常长,验证窄终端下折行与悬挂缩进的表现是否正确——它应该被 wrap 而不是截断" },
	],
	verifySeam: "已有集成测试 test/auth/*",
	resolved: [{ q: "令牌里放什么?", a: "只放 sub+exp(推荐)" }],
	at: 0,
};

test("renderDefineReview:各段聚焦 × 各宽 × 各滚动 × 编辑态都恰好铺满", () => {
	for (const width of WIDTHS) {
		for (const focus of [0, 3, 5]) {
			for (const scroll of [0, 3, 999]) {
				for (const editing of [false, true]) {
					const r = renderDefineReview({
						theme,
						width,
						rows: 30,
						goal: "把登录页的会话过期处理改成静默续期,过期后用户无感知,不再弹登录框",
						definition: DEFINE_DEF,
						focus,
						editing,
						draft: "DW2 那条根本判不了,写清楚怎么测",
						scroll,
					});
					assertWidths(r.lines, Math.max(40, width), `define w=${width} focus=${focus} scroll=${scroll} edit=${editing}`);
				}
			}
		}
	}
});

test("renderDefineReview:空段不撑破,占位行可见", () => {
	const r = renderDefineReview({
		theme,
		width: 96,
		rows: 24,
		goal: "",
		definition: { constraints: [], nonGoals: [], doneWhen: [], verifySeam: undefined, resolved: [], at: 0 },
		focus: 4,
		editing: false,
		draft: "",
		scroll: 0,
	});
	assertWidths(r.lines, 96, "define 空段");
	assert.ok(r.lines.join("\n").includes("(未声明)"), "空段落要有占位,人得知道是'没有'而不是'忘了展示'");
});

test("DEFINE 范围确认页不出现贴边框竖线", () => {
	for (const line of renderDefineReview({
		theme,
		width: 96,
		rows: 24,
		goal: "把登录页改成静默续期",
		definition: DEFINE_DEF,
		focus: 0,
		editing: false,
		draft: "",
		scroll: 0,
	}).lines) {
		const stripped = line.replace(/\x1b\[[0-9;]*m/g, "");
		if (!/^[│╭╰├]/.test(stripped)) continue;
		assert.ok(!/^.{0,2}[▎▍▌┃]/.test(stripped), `范围确认页仍有贴边竖线: ${JSON.stringify(stripped)}`);
	}
});

test("renderAskReview:选项 preview 区逐行 clip 不折行,字符画列对齐保持", () => {
	for (const width of WIDTHS) {
		const r = renderAskReview(askBase({ width, sel: [1, 0] }));
		assertWidths(r.lines, Math.max(40, width), `ask preview w=${width}`);
		const text = r.lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
		assert.ok(text.includes("选中示意 · 接口 p95"), "选中带 preview 的选项时展示图区");
	}
	// 切到无 preview 的选项(首屏加载,纯字符串):不画图区
	const r2 = renderAskReview(askBase({ width: 96, sel: [0, 0] }));
	const t2 = r2.lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
	assert.ok(!t2.includes("选中示意"), "无 preview 的选项不画图区");
});

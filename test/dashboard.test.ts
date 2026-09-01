import { test } from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { overviewLines, PHASE_STYLE, renderWidgetCard, renderStatusDashboard, taskBlocks, taskLines } from "../src/ui/dashboard.ts";
import { initialState } from "../src/core/machine.ts";
import type { MissionPlan } from "../src/store/mission.ts";

const plan: MissionPlan = {
	missionId: "auth-refactor",
	tier: "standard",
	goal: "迁移登录鉴权到 JWT",
	acceptanceCriteria: [
		{ id: "AC1", text: "登录链路集成测试全绿", verify: "auth-integration" },
		{ id: "AC2", text: "接口契约不变", verify: "contract-snapshot" },
	],
	milestones: [
		{
			id: "M1",
			title: "m",
			tasks: [
				{ id: "T1", title: "引入 JwtProvider", verify: ["compile"] },
				{ id: "T2", title: "迁移登录端点", verify: ["auth-integration"] },
			],
		},
	],
	verifyScript: "#!/usr/bin/env bash\n",
	createdAt: Date.now() - 5 * 60_000,
};

function runningState(): ReturnType<typeof initialState> {
	const s = initialState({ missionId: "auth-refactor", tier: "standard", taskOrder: ["T1", "T2"] });
	s.phase = "do";
	s.currentTask = "T2";
	s.tasks.T1 = { ...s.tasks.T1, status: "done", attempts: 1 };
	s.tasks.T2 = {
		...s.tasks.T2,
		status: "running",
		attempts: 2,
		lastSignature: "abc123",
		sameSignatureCount: 2,
		lastFailureReason: "AuthIntegrationTest#refreshToken 断言失败",
	};
	s.envFingerprint = "sha256:9f2c";
	s.cost = { executor: 0.87, verifier: 0.09 };
	return s;
}

// 模拟主题:fg 记录颜色但不注入可见标记(否则 visibleWidth 会把标记当字符,截断测试失真)
const usedColors: string[] = [];
const mockTheme = {
	fg: (color: string, s: string) => {
		usedColors.push(color);
		return s;
	},
	bold: (s: string) => s,
};

test("widget:身份/进度/成本/熔断预警(多任务才显示进度条)", () => {
	usedColors.length = 0;
	const lines = renderWidgetCard(mockTheme, plan, runningState(), Date.now(), 120);
	assert.ok(lines[0].includes("auth-refactor"));
	assert.ok(lines[0].includes("standard"));
	assert.ok(lines[0].includes("● 执行"), "相位显示成带图标的中文,不是 phase=do");
	assert.ok(lines[1].includes("T2"));
	assert.ok(lines[1].includes("attempt 2/3"));
	assert.ok(lines[1].includes("1/2")); // 多任务:进度条在第二行
	assert.ok(lines[0].includes("$0.96"), "成本右对齐在行 1");
	assert.ok(lines.some((l) => l.includes("同一失败签名 ×2")), "熔断临界必须可见");
	// 临界 attempt 与预警都用了 warning 色
	assert.ok(usedColors.includes("warning"));
	// mission id 用了 accent
	assert.ok(usedColors.includes("accent"));
});

test("widget:单任务(quick)不显示进度条,零成本/零时长不显示", () => {
	const s = initialState({ missionId: "quick-x", tier: "quick", taskOrder: ["T1"] });
	s.phase = "do";
	s.currentTask = "T1";
	s.tasks.T1 = { ...s.tasks.T1, status: "running", attempts: 1 };
	const p: MissionPlan = {
		missionId: "quick-x",
		tier: "quick",
		goal: "x",
		acceptanceCriteria: [],
		milestones: [{ id: "M1", title: "m", tasks: [{ id: "T1", title: "本周天气如何呢", verify: [] }] }],
		verifyScript: "",
		createdAt: Date.now(),
	};
	const lines = renderWidgetCard(mockTheme, p, s, Date.now(), 120);
	assert.ok(!lines.some((l) => l.includes("░")), "单任务不显示进度条");
	assert.ok(!lines.some((l) => l.includes("$0")), "零成本不显示");
	assert.ok(!lines.some((l) => l.includes("0min")), "零时长不显示");
	assert.ok(lines[1].includes("本周天气如何呢"));
	assert.ok(lines[1].includes("attempt 1/2"));
});

test("widget:右对齐时长/成本;换脑挂起警告色", () => {
	usedColors.length = 0;
	const s = runningState();
	s.pendingHandoff = "escalate L2 on T2";
	const lines = renderWidgetCard(mockTheme, plan, s, plan.createdAt + 5 * 60_000, 120);
	// 行 1 有填充使成本靠右:总可见宽度 = 120
	assert.equal(visibleWidth(lines[0]), 120);
	assert.ok(lines[0].trimEnd().endsWith("$0.96")); // 成本在最右
	assert.ok(lines.some((l) => l.includes("/mission next")));
	assert.ok(usedColors.includes("warning")); // 换脑提示是警告色
});

test("dashboard:任务清单 + AC 证据状态 + 成本分账 + 日志", () => {
	const out = renderStatusDashboard(
		plan,
		runningState(),
		{ latest: { "auth-integration": { result: "fail", level: "hard", at: 1 } } },
		["10:22 T2 a=1 verdict=FAIL ev=refreshToken断言"],
		"missions",
	);
	assert.ok(out.includes("迁移登录鉴权到 JWT"));
	assert.ok(out.includes("✓ T1"));
	assert.ok(out.includes("▸ T2"));
	assert.ok(out.includes("上次失败: AuthIntegrationTest#refreshToken"));
	assert.ok(out.includes("✗ AC1"), "AC1 有失败证据应标 ✗");
	assert.ok(out.includes("AC2") && out.includes("尚无证据"), "无证据的 AC 必须明示");
	assert.ok(out.includes("executor $0.870"));
	assert.ok(out.includes("verdict=FAIL"));
});

test("taskBlocks 与 taskLines 输出一致且结构化切分准确", () => {
	const s = runningState();
	const blocks = taskBlocks(plan, s, mockTheme, 80);
	assert.equal(blocks.length, 2);
	assert.equal(blocks[0].taskId, "T1");
	assert.equal(blocks[1].taskId, "T2");

	// 展平 blocks 必须与 taskLines 完全一致
	const flat = blocks.flatMap((b) => b.lines);
	const direct = taskLines(plan, s, mockTheme, 80);
	assert.deepEqual(flat, direct);
});

test("taskBlocks: complex 多里程碑下标题正确归入首个任务块", () => {
	const complexPlan: MissionPlan = {
		missionId: "complex-m",
		tier: "complex",
		goal: "重构",
		acceptanceCriteria: [{ id: "AC1", text: "t", verify: "b1" }],
		milestones: [
			{ id: "M1", title: "第一阶段", tasks: [{ id: "T1", title: "t1", verify: ["b1"] }, { id: "T2", title: "t2", verify: ["b1"] }] },
			{ id: "M2", title: "第二阶段", tasks: [{ id: "T3", title: "t3", verify: ["b1"] }] },
		],
		verifyScript: "",
		createdAt: Date.now(),
	};
	const s = initialState({ missionId: "complex-m", tier: "complex", taskOrder: ["T1", "T2", "T3"] });
	const blocks = taskBlocks(complexPlan, s, mockTheme, 80);
	assert.equal(blocks.length, 3);
	// M1 标题在 T1
	assert.ok(blocks[0].lines.some((l) => l.includes("M1 第一阶段")));
	assert.ok(!blocks[1].lines.some((l) => l.includes("M1 第一阶段")));
	// M2 标题在 T3
	assert.ok(blocks[2].lines.some((l) => l.includes("M2 第二阶段")));

	const flat = blocks.flatMap((b) => b.lines);
	const direct = taskLines(complexPlan, s, mockTheme, 80);
	assert.deepEqual(flat, direct);
});

test("相位图标只用好渲染的那几个字形(◌ ◍ ◑ 会被渲染成大圆盘)", () => {
	const bad = ["◌", "◍", "◑", "◐", "◒", "◓", "⬤"];
	for (const [phase, st] of Object.entries(PHASE_STYLE)) {
		assert.ok(!bad.includes(st.icon), `${phase} 用了会糊掉的字形 ${st.icon}`);
		assert.equal(visibleWidth(st.icon), 1, `${phase} 的图标必须是 1 列宽`);
	}
});

test("概览:目标折行不截断;不显示会话文件名这类机器字符串", () => {
	const longGoal =
		"新增 Antix (antigma.ai) AI 额度 widget:像 DeepSeek 一样显示账户余额,支持在 NewTab 里添加,并复用现有 QuotaWidget 的外观与刷新策略";
	const p2: MissionPlan = { ...plan, goal: longGoal };
	const s = runningState();
	s.sessionMap = { T1: "/x/2026-09-01T03-47-31-939Z_01a05b14-4be3-7f5d.jsonl" };
	const width = 48;
	const lines = overviewLines(p2, s, { width, omitIdentity: true });
	for (const l of lines) assert.ok(visibleWidth(l) <= width, `概览行超宽: ${l}`);
	// 目标必须完整出现(拼掉悬挂缩进后)
	const joined = lines.map((l) => l.trim()).join("");
	assert.ok(joined.includes("刷新策略"), "目标的结尾被截掉了");
	assert.ok(!lines.some((l) => l.includes(".jsonl")), "会话文件名不该占概览的行");
	// omitIdentity:盒标题/头行已经给过的东西不再重复
	assert.ok(!lines.some((l) => l.includes("mission ")), "身份行应由调用方决定是否显示");
});

test("概览:非 TUI 扁平卡片仍要带上身份与进度(没有盒标题兜底)", () => {
	const lines = overviewLines(plan, runningState(), {});
	assert.ok(lines.some((l) => l.includes("auth-refactor")), "扁平形态必须自带 mission id");
	assert.ok(lines.some((l) => l.includes("任务")), "扁平形态必须自带进度");
});

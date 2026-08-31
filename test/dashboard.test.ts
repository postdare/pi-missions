import { test } from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { renderWidgetCard, renderStatusDashboard } from "../src/ui/dashboard.ts";
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
	assert.ok(lines[0].includes("phase=do"));
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
	assert.ok(out.includes("▶ T2"));
	assert.ok(out.includes("上次失败: AuthIntegrationTest#refreshToken"));
	assert.ok(out.includes("✗ AC1"), "AC1 有失败证据应标 ✗");
	assert.ok(out.includes("AC2") && out.includes("尚无证据"), "无证据的 AC 必须明示");
	assert.ok(out.includes("executor=$0.870"));
	assert.ok(out.includes("verdict=FAIL"));
});

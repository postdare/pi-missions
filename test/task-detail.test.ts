import { test } from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { renderTaskDetail, type TaskDetailData } from "../src/ui/task-detail.ts";

const mockTheme = {
	fg: (_color: string, s: string) => s,
	bg: (_color: string, s: string) => s,
	bold: (s: string) => s,
};

test("renderTaskDetail: 普通任务展示定义、状态、AC、全部 attempt 证据", () => {
	const data: TaskDetailData = {
		task: {
			id: "T1",
			title: "实现 JWT 鉴权校验中间件以及配套路由拦截器",
			verify: ["auth-integration", "lint"],
		},
		taskState: {
			id: "T1",
			status: "running",
			attempts: 2,
			lastSignature: "sig_abc123",
			sameSignatureCount: 2,
			lastFailureReason: "AssertionError: expected 200 OK but received 401 Unauthorized at JwtMiddlewareTest.ts:42",
			inconclusiveStreak: 0,
		},
		milestone: {
			id: "M1",
			title: "基础中间件改造",
			tasks: [],
		},
		criteria: [
			{ id: "AC1", text: "所有受保护的路由必须正确校验 JWT Token", verify: "auth-integration", baseline: "red" },
			{ id: "AC2", text: "代码通过 ESLint 检查", verify: "lint", baseline: "green" },
		],
		attempts: [
			{
				taskId: "T1",
				attempt: 1,
				at: 1756737000000,
				evidences: [
					{ level: "hard", acId: "lint", result: "pass", raw: "0 errors", exitCode: 0 },
					{ level: "hard", acId: "auth-integration", result: "fail", raw: "FAILED at JwtMiddlewareTest:42\nError stack trace here", exitCode: 1 },
				],
			},
			{
				taskId: "T1",
				attempt: 2,
				at: 1756737060000,
				evidences: [
					{ level: "hard", acId: "lint", result: "pass", raw: "0 errors", exitCode: 0 },
					{ level: "hard", acId: "auth-integration", result: "fail", raw: "FAILED at JwtMiddlewareTest:42\nsecond try", exitCode: 1 },
				],
			},
		],
		tier: "standard",
	};

	const lines = renderTaskDetail(data, mockTheme, 80);
	const joined = lines.join("\n");

	assert.ok(joined.includes("任务定义 [T1]"));
	assert.ok(joined.includes("实现 JWT 鉴权校验中间件"));
	assert.ok(joined.includes("M1 基础中间件改造"));
	assert.ok(joined.includes("attempt 2/3"));
	assert.ok(joined.includes("sig_abc123"));
	assert.ok(joined.includes("同一签名连续 2 次"));
	assert.ok(joined.includes("AssertionError"));
	assert.ok(joined.includes("AC1"));
	assert.ok(joined.includes("所有受保护的路由必须正确校验"));
	assert.ok(joined.includes("Attempt 1"));
	assert.ok(joined.includes("Attempt 2"));
	assert.ok(joined.includes("Error stack trace here"));

	for (const [i, l] of lines.entries()) {
		assert.ok(visibleWidth(l) <= 80, `行 ${i} 超宽: ${l}`);
	}
});

test("renderTaskDetail: Spike 任务展示核心问题与书面结论", () => {
	const data: TaskDetailData = {
		task: {
			id: "T2",
			title: "探针: 调研现有 session 存储在集群下的多节点同步机制",
			kind: "spike",
			question: "Redis 集群在跨机房网络分区时如何保证 session 互斥性？",
			verify: [],
		},
		taskState: {
			id: "T2",
			status: "done",
			attempts: 1,
			sameSignatureCount: 0,
			inconclusiveStreak: 0,
		},
		criteria: [],
		attempts: [],
		spikeReport: "# 结论\n\n通过 Redlock 机制无法完全避免脑裂，建议引入 etcd 分布式锁作为协调层。\n- 推荐方案 A\n- 备选方案 B",
		tier: "standard",
	};

	const lines = renderTaskDetail(data, mockTheme, 70);
	const joined = lines.join("\n");

	assert.ok(joined.includes("spike (探针任务)"));
	assert.ok(joined.includes("Redis 集群在跨机房网络分区时如何保证 session 互斥性？"));
	assert.ok(joined.includes("Spike 书面结论"));
	assert.ok(joined.includes("通过 Redlock 机制无法完全避免脑裂"));
	assert.ok(joined.includes("暂无执行证据记录"));

	for (const [i, l] of lines.entries()) {
		assert.ok(visibleWidth(l) <= 70, `行 ${i} 超宽: ${l}`);
	}
});

test("renderTaskDetail: 空状态与缺失字段容错", () => {
	const data: TaskDetailData = {
		task: {
			id: "T3",
			title: "空任务",
			verify: [],
		},
		criteria: [],
		attempts: [],
	};

	const lines = renderTaskDetail(data, mockTheme, 60);
	const joined = lines.join("\n");

	assert.ok(joined.includes("任务定义 [T3]"));
	assert.ok(joined.includes("待开始"));
	assert.ok(joined.includes("impl (代码实现)"));
	assert.ok(joined.includes("attempt 0/3"));
	assert.ok(joined.includes("暂无执行证据记录"));
	assert.ok(joined.includes("无指定 verify 分支"));

	for (const [i, l] of lines.entries()) {
		assert.ok(visibleWidth(l) <= 60, `行 ${i} 超宽: ${l}`);
	}
});

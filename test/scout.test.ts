/**
 * pi-missions · roles/scout 的执行侧测试
 *
 * 这里锁的是三条纪律,每一条都对应 ARCHITECTURE 8.7 的判据或一个具体的坏结局:
 *   1. 白名单里没有 bash/edit/write —— 能写工作区的子 agent 一律不做
 *   2. 一路挂掉不拖累其他路 —— 否则并行等于没并行
 *   3. 没有出处的结论降级为"未查明" —— 否则它会被当成核实过的事实写进 AC
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { runScouts, SCOUT_TOOLS, type CreateScoutSession } from "../src/roles/scout.ts";
import type { ScoutQuestion } from "../src/core/scout.ts";

const Q = (id: string, assume = "假设 " + id): ScoutQuestion => ({
	id,
	text: `问题 ${id}`,
	why: "决定任务怎么拆",
	assume,
});

const options = {
	cwd: "/tmp",
	model: { provider: "test", id: "scout" },
	thinkingLevel: "low",
	timeoutMs: 1000,
	goal: "把旧 ORM 换掉",
	questions: [] as ScoutQuestion[],
};

/** 按简报里出现的问题 id 分流的假 session 工厂 */
function fake(behavior: Record<string, (onFinding: (v: unknown) => void) => Promise<void> | void>): CreateScoutSession {
	return async ({ onFinding }) => ({
		subscribe: () => () => {},
		prompt: async (text: string) => {
			const id = Object.keys(behavior).find((k) => text.includes(`(${k})`));
			if (id) await behavior[id](onFinding);
		},
		abort: async () => {},
		dispose: () => {},
	});
}

const submit = (answer: string, citations: string[] = ["src/a.ts:1"], found = true) =>
	(onFinding: (v: unknown) => void) => onFinding({ found, answer, citations });

test("scout:工具白名单只有只读工具与 mission_finding —— 没有 bash", () => {
	// 8.7 的判据是机械的:能跑任意命令就能写文件,而子 agent 的写入不过 tool_call 钩子,
	// I2 冻结件闸门 / I7 touchedFiles 记账 / 编辑级增量反馈会同时失效
	for (const banned of ["bash", "powershell", "edit", "write"]) {
		assert.ok(!(SCOUT_TOOLS as readonly string[]).includes(banned), `白名单不应包含 ${banned}`);
	}
	for (const allowed of ["read", "grep", "find", "ls", "mission_finding"]) {
		assert.ok((SCOUT_TOOLS as readonly string[]).includes(allowed), `白名单应包含 ${allowed}`);
	}
});

test("扇出:findings 与问题等长同序,一路失败不拖累其他路", async () => {
	const questions = [Q("S1"), Q("S2"), Q("S3")];
	const r = await runScouts(
		{ ...options, questions },
		fake({
			S1: submit("11 处,集中在 repo 层"),
			S2: () => {
				throw new Error("provider 400");
			},
			S3: submit("有现成的集成测试 test/orm/*"),
		}),
	);

	assert.deepEqual(r.findings.map((f) => f.id), ["S1", "S2", "S3"], "顺序必须与入参一致 —— 调用方靠它逐条对应");
	assert.equal(r.findings[0].status, "answered");
	assert.equal(r.findings[2].status, "answered", "S2 炸了不该影响 S3");
	assert.equal(r.findings[1].status, "unanswered");
	assert.match(r.failures.S2, /provider 400/, "失败原因要原样带出来,不能只说'未查明'");
});

test("未查明的那一路必须把假设带在 answer 里 —— planner 要拿它继续规划", async () => {
	const questions = [Q("S1", "3 处左右")];
	const r = await runScouts({ ...options, questions }, fake({}));
	assert.equal(r.findings[0].status, "unanswered");
	assert.match(r.findings[0].answer, /沿用假设:3 处左右/);
	assert.match(r.failures.S1, /没有调用 mission_finding/);
});

test("超时:那一路判未查明,其余照常回来", async () => {
	const questions = [Q("S1"), Q("S2")];
	const r = await runScouts(
		{ ...options, timeoutMs: 30, questions },
		fake({
			S1: submit("查到了"),
			// 永不主动交结论,等超时把它掐掉
			S2: () => new Promise<void>((resolve) => setTimeout(resolve, 200).unref()),
		}),
	);
	assert.equal(r.findings[0].status, "answered");
	assert.equal(r.findings[1].status, "unanswered");
	assert.match(r.findings[1].answer, /未查明/);
});

test("扇出:usage across shards 合并计账 —— 不然并行的消耗在账上隐形", async () => {
	const questions = [Q("S1"), Q("S2")];
	const withUsage: CreateScoutSession = async ({ onFinding }) => {
		let listener: ((e: any) => void) | null = null;
		return {
			subscribe: (l: any) => {
				listener = l;
				return () => {};
			},
			prompt: async () => {
				listener?.({
					type: "message_end",
					message: { role: "assistant", usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.5 } } },
				});
				onFinding({ found: true, answer: "ok", citations: ["a.ts:1"] });
			},
			abort: async () => {},
			dispose: () => {},
		};
	};
	const r = await runScouts({ ...options, questions }, withUsage);
	assert.equal(r.usage.input, 20, "两路各 10");
	assert.equal(r.usage.cost, 1);
	assert.equal(r.usage.turns, 2);
});

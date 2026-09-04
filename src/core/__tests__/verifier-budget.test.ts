import { test } from "node:test";
import assert from "node:assert/strict";
import {
	budgetReason,
	checkVerifierBudget,
	DEFAULT_VERIFIER_CEILING_MS,
	DEFAULT_VERIFIER_IDLE_MS,
	type VerifierBudget,
} from "../verifier-budget.ts";

const budget: VerifierBudget = { idleMs: 120_000, ceilingMs: 900_000 };
const T0 = 1_700_000_000_000;

// 真机五轮的实测:三次实质核验 225/232/236 秒,每轮间隔 11–16 秒,
// 而旧的总时长阈值是 300 秒 —— 余量 30%,T1 那次调用多了几次就被掐了。
// 这条锁的是:那样的核验在新机制下**不该**被掐。
test("一直在干活的核验不该被掐 —— 哪怕总时长早就超过了旧的 300 秒", () => {
	// 每 15 秒一次动静,连续跑 280 秒(T1 被掐掉时的形态)
	for (let elapsed = 0; elapsed <= 280_000; elapsed += 15_000) {
		const v = checkVerifierBudget(
			{ startedAt: T0, lastActivityAt: T0 + elapsed, now: T0 + elapsed + 14_000 },
			budget,
		);
		assert.equal(v, "running", `第 ${elapsed / 1000}s 处不该掐`);
	}
});

test("静默到点就掐 —— 而且比旧的 300 秒更早", () => {
	assert.equal(
		checkVerifierBudget({ startedAt: T0, lastActivityAt: T0, now: T0 + 119_000 }, budget),
		"running",
	);
	assert.equal(
		checkVerifierBudget({ startedAt: T0, lastActivityAt: T0, now: T0 + 120_000 }, budget),
		"idle",
	);
});

test("静默计时从最近一次动静起算,不是从开始起算", () => {
	// 跑了 10 分钟,但 30 秒前刚有动静 —— 还在干活
	assert.equal(
		checkVerifierBudget(
			{ startedAt: T0, lastActivityAt: T0 + 600_000 - 30_000, now: T0 + 600_000 },
			budget,
		),
		"running",
	);
});

test("一直有动静但永远不收敛,由总时长兜底", () => {
	// 每 15 秒有动静,跑到 15 分钟
	assert.equal(
		checkVerifierBudget(
			{ startedAt: T0, lastActivityAt: T0 + 900_000 - 15_000, now: T0 + 900_000 },
			budget,
		),
		"ceiling",
	);
});

// 两条同时越线时报静默:「它卡住了」指向 provider 或模型,是可执行的诊断;
// 「跑太久了」谁也不知道下一步该做什么。
test("两条都越线时报静默 —— 它才是可执行的诊断", () => {
	assert.equal(
		checkVerifierBudget({ startedAt: T0, lastActivityAt: T0, now: T0 + 900_000 }, budget),
		"idle",
	);
});

// 连 session 都建不起来的核验,lastActivityAt 就等于 startedAt,
// 该按静默计时而不是白等到总时长上限。
test("一次动静都没有过时按静默计时", () => {
	assert.equal(
		checkVerifierBudget({ startedAt: T0, lastActivityAt: T0, now: T0 + 121_000 }, budget),
		"idle",
	);
});

test("默认值:静默远小于兜底 —— 常规路径上生效的必须是静默那条", () => {
	assert.ok(
		DEFAULT_VERIFIER_IDLE_MS * 4 < DEFAULT_VERIFIER_CEILING_MS,
		"兜底若和静默接近,就退化成了旧的总时长机制",
	);
	// 实测一次实质核验 236 秒;静默口径要远大于每轮间隔(11–16 秒),
	// 又要远小于一次完整核验的时长,否则它要么误杀要么永不触发。
	assert.ok(DEFAULT_VERIFIER_IDLE_MS > 16_000 * 4, "静默口径要能容下慢 provider 的轮间隔");
	assert.ok(DEFAULT_VERIFIER_IDLE_MS < 236_000, "静默口径若比整轮核验还长,就永远不会触发");
});

test("掐掉的理由要说清是哪一条越线,而不是只说'超时'", () => {
	assert.match(budgetReason("idle", budget), /没有任何动静/);
	assert.match(budgetReason("idle", budget), /120s/);
	assert.match(budgetReason("ceiling", budget), /未收敛/);
	assert.match(budgetReason("ceiling", budget), /900s/);
});

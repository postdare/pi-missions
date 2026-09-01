import { test } from "node:test";
import assert from "node:assert/strict";
import { transition, initialState, INCONCLUSIVE_STREAK_CAP } from "../machine.ts";
import { thresholdFor } from "../breaker.ts";
import type { Effect, MissionState, Verdict } from "../types.ts";

const AT = 1756600000000;

const mk = (tier: "quick" | "standard" | "complex" = "standard") =>
	initialState({ missionId: "m1", tier, taskOrder: ["T1", "T2"] });

const pass: Verdict = { outcome: "pass", failing: [], reason: "ok" };
const failed = (signature = "sig1"): Verdict => ({
	outcome: "fail",
	signature,
	failing: [],
	reason: "AC1 fail",
});
const unknown: Verdict = { outcome: "inconclusive", failing: [], reason: "env drift" };

const has = (effects: Effect[], type: Effect["type"]) => effects.some((e) => e.type === type);

/** 把 mission 推到 plan 相位(standard/complex 起于 frame) */
function toPlan(tier: "quick" | "standard" | "complex" = "standard"): MissionState {
	const s = mk(tier);
	return s.phase === "frame" ? transition(s, { type: "FRAME_DONE", at: AT }).state : s;
}

/** 把 mission 推到 do 相位 */
function toDo(tier: "quick" | "standard" | "complex" = "standard"): MissionState {
	return transition(toPlan(tier), { type: "PLAN_FROZEN", at: AT }).state;
}

/** 把 mission 推到 check 相位 */
function toCheck(tier: "quick" | "standard" | "complex" = "standard"): MissionState {
	return transition(toDo(tier), { type: "SUBMIT", at: AT }).state;
}

// ─────────────── PLAN → DO ───────────────

test("PLAN_FROZEN 冻结 AC 并进入首个任务", () => {
	const r = transition(toPlan(), { type: "PLAN_FROZEN", at: AT });
	assert.equal(r.state.phase, "do");
	assert.equal(r.state.currentTask, "T1");
	assert.equal(r.state.tasks.T1.attempts, 1);
	assert.ok(has(r.effects, "FREEZE_AC"));
	assert.ok(has(r.effects, "SET_TOOLS"));
	assert.ok(has(r.effects, "SET_ROLE"));
});

test("PLAN_FROZEN 只能在 plan 相位", () => {
	const r = transition(toDo(), { type: "PLAN_FROZEN", at: AT });
	assert.ok(r.error);
	assert.equal(r.state.phase, "do");
});

test("空任务列表无法进入 DO", () => {
	const s = initialState({ missionId: "m1", tier: "standard", taskOrder: [] });
	const r = transition(transition(s, { type: "FRAME_DONE", at: AT }).state, { type: "PLAN_FROZEN", at: AT });
	assert.ok(r.error);
});

// ─────────────── FRAME ───────────────

test("standard/complex 起于 FRAME,quick 直接起于 PLAN", () => {
	assert.equal(mk("standard").phase, "frame");
	assert.equal(mk("complex").phase, "frame");
	assert.equal(mk("quick").phase, "plan", "quick 的判定依据是 --verify,没有 AC 要定义");
});

test("FRAME_DONE 进 PLAN 并切到 planner 工具集", () => {
	const r = transition(mk(), { type: "FRAME_DONE", at: AT });
	assert.equal(r.state.phase, "plan");
	assert.ok(has(r.effects, "SET_TOOLS"));
	assert.ok(has(r.effects, "SET_ROLE"));
});

test("FRAME 相位之外不能发 FRAME_DONE / FRAME_ASKED", () => {
	assert.ok(transition(toPlan(), { type: "FRAME_DONE", at: AT }).error);
	assert.ok(transition(toDo(), { type: "FRAME_ASKED", at: AT }).error);
});

test("FRAME_ASKED 记账提问轮数(预算判定在 core/frame.ts)", () => {
	const r = transition(mk(), { type: "FRAME_ASKED", at: AT });
	assert.equal(r.state.frameAsks, 1);
	assert.equal(r.state.phase, "frame", "提问不迁移相位,等人回答");
});

test("换脑挂起时 FRAME_DONE 被拒", () => {
	const s = transition(mk(), { type: "HANDOFF_REQUEST", at: AT, reason: "x" }).state;
	assert.ok(transition(s, { type: "FRAME_DONE", at: AT }).error);
});

// ─────────────── SUBMIT / PASS 推进 ───────────────

test("SUBMIT 进入 check 相位", () => {
	const r = transition(toDo(), { type: "SUBMIT", at: AT });
	assert.equal(r.state.phase, "check");
});

test("PASS 推进到下一任务并复位尝试计数", () => {
	let s = toCheck();
	s = transition(s, { type: "VERDICT", at: AT, verdict: pass }).state;
	assert.equal(s.phase, "do");
	assert.equal(s.currentTask, "T2");
	assert.equal(s.tasks.T1.status, "done");
	assert.equal(s.tasks.T2.attempts, 1);
});

test("standard 档任务推进不换脑,complex 档换脑", () => {
	const s1 = transition(toCheck("standard"), { type: "VERDICT", at: AT, verdict: pass });
	assert.ok(!has(s1.effects, "HANDOFF"));
	assert.equal(s1.state.pendingHandoff, null);

	const s2 = transition(toCheck("complex"), { type: "VERDICT", at: AT, verdict: pass });
	assert.ok(has(s2.effects, "HANDOFF"));
	assert.ok(s2.state.pendingHandoff);
});

test("最后一个任务 PASS 后 mission 完成并恢复现场", () => {
	let s = toCheck();
	s = transition(s, { type: "VERDICT", at: AT, verdict: pass }).state; // T1 done
	s = transition(s, { type: "SUBMIT", at: AT }).state;
	const r = transition(s, { type: "VERDICT", at: AT, verdict: pass });
	assert.equal(r.state.phase, "done");
	assert.equal(r.state.currentTask, null);
	assert.ok(has(r.effects, "RESTORE"));
});

// ─────────────── FAIL:breaker 并入 ───────────────

test("首次 FAIL 进 act,签名计数记在机器里", () => {
	const r = transition(toCheck(), { type: "VERDICT", at: AT, verdict: failed() });
	assert.equal(r.state.phase, "act");
	assert.equal(r.state.tasks.T1.lastSignature, "sig1");
	assert.equal(r.state.tasks.T1.sameSignatureCount, 1);
	assert.ok(r.state.tasks.T1.lastFailureReason);
});

test("同一签名连续失败达到阈值直接升级 L2,不再进 act", () => {
	let s = toCheck();
	const n = thresholdFor("standard"); // 3
	for (let i = 1; i < n; i++) {
		const r = transition(s, { type: "VERDICT", at: AT, verdict: failed() });
		assert.equal(r.state.phase, "act", `第 ${i} 次失败应进 act`);
		s = transition(r.state, { type: "ADJUST_DONE", at: AT }).state;
		s = transition(s, { type: "SUBMIT", at: AT }).state;
	}
	// 第 n 次同一签名:breaker 判 escalate,机器内部直接走 L2
	const r = transition(s, { type: "VERDICT", at: AT, verdict: failed() });
	assert.equal(r.state.phase, "plan");
	assert.equal(r.state.escalation.level, 2);
	assert.equal(r.state.escalation.history.length, 1);
	assert.ok(has(r.effects, "HANDOFF"));
	assert.equal(r.state.pendingHandoff, "escalate L2 on T1");
	// 升级后签名计数重置
	assert.equal(r.state.tasks.T1.sameSignatureCount, 0);
	assert.equal(r.state.tasks.T1.lastSignature, undefined);
});

test("签名变化重置连续计数,不误熔断", () => {
	let s = toCheck();
	s = transition(s, { type: "VERDICT", at: AT, verdict: failed("sig-a") }).state;
	s = transition(s, { type: "ADJUST_DONE", at: AT }).state;
	s = transition(s, { type: "SUBMIT", at: AT }).state;
	const r = transition(s, { type: "VERDICT", at: AT, verdict: failed("sig-b") });
	assert.equal(r.state.phase, "act");
	assert.equal(r.state.tasks.T1.sameSignatureCount, 1);
	assert.equal(r.state.tasks.T1.lastSignature, "sig-b");
});

test("尝试次数达硬上限直接停机(签名一直在变也一样)", () => {
	let s = toCheck("quick"); // quick cap = 4
	for (let i = 1; i <= 4; i++) {
		const r = transition(s, { type: "VERDICT", at: AT, verdict: failed(`sig-${i}`) });
		if (i === 4) {
			assert.equal(r.state.phase, "halted");
			assert.ok(has(r.effects, "RESTORE"));
			break;
		}
		assert.equal(r.state.phase, "act");
		s = transition(r.state, { type: "ADJUST_DONE", at: AT }).state;
		assert.equal(s.tasks.T1.attempts, i + 1);
		s = transition(s, { type: "SUBMIT", at: AT }).state;
	}
});

// ─────────────── INCONCLUSIVE ───────────────

test("INCONCLUSIVE 回 do 且不计 attempts、不进熔断", () => {
	const s = toCheck();
	const r = transition(s, { type: "VERDICT", at: AT, verdict: unknown });
	assert.equal(r.state.phase, "do");
	assert.equal(r.state.tasks.T1.attempts, 1);
	assert.equal(r.state.tasks.T1.sameSignatureCount, 0);
	assert.equal(r.state.tasks.T1.inconclusiveStreak, 1);
	assert.ok(has(r.effects, "NOTIFY"));
});

test("连续 INCONCLUSIVE 达上限停机(环境漂移防死循环)", () => {
	let s = toCheck();
	for (let i = 1; i < INCONCLUSIVE_STREAK_CAP; i++) {
		s = transition(s, { type: "VERDICT", at: AT, verdict: unknown }).state;
		assert.equal(s.phase, "do");
		s = transition(s, { type: "SUBMIT", at: AT }).state;
	}
	const r = transition(s, { type: "VERDICT", at: AT, verdict: unknown });
	assert.equal(r.state.phase, "halted");
});

// ─────────────── L3 人工确认 ───────────────

test("L3 升级挂起等人工确认,确认后归档并换脑回 plan", () => {
	let s = toDo();
	s = transition(s, { type: "ESCALATE", at: AT, to: 2, reason: "方案错误" }).state;
	assert.equal(s.phase, "plan");
	// L2 后重新规划冻结,回到 do,再失败到阈值 → L3
	s = { ...s, pendingHandoff: null }; // 模拟换脑完成
	s = transition(s, { type: "PLAN_FROZEN", at: AT }).state;
	s = transition(s, { type: "SUBMIT", at: AT }).state;
	const n = thresholdFor("standard");
	for (let i = 1; i < n; i++) {
		const r = transition(s, { type: "VERDICT", at: AT, verdict: failed("sig-x") });
		s = transition(r.state, { type: "ADJUST_DONE", at: AT }).state;
		s = transition(s, { type: "SUBMIT", at: AT }).state;
	}
	const r3 = transition(s, { type: "VERDICT", at: AT, verdict: failed("sig-x") });
	assert.equal(r3.state.escalation.level, 3);
	assert.ok(has(r3.effects, "CONFIRM"));
	assert.notEqual(r3.state.phase, "plan", "L3 确认前不迁移相位");

	const okd = transition(r3.state, { type: "ESCALATION_CONFIRMED", at: AT });
	assert.equal(okd.state.phase, "frame", "L3 = 改问题定义,落点是 FRAME 不是 PLAN");
	assert.equal(okd.state.frameAsks, 0, "新的问题定义值得再问一轮");
	assert.ok(has(okd.effects, "ARCHIVE_PLAN"));
	assert.ok(has(okd.effects, "HANDOFF"));
	assert.ok(okd.state.pendingHandoff);
});

test("L3 被拒绝则停机", () => {
	let s = toDo();
	const esc = transition(s, { type: "ESCALATE", at: AT, to: 3, reason: "问题定义错误" });
	assert.equal(esc.state.escalation.level, 3);
	const r = transition(esc.state, { type: "ESCALATION_REJECTED", at: AT });
	assert.equal(r.state.phase, "halted");
	assert.ok(has(r.effects, "RESTORE"));
});

test("不允许降级升级", () => {
	let s = toDo();
	s = transition(s, { type: "ESCALATE", at: AT, to: 2, reason: "x" }).state;
	const r = transition(s, { type: "ESCALATE", at: AT, to: 2, reason: "y" });
	assert.ok(r.error);
});

// ─────────────── 换脑硬阻断(Q10) ───────────────

test("pendingHandoff 期间 PLAN_FROZEN 与 SUBMIT 都被拒绝", () => {
	let s = toDo();
	s = transition(s, { type: "HANDOFF_REQUEST", at: AT, reason: "context-watermark" }).state;
	assert.equal(s.pendingHandoff, "context-watermark");
	assert.ok(transition(s, { type: "SUBMIT", at: AT }).error);
	s = transition(s, { type: "HANDOFF_DONE", at: AT, sessionFile: ".pi/sessions/x.jsonl" }).state;
	assert.equal(s.pendingHandoff, null);
	assert.equal(s.sessionMap.T1, ".pi/sessions/x.jsonl");
	assert.ok(!transition(s, { type: "SUBMIT", at: AT }).error);
});

test("无挂起时 HANDOFF_DONE 被拒绝", () => {
	const r = transition(toDo(), { type: "HANDOFF_DONE", at: AT });
	assert.ok(r.error);
});

// ─────────────── 升档 ───────────────

test("PROMOTE_TIER 只能升不能降,quick 升档补落盘", () => {
	const s = toDo("quick");
	const up = transition(s, { type: "PROMOTE_TIER", at: AT, to: "standard", reason: "attempts>=2" });
	assert.equal(up.state.tier, "standard");
	assert.ok(has(up.effects, "PERSIST_PLAN"));
	const down = transition(up.state, { type: "PROMOTE_TIER", at: AT, to: "quick", reason: "x" });
	assert.ok(down.error);
});

// ─────────────── ABORT ───────────────

test("ABORT 从任意活跃相位停机,done 后忽略", () => {
	const r = transition(toDo(), { type: "ABORT", at: AT, reason: "人工中止" });
	assert.equal(r.state.phase, "halted");
	assert.ok(has(r.effects, "RESTORE"));
	assert.ok(transition(r.state, { type: "ABORT", at: AT, reason: "again" }).error);
});

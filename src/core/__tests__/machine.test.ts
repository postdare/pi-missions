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

/** 把 mission 推到 plan 相位(standard/complex 起于 define) */
function toPlan(tier: "quick" | "standard" | "complex" = "standard"): MissionState {
	const s = mk(tier);
	return s.phase === "define" ? transition(s, { type: "DEFINE_DONE", at: AT }).state : s;
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
	const r = transition(transition(s, { type: "DEFINE_DONE", at: AT }).state, { type: "PLAN_FROZEN", at: AT });
	assert.ok(r.error);
});

// ─────────────── DEFINE ───────────────

test("standard/complex 起于 DEFINE,quick 直接起于 PLAN", () => {
	assert.equal(mk("standard").phase, "define");
	assert.equal(mk("complex").phase, "define");
	assert.equal(mk("quick").phase, "plan", "quick 的判定依据是 --verify,没有 AC 要定义");
});

test("DEFINE_DONE 进 PLAN 并切到 planner 工具集", () => {
	const r = transition(mk(), { type: "DEFINE_DONE", at: AT });
	assert.equal(r.state.phase, "plan");
	assert.ok(has(r.effects, "SET_TOOLS"));
	assert.ok(has(r.effects, "SET_ROLE"));
});

test("DEFINE 相位之外不能发 DEFINE_DONE / DEFINE_ASKED", () => {
	assert.ok(transition(toPlan(), { type: "DEFINE_DONE", at: AT }).error);
	assert.ok(transition(toDo(), { type: "DEFINE_ASKED", at: AT, settled: [] }).error);
});

test("DEFINE_ASKED 记账提问轮数与结账快照(闸门判定在 core/define.ts)", () => {
	const r = transition(mk(), { type: "DEFINE_ASKED", at: AT, settled: ["D1"] });
	assert.equal(r.state.defineAsks, 1);
	assert.deepEqual(r.state.defineSettled, ["D1"], "下一轮要靠它判断上一轮有没有推进决策");
	assert.equal(r.state.phase, "define", "提问不迁移相位,等人回答");

	const r2 = transition(r.state, { type: "DEFINE_ASKED", at: AT, settled: ["D1", "D2"] });
	assert.equal(r2.state.defineAsks, 2);
	assert.deepEqual(r2.state.defineSettled, ["D1", "D2"]);
});

test("换脑挂起时 DEFINE_DONE 被拒", () => {
	const s = transition(mk(), { type: "HANDOFF_REQUEST", at: AT, reason: "x" }).state;
	assert.ok(transition(s, { type: "DEFINE_DONE", at: AT }).error);
});

test("DEFINE_ANSWERED:回答按轮累积落进 state,换脑后照这里抄 resolved", () => {
	const asked = transition(mk(), { type: "DEFINE_ASKED", at: AT, settled: [] }).state;
	const a1 = transition(asked, {
		type: "DEFINE_ANSWERED",
		at: AT,
		answers: [{ q: "慢是指首屏还是接口?", a: "接口 p95" }],
	});
	assert.equal(a1.error, undefined);
	assert.deepEqual(a1.state.defineAnswers, [{ q: "慢是指首屏还是接口?", a: "接口 p95" }]);
	assert.equal(a1.state.phase, "define", "收答案不迁移相位");
});

test("DEFINE_ANSWERED:没问过不能答,空答案被拒", () => {
	assert.ok(transition(mk(), { type: "DEFINE_ANSWERED", at: AT, answers: [{ q: "x", a: "y" }] }).error);
	const asked = transition(mk(), { type: "DEFINE_ASKED", at: AT, settled: [] }).state;
	assert.ok(transition(asked, { type: "DEFINE_ANSWERED", at: AT, answers: [] }).error);
	assert.ok(transition(toPlan(), { type: "DEFINE_ANSWERED", at: AT, answers: [{ q: "x", a: "y" }] }).error);
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

test("inconclusive·evidence 挂待补证据闸门并记下 treeFp,同指纹 SUBMIT 被拒绝", () => {
	const tree1 = "sha256:1111111111111111";
	const tree2 = "sha256:2222222222222222";
	let s = toDo();
	// 第 1 次提交带指纹 tree1
	s = transition(s, { type: "SUBMIT", at: AT, treeFp: tree1 }).state;
	assert.equal(s.tasks.T1.submittedTreeFp, tree1);

	// 判定为 evidence 类 inconclusive
	const evVerdict: Verdict = {
		outcome: "inconclusive",
		inconclusiveCause: "evidence",
		missingAcIds: ["AC1"],
		failing: [],
		reason: "缺少验收证据:AC1",
	};
	s = transition(s, { type: "VERDICT", at: AT, verdict: evVerdict }).state;
	assert.equal(s.phase, "do");
	assert.ok(s.tasks.T1.awaitingEvidence);
	assert.equal(s.tasks.T1.awaitingEvidence?.treeFp, tree1);
	assert.deepEqual(s.tasks.T1.awaitingEvidence?.acIds, ["AC1"]);

	// 工作区无改动(指纹仍为 tree1)原样重交 → 被拦截
	const rejected = transition(s, { type: "SUBMIT", at: AT, treeFp: tree1 });
	assert.ok(rejected.error);
	assert.match(rejected.error!, /未检测到任何改动/);
	assert.equal(rejected.state.phase, "do");

	// 补充证据或修改实现后(指纹变为 tree2)重交 → 放行并进入 check,清空 awaitingEvidence
	const accepted = transition(s, { type: "SUBMIT", at: AT, treeFp: tree2 });
	assert.ok(!accepted.error);
	assert.equal(accepted.state.phase, "check");
	assert.equal(accepted.state.tasks.T1.submittedTreeFp, tree2);
	assert.equal(accepted.state.tasks.T1.awaitingEvidence, null);
});

test("inconclusive·env 不设闸门,原样重交可放行", () => {
	const tree = "sha256:1111111111111111";
	let s = toDo();
	s = transition(s, { type: "SUBMIT", at: AT, treeFp: tree }).state;
	const envVerdict: Verdict = {
		outcome: "inconclusive",
		inconclusiveCause: "env",
		failing: [],
		reason: "环境指纹不符",
	};
	s = transition(s, { type: "VERDICT", at: AT, verdict: envVerdict }).state;
	assert.equal(s.phase, "do");
	assert.equal(s.tasks.T1.awaitingEvidence, null);

	// 原样重交放行
	const okSubmit = transition(s, { type: "SUBMIT", at: AT, treeFp: tree });
	assert.ok(!okSubmit.error);
	assert.equal(okSubmit.state.phase, "check");
});

test("非 git 仓库(treeFp 为 null)时闸门退化放行", () => {
	let s = toDo();
	s = transition(s, { type: "SUBMIT", at: AT, treeFp: null }).state;
	const evVerdict: Verdict = {
		outcome: "inconclusive",
		inconclusiveCause: "evidence",
		missingAcIds: ["AC1"],
		failing: [],
		reason: "AC1 无结论",
	};
	s = transition(s, { type: "VERDICT", at: AT, verdict: evVerdict }).state;
	assert.equal(s.phase, "do");

	// treeFp 为 null 时放行
	const res = transition(s, { type: "SUBMIT", at: AT, treeFp: null });
	assert.ok(!res.error);
	assert.equal(res.state.phase, "check");
});

test("待补证据闸门不影响 ESCALATE 逃生口", () => {
	const tree = "sha256:1111111111111111";
	let s = toDo();
	s = transition(s, { type: "SUBMIT", at: AT, treeFp: tree }).state;
	const evVerdict: Verdict = {
		outcome: "inconclusive",
		inconclusiveCause: "evidence",
		missingAcIds: ["AC2"],
		failing: [],
		reason: "缺少验收证据:AC2",
	};
	s = transition(s, { type: "VERDICT", at: AT, verdict: evVerdict }).state;
	assert.ok(s.tasks.T1.awaitingEvidence);

	// 在 DO 调 ESCALATE 正常工作
	const escalated = transition(s, { type: "ESCALATE", at: AT, to: 2, reason: "AC 分解有误" });
	assert.ok(!escalated.error);
	assert.equal(escalated.state.phase, "plan");
});

test("quick 不能手动升级 —— 那条路的终点是执行者重写判定标准", () => {
	// 链路(修复前是通的):ACT 调 mission_escalate(L2) → phase=plan
	//   → quick 的 PLAN 工具集是 [只读 + mission_criterion]
	//   → freezeQuickCriterion 的守卫是 phase !== "plan",此刻正好放行
	//   → 刚被这条判据判失败的执行者,把判据换了一条。
	let s = toDo("quick");
	s = transition(s, { type: "SUBMIT", at: AT }).state;
	s = transition(s, { type: "VERDICT", at: AT, verdict: failed("sig-q") }).state;
	assert.equal(s.phase, "act", "quick 第一次失败先进 ACT 诊断一轮");

	const r = transition(s, { type: "ESCALATE", at: AT, to: 2, reason: "方案不对" });
	assert.ok(r.error, "quick 的 ESCALATE 必须被拒");
	assert.equal(r.state.phase, "act", "被拒时状态不动");
	assert.equal(r.state.escalation.level, 1, "升级级别也不许动");
	assert.equal(r.effects.length, 0, "拒绝不产生任何 effect —— 别把换脑挂起来");

	// L3 同样不行:它的落点是 DEFINE,而 quick 的提问额度是 0,
	// 走完 DEFINE 回到的还是那个只有 mission_criterion 的 PLAN。
	assert.ok(transition(s, { type: "ESCALATE", at: AT, to: 3, reason: "问题定义不对" }).error);
});

test("standard/complex 的手动升级不受影响 —— 拦的是 quick,不是这条逃生口", () => {
	for (const tier of ["standard", "complex"] as const) {
		let s = toDo(tier);
		s = transition(s, { type: "SUBMIT", at: AT }).state;
		s = transition(s, { type: "VERDICT", at: AT, verdict: failed("sig-y") }).state;
		const r = transition(s, { type: "ESCALATE", at: AT, to: 2, reason: "方案错误" });
		assert.ok(!r.error, tier);
		assert.equal(r.state.phase, "plan", tier);
	}
});

test("裁判不可用首轮即停机 —— 拿同一个坏裁判再空转两轮毫无意义", () => {
	const s = toCheck();
	const r = transition(s, {
		type: "VERDICT",
		at: AT,
		verdict: {
			outcome: "inconclusive",
			inconclusiveCause: "judge",
			failing: [],
			reason: "裁判不可用:独立核验不可用(provider 400)",
		},
	});
	assert.equal(r.state.phase, "halted");
	assert.equal(r.state.tasks.T1.inconclusiveStreak, 1);
	assert.equal(r.state.tasks.T1.lastInconclusiveCause, "judge");
	// 裁判坏了不是执行者少交证据,别挂 awaitingEvidence 去卡它的下一次 SUBMIT
	assert.equal(r.state.tasks.T1.awaitingEvidence, null);
	const notify = r.effects.find((e) => e.type === "NOTIFY") as any;
	assert.match(notify.message, /核验裁判|verifier/);
	assert.doesNotMatch(notify.message, /环境/);
});

test("停机文案按成因分流 —— 证据缺口不该说成环境漂移", () => {
	let s = toCheck();
	const missing: Verdict = {
		outcome: "inconclusive",
		inconclusiveCause: "evidence",
		failing: [],
		reason: "缺少验收证据:AC1",
	};
	for (let i = 1; i < INCONCLUSIVE_STREAK_CAP; i++) {
		s = transition(s, { type: "VERDICT", at: AT, verdict: missing }).state;
		s = transition(s, { type: "SUBMIT", at: AT, treeFp: `sha256:${i}` }).state;
	}
	const r = transition(s, { type: "VERDICT", at: AT, verdict: missing });
	assert.equal(r.state.phase, "halted");
	assert.equal(r.state.tasks.T1.lastInconclusiveCause, "evidence");
	const notify = r.effects.find((e) => e.type === "NOTIFY") as any;
	assert.match(notify.message, /证据采集/);
	assert.doesNotMatch(notify.message, /环境/);
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
	assert.equal(okd.state.phase, "define", "L3 = 改问题定义,落点是 DEFINE 不是 PLAN");
	assert.equal(okd.state.defineAsks, 0, "新的问题定义值得再问一轮");
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

test("HANDOFF_CANCELLED 显式解除挂起", () => {
	const pending = transition(toDo(), { type: "HANDOFF_REQUEST", at: AT, reason: "manual" }).state;
	const cancelled = transition(pending, { type: "HANDOFF_CANCELLED", at: AT, reason: "newSession cancelled" });
	assert.equal(cancelled.state.pendingHandoff, null);
	assert.ok(has(cancelled.effects, "NOTIFY"));
	assert.ok(transition(toDo(), { type: "HANDOFF_CANCELLED", at: AT, reason: "x" }).error);
});

test("RECOVER_INTERRUPTED_CHECK 只接受匹配的 check/act 相位", () => {
	const check = transition(toDo(), { type: "SUBMIT", at: AT }).state;
	const recovered = transition(check, { type: "RECOVER_INTERRUPTED_CHECK", at: AT, from: "check" });
	assert.equal(recovered.state.phase, "do");
	assert.ok(transition(toDo(), { type: "RECOVER_INTERRUPTED_CHECK", at: AT, from: "check" }).error);

	const act = {
		...toDo(),
		phase: "act" as const,
	};
	assert.equal(transition(act, { type: "RECOVER_INTERRUPTED_CHECK", at: AT, from: "act" }).state.phase, "do");
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

test("quick 升档必须回 PLAN 并挂换脑 —— 只改 tier 会留下一个没有 AC 的 standard mission", () => {
	// 事故:原来这里只改 tier、相位停在 do。runCheck 按 state.tier 分流,档位一变
	// 就不再看那条冻结判据,转去跑空的 verify.sh —— 采不到证据判 inconclusive,
	// 回 DO 再来,三次之后停机。quick 只要失败一次就必然走进这条路。
	const up = transition(toDo("quick"), { type: "PROMOTE_TIER", at: AT, to: "standard", reason: "attempts>=2" });
	assert.equal(up.state.phase, "plan", "升档的意义就是把那条判据摊开成 AC + verify.sh,只能在 PLAN 做");
	assert.ok(up.state.pendingHandoff, "换脑必须挂起 —— 新会话要从盘上重附着");
	assert.ok(has(up.effects, "HANDOFF"));
	// 落盘要排在写 LOG 之前:目录还没建出来时写 LOG 等于把失败原因扔了
	const persist = up.effects.findIndex((e) => e.type === "PERSIST_PLAN");
	const firstLog = up.effects.findIndex((e) => e.type === "LOG");
	assert.ok(persist >= 0 && (firstLog < 0 || persist < firstLog), "PERSIST_PLAN 必须排在一切 LOG 之前");
});

test("standard → complex 只改档位,不回 PLAN —— 它已经有计划了", () => {
	const s = { ...toDo("standard"), tier: "standard" as const };
	const up = transition(s, { type: "PROMOTE_TIER", at: AT, to: "complex", reason: "2 次 L2" });
	assert.equal(up.state.tier, "complex");
	assert.equal(up.state.phase, "do", "别把 quick 的特殊处理误伤到这条路");
	assert.ok(!up.state.pendingHandoff);
	assert.ok(!has(up.effects, "PERSIST_PLAN"));
});

test("RECORD_ROLE_COST 只累计角色费用,不改变相位", () => {
	const s = toDo();
	const r = transition(s, { type: "RECORD_ROLE_COST", at: AT, role: "verifier", amount: 0.012 });
	assert.equal(r.state.phase, "do");
	assert.equal(r.state.cost.verifier, 0.012);
	assert.equal(r.effects.length, 0);
	assert.ok(transition(r.state, { type: "RECORD_ROLE_COST", at: AT, role: "verifier", amount: 0 }).error);
});

test("RECORD_ROLE_COST:网关不报价时 amount=0 也可记 token 账,逐字段累计", () => {
	const s = toDo();
	const tokens = { input: 1200, output: 300, cacheRead: 5000, cacheWrite: 0 };
	// amount=0 + 无 tokens 仍然拒绝(空记账没有意义)
	assert.ok(transition(s, { type: "RECORD_ROLE_COST", at: AT, role: "verifier", amount: 0 }).error);
	const r1 = transition(s, { type: "RECORD_ROLE_COST", at: AT, role: "verifier", amount: 0, tokens });
	assert.ok(!r1.error, JSON.stringify(r1.error));
	assert.deepEqual(r1.state.tokens?.verifier, tokens);
	assert.equal(r1.state.cost.verifier, undefined, "amount=0 不动美元账");
	// 累计:同角色再记一笔,token 逐字段相加
	const r2 = transition(r1.state, { type: "RECORD_ROLE_COST", at: AT, role: "verifier", amount: 0.01, tokens });
	assert.equal(r2.state.tokens?.verifier?.input, 2400);
	assert.equal(r2.state.tokens?.verifier?.cacheRead, 10000);
	assert.equal(r2.state.cost.verifier, 0.01);
	// 负数 amount 永远拒绝
	assert.ok(transition(s, { type: "RECORD_ROLE_COST", at: AT, role: "verifier", amount: -1, tokens }).error);
});

test("RECORD_TOUCHED_FILE 去重并单调记录公开 API", () => {
	let s = toDo();
	s = transition(s, { type: "RECORD_TOUCHED_FILE", at: AT, path: "src/a.ts", publicApi: false }).state;
	s = transition(s, { type: "RECORD_TOUCHED_FILE", at: AT + 1, path: "src/a.ts", publicApi: true }).state;
	assert.deepEqual(s.metrics.touchedFiles, ["src/a.ts"]);
	assert.equal(s.metrics.touchedPublicApi, true);
});

// ─────────────── ABORT ───────────────

test("ABORT 从任意活跃相位停机,done 后忽略", () => {
	const r = transition(toDo(), { type: "ABORT", at: AT, reason: "人工中止" });
	assert.equal(r.state.phase, "halted");
	assert.ok(has(r.effects, "RESTORE"));
	assert.ok(transition(r.state, { type: "ABORT", at: AT, reason: "again" }).error);
});

// ─────────────── 探针(spike) ───────────────

/** 把一个 spike 任务推到 check 相位 */
function toSpikeCheck(): MissionState {
	const s = transition(toPlan(), { type: "PLAN_FROZEN", at: AT, spikes: ["T1"] }).state;
	return transition(s, { type: "SUBMIT", at: AT }).state;
}

test("spike PASS 不推进下一任务,而是回 PLAN + 换脑 + 归档", () => {
	const r = transition(toSpikeCheck(), { type: "VERDICT", at: AT, verdict: pass });
	assert.equal(r.state.phase, "plan");
	assert.equal(r.state.currentTask, null);
	assert.equal(r.state.tasks.T1.status, "done");
	assert.equal(r.state.spikesRun, 1);
	assert.ok(r.state.pendingHandoff);
	assert.ok(has(r.effects, "ARCHIVE_PLAN"));
	assert.ok(has(r.effects, "HANDOFF"));
});

test("spike FAIL 也回 PLAN:不进 ACT、不计熔断(时间盒)", () => {
	const r = transition(toSpikeCheck(), { type: "VERDICT", at: AT, verdict: failed() });
	assert.equal(r.state.phase, "plan", "探针的失败本身就是一条结论");
	assert.equal(r.state.tasks.T1.status, "blocked");
	assert.equal(r.state.tasks.T1.sameSignatureCount, 0);
	assert.equal(r.state.tasks.T1.attempts, 1);
	assert.equal(r.state.spikesRun, 1, "失败也算用掉一次额度");
});

test("spikesRun 是独立记账:重写计划丢掉旧任务也不会把额度还回来", () => {
	const after = transition(toSpikeCheck(), { type: "VERDICT", at: AT, verdict: pass }).state;
	const replanned = transition(
		{ ...after, pendingHandoff: null },
		{ type: "PLAN_FROZEN", at: AT, taskOrder: ["T9"] },
	).state;
	assert.equal(replanned.tasks.T1, undefined, "旧任务确实被丢掉了");
	assert.equal(replanned.spikesRun, 1, "额度还在");
});

test("kind 随每次冻结重算:同一 id 可以从 spike 变回 impl", () => {
	const asSpike = transition(toPlan(), { type: "PLAN_FROZEN", at: AT, spikes: ["T1"] }).state;
	assert.equal(asSpike.tasks.T1.kind, "spike");
	const asImpl = transition({ ...asSpike, phase: "plan" as const }, { type: "PLAN_FROZEN", at: AT }).state;
	assert.equal(asImpl.tasks.T1.kind, "impl");
});

// ─────────────── PLAN:人工打回 ───────────────

test("PLAN_REJECTED 只能在 plan 相位,且记账打回次数与意见", () => {
	assert.ok(transition(toDo(), { type: "PLAN_REJECTED", at: AT, comment: "x" }).error);

	const r1 = transition(toPlan(), { type: "PLAN_REJECTED", at: AT, comment: "AC2 那条根本不会红" });
	assert.equal(r1.state.phase, "plan", "上限之内不迁移相位,让 planner 重交");
	assert.equal(r1.state.planReview?.rejections, 1);
	assert.deepEqual(r1.state.planReview?.notes, ["AC2 那条根本不会红"]);

	const r2 = transition(r1.state, { type: "PLAN_REJECTED", at: AT, comment: "任务粒度太粗" });
	assert.equal(r2.state.planReview?.rejections, 2);
	assert.deepEqual(r2.state.planReview?.notes, ["AC2 那条根本不会红", "任务粒度太粗"]);
	assert.equal(r2.state.phase, "plan");
});

test("连打三次 → 硬拦转 L3:回 DEFINE、归档旧计划、强制换脑、重置提问轮次", () => {
	let s = toPlan();
	for (let i = 0; i < 2; i++) {
		s = transition(s, { type: "PLAN_REJECTED", at: AT, comment: `第 ${i + 1} 次` }).state;
	}
	// 先把提问轮次用掉,验证 L3 会把它还回来
	s = { ...s, defineAsks: 2, defineSettled: ["D1"] };

	const r = transition(s, { type: "PLAN_REJECTED", at: AT, comment: "还是不对" });
	assert.equal(r.state.phase, "define", "L3 的落点是 DEFINE,不是 PLAN —— 问题定义错了,换个姿势拆方案没用");
	assert.equal(r.state.escalation.level, 3);
	assert.equal(r.state.defineAsks, 0, "新的问题定义值得再问一轮");
	assert.deepEqual(r.state.defineSettled, []);
	assert.ok(r.state.pendingHandoff, "重新定义问题不能在被三版废方案污染的上下文里做");
	assert.ok(has(r.effects, "ARCHIVE_PLAN"));
	assert.ok(has(r.effects, "HANDOFF"));
	assert.ok(has(r.effects, "NOTIFY"));
	assert.equal(r.state.escalation.history.at(-1)?.to, 3);
});

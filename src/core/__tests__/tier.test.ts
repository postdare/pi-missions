import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateAdmission, evaluatePromotion, tierRank } from "../tier.ts";
import type { TaskState } from "../types.ts";

const task = (attempts: number): TaskState => ({
	id: "T1",
	status: "running",
	attempts,
	sameSignatureCount: 0,
	inconclusiveStreak: 0,
});

test("quick:第 2 次尝试升 standard", () => {
	const p = evaluatePromotion({
		tier: "quick",
		currentTask: task(2),
		touchedFiles: 1,
		touchedPublicApi: false,
		escalations: 0,
	});
	assert.equal(p?.to, "standard");
});

test("quick:首次尝试不升档", () => {
	const p = evaluatePromotion({
		tier: "quick",
		currentTask: task(1),
		touchedFiles: 1,
		touchedPublicApi: false,
		escalations: 0,
	});
	assert.equal(p, null);
});

test("quick:改动面超标或触及公开 API 升 standard", () => {
	assert.equal(
		evaluatePromotion({ tier: "quick", currentTask: task(1), touchedFiles: 6, touchedPublicApi: false, escalations: 0 })?.to,
		"standard",
	);
	assert.equal(
		evaluatePromotion({ tier: "quick", currentTask: task(1), touchedFiles: 1, touchedPublicApi: true, escalations: 0 })?.to,
		"standard",
	);
});

test("standard:2 次改方案升 complex", () => {
	assert.equal(
		evaluatePromotion({ tier: "standard", currentTask: task(1), touchedFiles: 1, touchedPublicApi: false, escalations: 2 })?.to,
		"complex",
	);
	assert.equal(
		evaluatePromotion({ tier: "standard", currentTask: task(1), touchedFiles: 1, touchedPublicApi: false, escalations: 1 }),
		null,
	);
});

test("complex 不再升档", () => {
	assert.equal(
		evaluatePromotion({ tier: "complex", currentTask: task(5), touchedFiles: 99, touchedPublicApi: true, escalations: 9 }),
		null,
	);
});

test("tierRank 单调", () => {
	assert.ok(tierRank("quick") < tierRank("standard"));
	assert.ok(tierRank("standard") < tierRank("complex"));
});

// ─────────────── 进入 DO 的准入判定(I2/I3 入口守卫) ───────────────

test("quick 有验证命令才放行进 DO", () => {
	const r = evaluateAdmission({ tier: "quick", hasVerifyCommand: true });
	assert.equal(r.ok, true);
});

test("quick 无验证命令不进 DO,升 standard 走 PLAN", () => {
	const r = evaluateAdmission({ tier: "quick", hasVerifyCommand: false });
	assert.equal(r.ok, false);
	assert.equal(r.ok === false && r.promoteTo, "standard");
	assert.ok(r.ok === false && r.reason.includes("--verify"));
});

test("standard/complex 的准入由 PLAN 把关,不受此守卫影响", () => {
	assert.equal(evaluateAdmission({ tier: "standard", hasVerifyCommand: false }).ok, true);
	assert.equal(evaluateAdmission({ tier: "complex", hasVerifyCommand: false }).ok, true);
});

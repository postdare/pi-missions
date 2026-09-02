import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluatePlanReview, PLAN_REJECT_CAP } from "../review.ts";

test("上限之内:让 planner 重交,并报还剩几次", () => {
	const r1 = evaluatePlanReview({ rejections: 1 });
	assert.equal(r1.ok, true);
	assert.equal(r1.ok && r1.remaining, PLAN_REJECT_CAP - 1);
	assert.equal(evaluatePlanReview({ rejections: PLAN_REJECT_CAP - 1 }).ok, true);
});

test("到达上限:硬拦,转 L3 —— 继续磨等于在错的问题上做高质量的工作", () => {
	const r = evaluatePlanReview({ rejections: PLAN_REJECT_CAP });
	assert.equal(r.ok, false);
	assert.equal(r.ok === false && r.escalate, true);
	assert.match(r.ok === false ? r.reason : "", /转 L3 回 DEFINE/);
});

test("超过上限同样硬拦(计数不会因为重新规划而回退)", () => {
	assert.equal(evaluatePlanReview({ rejections: PLAN_REJECT_CAP + 2 }).ok, false);
});

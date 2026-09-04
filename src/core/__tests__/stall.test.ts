import { test } from "node:test";
import assert from "node:assert/strict";
import { isDrivenPhase, nextStall, stallKey, type StallState } from "../stall.ts";

const at = (phase: Parameters<typeof stallKey>[0], revision = 1, pendingHandoff = false) => ({
	phase,
	revision,
	pendingHandoff,
});

test("第一次 settle 就推 —— DEFINE→PLAN 那次事故正发生在进入相位后的第一次 settle", () => {
	const r = nextStall(null, at("plan"));
	assert.equal(r.action, "nudge");
	assert.equal(r.state.nudges, 1);
	assert.equal(r.state.key, "plan:1");
});

test("推过一次还是不动:报给人,不再推 —— 一直推会在模型真卡住时烧光预算", () => {
	const first = nextStall(null, at("plan"));
	assert.equal(first.action, "nudge");

	const second = nextStall(first.state, at("plan"));
	assert.equal(second.action, "warn", "第二次 settle 必须交给人,不能再推");
	assert.equal(second.state.nudges, 2);

	const third = nextStall(second.state, at("plan"));
	assert.equal(third.action, "silent", "报过一次的事再报是刷屏");
	const fourth = nextStall(third.state, at("plan"));
	assert.equal(fourth.action, "silent");
});

test("相位推进了就重新开始计数 —— 那不是停滞", () => {
	const stalled: StallState = { key: stallKey("define", 3), nudges: 2 };
	const r = nextStall(stalled, at("plan", 3));
	assert.equal(r.action, "nudge", "换了相位是有进展,新相位重新给一次推动机会");
	assert.equal(r.state.key, "plan:3");
	assert.equal(r.state.nudges, 1);
});

test("revision 前进了就重新开始计数 —— 有东西落了盘就算有进展", () => {
	const stalled: StallState = { key: stallKey("plan", 7), nudges: 2 };
	// PLAN 里交了一版计划被打回:相位没变,但 planReview 落了盘,revision 前进
	const r = nextStall(stalled, at("plan", 8));
	assert.equal(r.action, "nudge");
	assert.equal(r.state.nudges, 1);
});

test("换脑挂起中不推 —— HANDOFF 自己会推 /mission next,抢了会撞车", () => {
	const r = nextStall(null, at("plan", 1, true));
	assert.equal(r.action, "silent");
});

test("check / act / done / halted 不推 —— 各自已有驱动,或本来就该停", () => {
	for (const phase of ["check", "act", "done", "halted"] as const) {
		assert.equal(nextStall(null, at(phase)).action, "silent", phase);
		assert.equal(isDrivenPhase(phase), false, phase);
	}
});

// DO 曾经犹豫要不要排除(怕撞上"模型正等人回话")。查过闸门:toolsForPhase("do") 是
// [内置八件 + mission_submit],里面没有 ask_user_question,define/plan 同样没有 ——
// 这三个相位里模型没有合法地停下来等人的手段,一次 settle 就是一次停摆。
test("define / plan / do 三个相位都推 —— 同一个形状:终结动作是一次工具调用", () => {
	for (const phase of ["define", "plan", "do"] as const) {
		assert.equal(isDrivenPhase(phase), true, phase);
		assert.equal(nextStall(null, at(phase)).action, "nudge", phase);
	}
});

test("quick 的 revision 恒为 0,只靠相位变化归零", () => {
	const first = nextStall(null, at("plan", 0));
	const second = nextStall(first.state, at("plan", 0));
	assert.equal(second.action, "warn");
	const moved = nextStall(second.state, at("do", 0));
	assert.equal(moved.action, "nudge", "相位变了就该重新给机会");
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateAsk, FRAME_QUESTION_CAP } from "../frame.ts";

test("首轮 1~3 个问题放行,并做 trim", () => {
	const r = evaluateAsk({ askedRounds: 0, questions: ["  慢是指首屏还是接口?  ", "现在多少毫秒算慢?"] });
	assert.equal(r.ok, true);
	assert.deepEqual(r.ok && r.questions, ["慢是指首屏还是接口?", "现在多少毫秒算慢?"]);
});

test("超过上限被拒 —— 追问二十条比说'我不理解'更糟", () => {
	const qs = Array.from({ length: FRAME_QUESTION_CAP + 1 }, (_, i) => `q${i}`);
	const r = evaluateAsk({ askedRounds: 0, questions: qs });
	assert.equal(r.ok, false);
	assert.match(r.ok === false ? r.reason : "", /最多 3 个问题/);
});

test("只许问一轮:第二轮一律拒绝", () => {
	const r = evaluateAsk({ askedRounds: 1, questions: ["再问一个"] });
	assert.equal(r.ok, false);
	assert.match(r.ok === false ? r.reason : "", /只许问一轮/);
});

test("空问题不算提问", () => {
	assert.equal(evaluateAsk({ askedRounds: 0, questions: [] }).ok, false);
	assert.equal(evaluateAsk({ askedRounds: 0, questions: ["   ", ""] }).ok, false);
});

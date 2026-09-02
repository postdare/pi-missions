import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateAsk, needsScopeConfirm, roundCapFor, DEFINE_QUESTION_CAP, type AskQuestion } from "../define.ts";

function q(id: string, over: Partial<AskQuestion> = {}): AskQuestion {
	return { id, text: `${id} 慢是指首屏还是接口?`, recommend: "按接口 p95", impact: "决定 DW1 的度量口径", ...over };
}

function ask(over: Partial<Parameters<typeof evaluateAsk>[0]> = {}) {
	return evaluateAsk({ tier: "standard", askedRounds: 0, settled: [], prevSettled: [], questions: [q("Q1")], ...over });
}

test("首轮 1~3 个带推荐答案的问题放行,并做 trim", () => {
	const r = evaluateAsk({
		tier: "standard",
		askedRounds: 0,
		settled: [],
		prevSettled: [],
		questions: [q("Q1", { text: "  慢是指首屏还是接口?  ", recommend: "  按接口 p95  " })],
	});
	assert.equal(r.ok, true);
	assert.equal(r.ok && r.questions[0].text, "慢是指首屏还是接口?");
	assert.equal(r.ok && r.questions[0].recommend, "按接口 p95");
});

test("超过每轮上限被拒 —— 一口气追问二十条比说'我不理解'更糟", () => {
	const qs = Array.from({ length: DEFINE_QUESTION_CAP + 1 }, (_, i) => q(`Q${i}`));
	const r = ask({ questions: qs });
	assert.equal(r.ok, false);
	assert.match(r.ok === false ? r.reason : "", /一轮最多 3 个问题/);
});

test("没有推荐答案的问题被拒 —— 那是懒问题", () => {
	const r = ask({ questions: [q("Q1"), q("Q2", { recommend: "  " })] });
	assert.equal(r.ok, false);
	assert.match(r.ok === false ? r.reason : "", /没有给推荐答案:Q2/);
});

test("没写清影响的问题被拒 —— 改变不了任何东西的问题不该问", () => {
	const r = ask({ questions: [q("Q1", { impact: "" })] });
	assert.equal(r.ok, false);
	assert.match(r.ok === false ? r.reason : "", /没有写清影响/);
});

test("轮次上限按档位:standard 2 轮、complex 3 轮", () => {
	assert.equal(roundCapFor("standard"), 2);
	assert.equal(roundCapFor("complex"), 3);
	assert.equal(roundCapFor("quick"), 0);

	// standard 的第 3 轮(askedRounds=2)被拒,complex 同样输入还能问
	const settled = { settled: ["D1", "D2", "D3"], prevSettled: ["D1"] };
	const s = ask({ tier: "standard", askedRounds: 2, ...settled });
	assert.equal(s.ok, false);
	assert.match(s.ok === false ? s.reason : "", /轮次已经用完\(上限 2 轮\)/);
	assert.equal(ask({ tier: "complex", askedRounds: 2, ...settled }).ok, true);
});

test("quick 档没有 DEFINE,提问一律拒绝", () => {
	const r = ask({ tier: "quick" });
	assert.equal(r.ok, false);
	assert.match(r.ok === false ? r.reason : "", /不进 DEFINE/);
});

test("结账判据:上一轮没落定任何决策,不给下一轮", () => {
	const r = ask({ askedRounds: 1, settled: ["D1"], prevSettled: ["D1"] });
	assert.equal(r.ok, false);
	assert.match(r.ok === false ? r.reason : "", /没有任何决策落定/);
});

test("结账判据:落定数增长了就放行", () => {
	assert.equal(ask({ askedRounds: 1, settled: ["D1", "D2"], prevSettled: ["D1"] }).ok, true);
});

test("空问题不算提问", () => {
	assert.equal(ask({ questions: [] }).ok, false);
	assert.equal(ask({ questions: [q("Q1", { text: "   " })] }).ok, false);
});

test("范围确认:complex 恒确认,standard 只在问过之后确认,quick 不确认", () => {
	assert.equal(needsScopeConfirm("complex", 0), true);
	assert.equal(needsScopeConfirm("standard", 0), false);
	assert.equal(needsScopeConfirm("standard", 1), true);
	assert.equal(needsScopeConfirm("quick", 3), false);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateAsk, needsScopeConfirm, roundCapFor, normalizeAskAnswers, DEFINE_QUESTION_CAP, type AskQuestion } from "../define.ts";

function q(id: string, over: Partial<AskQuestion> = {}): AskQuestion {
	return { id, text: `${id} 慢是指首屏还是接口?`, recommend: "按接口 p95", impact: "决定 DW1 的度量口径", ...over };
}

function ask(over: Partial<Parameters<typeof evaluateAsk>[0]> = {}) {
	return evaluateAsk({ tier: "standard", askedRounds: 0, settled: [], prevSettled: [], questions: [q("Q1")], ...over });
}

test("recommend 必须命中某个选项 —— 对不上时旧实现静默回落到第一项", () => {
	// 界面靠 label === recommend 找推荐行并默认选中它。对不上时人看到的高亮
	// 不是模型推荐的那个,而没有任何地方提示 —— 静默回落比报错糟得多。
	const q = (recommend: string, options?: string[]) => ({
		id: "Q1", text: "副屏放什么?", impact: "决定完成条件", recommend, options,
	});
	const ask = (questions: any[]) =>
		evaluateAsk({ tier: "standard", askedRounds: 0, settled: [], prevSettled: [], questions });

	// 典型翻车:模型在选项文案里写了"(推荐)",recommend 里没写
	const bad = ask([q("组件和书签都能放", ["组件和书签都能放(推荐)", "只放组件"])]);
	assert.equal(bad.ok, false);
	assert.match((bad as any).reason, /recommend 不在 options 里/);
	assert.match((bad as any).reason, /别在选项文案里写/);

	// 逐字相同:放行
	assert.equal(ask([q("只放组件", ["组件和书签都能放", "只放组件"])]).ok, true);
	// 开放式问题(没给 options)不受这条约束 —— 推荐会被合成成唯一可选行
	assert.equal(ask([q("按视口宽度自适应")]).ok, true);
});

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
	assert.doesNotMatch(r.ok === false ? r.reason : "", /用你的/, "交互文案已换成选中高亮,不再指'回一句用你的'");
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

// ─────────────── normalizeAskAnswers(UI 答案 → resolved 记录) ───────────────

const QS: AskQuestion[] = [
	q("Q1", { text: "慢是指首屏还是接口?", options: ["首屏加载", "接口 p95"], recommend: "接口 p95" }),
	q("Q2", { text: "数据放哪张表?", recommend: "mem_tenant_member_info" }),
];

test("选了推荐项:按采用推荐记,fallback=false(人确认过);未答的题也产出,回落推荐", () => {
	const r = normalizeAskAnswers(QS, [{ kind: "option", value: "接口 p95" }]);
	assert.deepEqual(r, [
		{ q: "慢是指首屏还是接口?", a: "接口 p95", fallback: false },
		{ q: "数据放哪张表?", a: "mem_tenant_member_info", fallback: true },
	]);
});

test("选了别的选项:原样记录", () => {
	const r = normalizeAskAnswers(QS, [{ kind: "option", value: "首屏加载" }]);
	assert.deepEqual(r, [
		{ q: "慢是指首屏还是接口?", a: "首屏加载", fallback: false },
		{ q: "数据放哪张表?", a: "mem_tenant_member_info", fallback: true },
	]);
});

test("自由文本:trim 后原样记录", () => {
	const r = normalizeAskAnswers(QS, [{ kind: "custom", value: "  首屏和接口都要看  " }]);
	assert.deepEqual(r, [
		{ q: "慢是指首屏还是接口?", a: "首屏和接口都要看", fallback: false },
		{ q: "数据放哪张表?", a: "mem_tenant_member_info", fallback: true },
	]);
});

test("自由文本敲了空白:回落推荐,fallback=true", () => {
	const r = normalizeAskAnswers(QS, [{ kind: "custom", value: "   " }]);
	assert.deepEqual(r, [
		{ q: "慢是指首屏还是接口?", a: "接口 p95", fallback: true },
		{ q: "数据放哪张表?", a: "mem_tenant_member_info", fallback: true },
	]);
});

test("没答(undefined / none):回落推荐并打 fallback 标记", () => {
	const r = normalizeAskAnswers(QS, [undefined, { kind: "none" }]);
	assert.equal(r.length, 2);
	assert.deepEqual(r[0], { q: "慢是指首屏还是接口?", a: "接口 p95", fallback: true });
	assert.deepEqual(r[1], { q: "数据放哪张表?", a: "mem_tenant_member_info", fallback: true });
});

test("多题混合:答案按题目位置对齐", () => {
	const r = normalizeAskAnswers(QS, [
		{ kind: "custom", value: "两边都看" },
		{ kind: "option", value: "mem_tenant_member_info" },
	]);
	assert.deepEqual(r, [
		{ q: "慢是指首屏还是接口?", a: "两边都看", fallback: false },
		{ q: "数据放哪张表?", a: "mem_tenant_member_info", fallback: false },
	]);
});

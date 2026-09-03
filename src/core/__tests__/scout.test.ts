import { test } from "node:test";
import assert from "node:assert/strict";
import {
	evaluateScout,
	interpretFinding,
	isSurprise,
	SCOUT_FANOUT_CAP,
	scoutRoundCapFor,
	type ScoutQuestion,
} from "../scout.ts";

const q = (over: Partial<ScoutQuestion> = {}): ScoutQuestion => ({
	id: "S1",
	text: "旧 ORM 的私有 API 在哪些文件被用到,共几处?",
	why: "决定 T1 是一次性替换还是分批,以及要不要单开一条 verify 分支",
	assume: "3 处左右,集中在 repo 层",
	...over,
});

test("quick 档没有侦查环节 —— 而且必须先说这件事,不是先教它怎么写 assume", () => {
	assert.equal(scoutRoundCapFor("quick"), 0);
	// 故意给一个三处都不合格的问题:quick 应该只收到"没有这个环节",
	// 否则模型会照着 assume/why 的指导改一遍,再撞一次墙
	const r = evaluateScout({ tier: "quick", askedRounds: 0, asked: [], questions: [q({ why: "", assume: "" })] });
	assert.equal(r.ok, false);
	if (!r.ok) {
		assert.match(r.reason, /quick 档没有侦查环节/);
		assert.doesNotMatch(r.reason, /assume/);
	}
});

test("轮次上限:standard 1 轮、complex 2 轮,用完就拒", () => {
	assert.equal(scoutRoundCapFor("standard"), 1);
	assert.equal(scoutRoundCapFor("complex"), 2);

	const used = evaluateScout({ tier: "standard", askedRounds: 1, asked: [{ id: "S1", text: "x" }], questions: [q({ id: "S9" })] });
	assert.equal(used.ok, false);
	// 拒的时候要指出还有哪条路可走,否则模型只会换个措辞再试一次
	if (!used.ok) assert.match(used.reason, /spike/);

	const ok = evaluateScout({ tier: "complex", askedRounds: 1, asked: [{ id: "S1", text: "x" }], questions: [q({ id: "S9", follows: "S1" })] });
	assert.equal(ok.ok, true);
});

test("一轮最多扇出 4 路", () => {
	const five = Array.from({ length: SCOUT_FANOUT_CAP + 1 }, (_, i) => q({ id: `S${i}`, text: `问题 ${i}` }));
	const r = evaluateScout({ tier: "standard", askedRounds: 0, asked: [], questions: five });
	assert.equal(r.ok, false);
	if (!r.ok) assert.match(r.reason, /最多扇出 4 路/);
});

test("每题必须有 why 和 assume —— 没有假设的问题太笼统,查了也用不上", () => {
	const noWhy = evaluateScout({ tier: "standard", askedRounds: 0, asked: [], questions: [q({ why: "" })] });
	assert.equal(noWhy.ok, false);
	if (!noWhy.ok) assert.match(noWhy.reason, /没写清影响/);

	const noAssume = evaluateScout({ tier: "standard", askedRounds: 0, asked: [], questions: [q({ assume: "" })] });
	assert.equal(noAssume.ok, false);
	if (!noAssume.ok) assert.match(noAssume.reason, /当前假设/);
});

test("换个措辞把上一轮的问题再问一遍会被拒 —— 原地打转最常见的形态", () => {
	const asked = [{ id: "S1", text: "旧 ORM 的私有 API 在哪些文件被用到,共几处?" }];
	// 标点、空格全变了,实质是同一个问题
	const r = evaluateScout({
		tier: "complex",
		askedRounds: 1,
		asked,
		questions: [q({ id: "S2", follows: "S1", text: "旧 ORM 的私有 API  在哪些文件被用到 共几处" })],
	});
	assert.equal(r.ok, false);
	if (!r.ok) assert.match(r.reason, /前面已经查过/);
});

test("第二轮起必须用 follows 挂在上一轮的问题上", () => {
	const asked = [{ id: "S1", text: "A" }];
	const stray = evaluateScout({ tier: "complex", askedRounds: 1, asked, questions: [q({ id: "S2", text: "B" })] });
	assert.equal(stray.ok, false);
	if (!stray.ok) assert.match(stray.reason, /没给 follows/);

	const bogus = evaluateScout({
		tier: "complex",
		askedRounds: 1,
		asked,
		questions: [q({ id: "S2", text: "B", follows: "S7" })],
	});
	assert.equal(bogus.ok, false);
	if (!bogus.ok) assert.match(bogus.reason, /不存在/);
});

test("首轮不要求 follows —— 它只在'这一轮是上一轮打开的'时才有意义", () => {
	const r = evaluateScout({ tier: "standard", askedRounds: 0, asked: [], questions: [q()] });
	assert.equal(r.ok, true);
});

test("同一轮里 id 重复会被拒 —— 结论按 id 对应回来,重了就对不上", () => {
	const r = evaluateScout({
		tier: "standard",
		askedRounds: 0,
		asked: [],
		questions: [q({ id: "S1", text: "A" }), q({ id: "S1", text: "B" })],
	});
	assert.equal(r.ok, false);
	if (!r.ok) assert.match(r.reason, /id 重复/);
});

test("isSurprise:结论与假设实质不同才算有出入", () => {
	assert.equal(isSurprise("3 处左右", "3 处左右,都在 repo 层"), false, "结论包含假设 = 假设被证实");
	assert.equal(isSurprise("3 处左右", "11 处"), true);
	// 拿不准时**报有出入**,而不是报"已确认" —— 后者会让 planner 更信任一个错假设
	assert.equal(isSurprise("三处", "3 处"), true);
	assert.equal(isSurprise("", "任何结论"), false, "没有假设就谈不上出入");
});

test("interpret:found=true 但没有出处 → 降级未查明", () => {
	// 没有出处的自然语言结论不可证伪,它对下游的唯一作用是让 planner 更自信地写错 AC
	const { finding, failure } = interpretFinding(q({ assume: "3 处" }), { found: true, answer: "大概 11 处", citations: [] });
	assert.equal(finding.status, "unanswered");
	assert.match(finding.answer, /未采信\(无出处\)/);
	assert.match(finding.answer, /沿用假设:3 处/);
	assert.match(failure ?? "", /没有出处/);
});

test("interpret:子 agent 自报没查到时,保留它查过哪里 —— 那能省掉下一轮的重复劳动", () => {
	const { finding } = interpretFinding(q(), { found: false, answer: "翻了 src/repo 与 src/db,没有私有 API 的调用", citations: [] });
	assert.equal(finding.status, "unanswered");
	assert.match(finding.answer, /翻了 src\/repo 与 src\/db/);
});

test("interpret:空结论与非对象载荷都算未查明,绝不能当成查明", () => {
	for (const bad of [null, undefined, "结论", { found: true, answer: "   ", citations: ["a.ts"] }]) {
		assert.equal(interpretFinding(q(), bad).finding.status, "unanswered", `${JSON.stringify(bad)} 不该被采信`);
	}
});

test("interpret:结论与假设不同的标 surprised —— 这是这轮扇出唯一买到的东西", () => {
	const same = interpretFinding(q({ assume: "3 处" }), { found: true, answer: "3 处", citations: ["a.ts:1"] });
	assert.equal(same.finding.surprised, false);
	const diff = interpretFinding(q({ assume: "3 处" }), { found: true, answer: "11 处", citations: ["a.ts:1"] });
	assert.equal(diff.finding.surprised, true);
});

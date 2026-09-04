import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateAcImmutability, type AcSnapshot } from "../replan.ts";

const FROZEN: AcSnapshot[] = [
	{ id: "AC1", text: "解析 HH:MM 与 n分钟", verify: "parse-remind", covers: ["DW1"] },
	{
		id: "AC5",
		text: "回归:现有行为不变,go test ./... 全绿,无需修改现有测试断言",
		verify: "regression-green",
		covers: ["DW4"],
		baseline: "green",
	},
];

const clone = (): AcSnapshot[] => JSON.parse(JSON.stringify(FROZEN));

test("首次冻结没有基准 —— 放行(建 mission 时 acceptanceCriteria 是空数组)", () => {
	assert.deepEqual(evaluateAcImmutability({ escalationLevel: 1, frozen: [], submitted: clone() }), []);
});

test("L3 放行 —— 它的定义就是可以改 AC,而且绕道 DEFINE 有人工确认", () => {
	const submitted = clone();
	submitted[1].text = "换了一句完全不同的话";
	assert.deepEqual(evaluateAcImmutability({ escalationLevel: 3, frozen: FROZEN, submitted }), []);
});

test("L2 原样重交 —— 放行", () => {
	assert.deepEqual(evaluateAcImmutability({ escalationLevel: 2, frozen: FROZEN, submitted: clone() }), []);
});

test("L2 改 text 被拦 —— E7 真机那次 id 一个没变,变的就是 text", () => {
	const submitted = clone();
	// 删掉的正是独立核验判它 FAIL 时援引的那半句
	submitted[1].text = "回归:现有测试全绿";
	const errors = evaluateAcImmutability({ escalationLevel: 2, frozen: FROZEN, submitted });
	assert.equal(errors.length, 1);
	assert.match(errors[0], /AC5/);
	assert.match(errors[0], /text/);
	// 打回必须带上冻结时的原文,否则 planner 不知道自己动了哪一句
	assert.match(errors[0], /无需修改现有测试断言/);
	assert.match(errors[0], /L3/);
});

test("L2 改 verify 分支名被拦 —— 换个裁判和改判据是一回事", () => {
	const submitted = clone();
	submitted[0].verify = "parse-remind-v2";
	const errors = evaluateAcImmutability({ escalationLevel: 2, frozen: FROZEN, submitted });
	assert.equal(errors.length, 1);
	assert.match(errors[0], /verify/);
});

test("L2 改 covers 被拦", () => {
	const submitted = clone();
	submitted[0].covers = ["DW1", "DW2"];
	const errors = evaluateAcImmutability({ escalationLevel: 2, frozen: FROZEN, submitted });
	assert.equal(errors.length, 1);
	assert.match(errors[0], /covers/);
});

test("covers 只换顺序不算改 —— 它是集合,不是列表", () => {
	const frozen: AcSnapshot[] = [{ id: "AC1", text: "t", verify: "v", covers: ["DW2", "DW1"] }];
	const submitted: AcSnapshot[] = [{ id: "AC1", text: "t", verify: "v", covers: ["DW1", "DW2"] }];
	assert.deepEqual(evaluateAcImmutability({ escalationLevel: 2, frozen, submitted }), []);
});

test("L2 改 baseline 被拦;而显式写出缺省的 red 不算改", () => {
	const flipped = clone();
	flipped[1].baseline = "red";
	const errors = evaluateAcImmutability({ escalationLevel: 2, frozen: FROZEN, submitted: flipped });
	assert.equal(errors.length, 1);
	assert.match(errors[0], /baseline/);

	// AC1 冻结时没写 baseline(缺省 red),这次显式写 red —— 同一件事,不该报
	const explicit = clone();
	explicit[0].baseline = "red";
	assert.deepEqual(evaluateAcImmutability({ escalationLevel: 2, frozen: FROZEN, submitted: explicit }), []);
});

test("空白差异不算改 —— 多一个空格不是改判据", () => {
	const submitted = clone();
	submitted[0].text = "  解析 HH:MM   与 n分钟 ";
	assert.deepEqual(evaluateAcImmutability({ escalationLevel: 2, frozen: FROZEN, submitted }), []);
});

test("L2 删掉一条 AC 被拦", () => {
	const errors = evaluateAcImmutability({ escalationLevel: 2, frozen: FROZEN, submitted: [clone()[0]] });
	assert.equal(errors.length, 1);
	assert.match(errors[0], /AC5/);
});

test("L2 新增一条 AC 被拦 —— 冻结之后夹带进来的没人批准过", () => {
	const submitted = [...clone(), { id: "AC9", text: "偷加的", verify: "sneak", covers: ["DW1"] }];
	const errors = evaluateAcImmutability({ escalationLevel: 2, frozen: FROZEN, submitted });
	assert.equal(errors.length, 1);
	assert.match(errors[0], /AC9/);
});

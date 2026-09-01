import { test } from "node:test";
import assert from "node:assert/strict";
import { baselineOf, evaluateBaseline, shouldProbeBaseline, type BaselineProbe } from "../baseline.ts";

const probe = (o: Partial<BaselineProbe> = {}): BaselineProbe => ({
	acId: "AC1",
	verify: "hello-exists",
	expected: "red",
	exitCode: 1,
	...o,
});

test("退出码 0 是绿,其余都是红", () => {
	assert.equal(baselineOf(0), "green");
	assert.equal(baselineOf(1), "red");
	assert.equal(baselineOf(2), "red");
});

test("红基线的 AC 跑出非零:通过", () => {
	assert.deepEqual(evaluateBaseline([probe()]), []);
});

test("空壳 AC(冻结时就绿)被挡住", () => {
	const errs = evaluateBaseline([probe({ exitCode: 0 })]);
	assert.equal(errs.length, 1);
	assert.match(errs[0], /在动手之前就已经通过/);
});

test("回归型 AC 显式声明 green 才放行", () => {
	assert.deepEqual(
		evaluateBaseline([probe({ exitCode: 1 }), probe({ acId: "AC2", verify: "no-regression", expected: "green", exitCode: 0 })]),
		[],
	);
});

test("声明 green 但基线已经是红的:先修再冻结", () => {
	const errs = evaluateBaseline([probe({ acId: "AC2", expected: "green", exitCode: 1 })]);
	assert.equal(errs.length, 1);
	assert.match(errs[0], /基线已经坏了/);
});

test("分支跑不起来(126/127)不算红", () => {
	for (const code of [126, 127]) {
		const errs = evaluateBaseline([probe({ exitCode: code })]);
		assert.equal(errs.length, 1, `exit=${code}`);
		assert.match(errs[0], /无法执行/);
	}
});

test("全是回归项:mission 不产出新东西", () => {
	const errs = evaluateBaseline([
		probe({ acId: "AC1", expected: "green", exitCode: 0 }),
		probe({ acId: "AC2", expected: "green", exitCode: 0 }),
	]);
	assert.equal(errs.length, 1);
	assert.match(errs[0], /至少需要一条 red/);
});

test("没有 AC 就没有基线", () => {
	assert.equal(evaluateBaseline([]).length, 1);
});

test("多条 AC 的错误逐条报出", () => {
	const errs = evaluateBaseline([
		probe({ acId: "AC1", exitCode: 0 }),
		probe({ acId: "AC2", verify: "b", exitCode: 127 }),
		probe({ acId: "AC3", verify: "c", exitCode: 1 }),
	]);
	assert.equal(errs.length, 2);
	assert.ok(errs[0].includes("AC1"));
	assert.ok(errs[1].includes("AC2"));
});

test("基线只在首次冻结跑 —— 重规划时世界已被改过", () => {
	assert.equal(shouldProbeBaseline(0), true);
	assert.equal(shouldProbeBaseline(1), false, "L2 之后不能再拿冻结时刻的红绿说事");
	assert.equal(shouldProbeBaseline(2), false);
});

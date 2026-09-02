import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateCoverage } from "../coverage.ts";

const DW = [{ id: "DW1" }, { id: "DW2" }];

test("每条完成条件都被覆盖、每条 AC 都有归属 —— 通过", () => {
	const errors = evaluateCoverage({
		doneWhen: DW,
		acs: [
			{ id: "AC1", covers: ["DW1"] },
			{ id: "AC2", covers: ["DW1", "DW2"] },
		],
	});
	assert.deepEqual(errors, []);
});

test("漏覆盖被拦 —— 那是'人以为会做、机器不会验'的部分", () => {
	const errors = evaluateCoverage({ doneWhen: DW, acs: [{ id: "AC1", covers: ["DW1"] }] });
	assert.equal(errors.length, 1);
	assert.match(errors[0], /没有任何 AC 覆盖:DW2/);
});

test("孤儿 AC 被拦 —— planner 在批准的目标之外自己加戏", () => {
	const errors = evaluateCoverage({
		doneWhen: DW,
		acs: [
			{ id: "AC1", covers: ["DW1", "DW2"] },
			{ id: "AC2", covers: [] },
		],
	});
	assert.ok(errors.some((e) => /AC2 没有声明它覆盖哪条完成条件/.test(e)));
});

test("covers 引用不存在的完成条件被拦", () => {
	const errors = evaluateCoverage({
		doneWhen: DW,
		acs: [{ id: "AC1", covers: ["DW1", "DW2", "DW9"] }],
	});
	assert.ok(errors.some((e) => /引用了不存在的完成条件 "DW9"/.test(e)));
});

test("空白项不算数:covers 全是空串等同于没声明", () => {
	const errors = evaluateCoverage({ doneWhen: DW, acs: [{ id: "AC1", covers: ["  ", ""] }] });
	assert.ok(errors.some((e) => /AC1 没有声明/.test(e)));
});

test("畸形输入不抛异常 —— 裁判被打崩比判错更糟", () => {
	// covers/doneWhen 来自 LLM 工具参数与 fence,类型上必填不代表运行时一定在
	const noCovers = evaluateCoverage({ doneWhen: DW, acs: [{ id: "AC1" } as never] });
	assert.ok(noCovers.some((e) => /AC1 没有声明/.test(e)));
	assert.deepEqual(evaluateCoverage({ acs: [] } as never), [
		"definition.doneWhen 为空:没有完成条件就没有东西可覆盖,回 DEFINE 把问题定义补完整",
	]);
});

test("doneWhen 为空本身就是错误 —— 没有完成条件就没有东西可覆盖", () => {
	const errors = evaluateCoverage({ doneWhen: [], acs: [{ id: "AC1", covers: [] }] });
	assert.equal(errors.length, 1);
	assert.match(errors[0], /doneWhen 为空/);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { reportIsSubstantive, validateSpikePlan, SPIKE_REPORT_MIN_CHARS } from "../spike.ts";

test("没有 spike 的计划恒合法", () => {
	assert.deepEqual(validateSpikePlan({ spikeTaskIds: [], alreadyRanSpike: false }), []);
	assert.deepEqual(validateSpikePlan({ spikeTaskIds: [], alreadyRanSpike: true }), []);
});

test("一个计划最多一个 spike", () => {
	assert.deepEqual(validateSpikePlan({ spikeTaskIds: ["T1"], alreadyRanSpike: false }), []);
	const errs = validateSpikePlan({ spikeTaskIds: ["T1", "T3"], alreadyRanSpike: false });
	assert.equal(errs.length, 1);
	assert.match(errs[0], /最多一个 spike/);
});

test("跑过一次就不许再探 —— 否则等于无限期推迟动手", () => {
	const errs = validateSpikePlan({ spikeTaskIds: ["T1"], alreadyRanSpike: true });
	assert.equal(errs.length, 1);
	assert.match(errs[0], /已经跑过一次 spike/);
});

test("结论文件太短不算结论", () => {
	assert.equal(reportIsSubstantive(null), false);
	assert.equal(reportIsSubstantive(""), false);
	assert.equal(reportIsSubstantive("   \n  "), false);
	assert.equal(reportIsSubstantive("TODO"), false);
	assert.equal(reportIsSubstantive("x".repeat(SPIKE_REPORT_MIN_CHARS - 1)), false);
	assert.equal(reportIsSubstantive("x".repeat(SPIKE_REPORT_MIN_CHARS)), true);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { validatePlan, type MissionPlan } from "../src/store/mission.ts";

// core/verify-script 的单测证明规则判得对;这里证明它**接上了** ——
// 规则再准,没挂进 validatePlan 就是一段死代码。

function planWith(verifyScript: string): MissionPlan {
	return {
		missionId: "2026-09-04-demo",
		tier: "standard",
		goal: "示例",
		acceptanceCriteria: [
			{ id: "AC1", text: "实现", verify: "impl", covers: ["DW1"], baseline: "red" },
			{ id: "AC2", text: "回归", verify: "regression", covers: ["DW1"], baseline: "green" },
		],
		milestones: [
			{
				id: "M1",
				title: "做完",
				tasks: [{ id: "T1", title: "实现", verify: ["impl", "regression"] }],
			},
		],
		verifyScript,
		createdAt: 0,
		definition: {
			doneWhen: [{ id: "DW1", text: "跑得起来" }],
			constraints: [],
			nonGoals: [],
			verifySeam: "go test",
			resolved: [],
			at: 0,
		},
	} as MissionPlan;
}

const GOOD = `#!/usr/bin/env bash
set -u
case "\${1:-}" in
  impl) go test ./internal/api -run TestX ;;
  regression) go test ./... ;;
esac
`;

test("validatePlan:脚本不碰工作目录时,一条 cwd 相关的错都不报", () => {
	assert.deepEqual(validatePlan(planWith(GOOD)), []);
});

test("validatePlan:cd 到脚本自己的目录会被打回,并说清哪一行、为什么、该写成什么", () => {
	const errors = validatePlan(
		planWith(`#!/usr/bin/env bash
set -u
cd "$(dirname "$0")"
case "\${1:-}" in
  impl) go test ./internal/api -run TestX ;;
  regression) go test ./... ;;
esac
`),
	);
	assert.equal(errors.length, 1, `只该报这一处:${JSON.stringify(errors, null, 2)}`);
	assert.match(errors[0], /第 3 行/);
	assert.match(errors[0], /冻结件/);
	assert.match(errors[0], /不是换一种 cd/);
});

test("validatePlan:在临时目录里跑构建会被打回", () => {
	const errors = validatePlan(
		planWith(`#!/usr/bin/env bash
set -u
TMP="$(mktemp -d)"
case "\${1:-}" in
  impl) ( cd "$TMP" && go build -o "$TMP/srv" ./cmd/srv ) ;;
  regression) go test ./... ;;
esac
`),
	);
	assert.equal(errors.length, 1, `只该报这一处:${JSON.stringify(errors, null, 2)}`);
	assert.match(errors[0], /临时目录/);
	assert.match(errors[0], /-o/);
});

// quick 档的计划本来就没有 verify.sh(判据是一条命令,见 core/criterion)。
// 空脚本不该因为"没找到 cd"之外的任何理由被这道检查拦下。
test("validatePlan:空 verifyScript 不触发 cwd 检查", () => {
	const errors = validatePlan(planWith(""));
	assert.ok(
		!errors.some((e) => e.includes("工作目录")),
		`空脚本不该报 cwd 问题:${JSON.stringify(errors, null, 2)}`,
	);
});

test("validatePlan:cwd 检查不会盖掉原有的分支缺失检查", () => {
	const errors = validatePlan(
		planWith(`#!/usr/bin/env bash
cd "$(dirname "$0")"
case "\${1:-}" in
  impl) go test ./... ;;
esac
`),
	);
	// regression 分支不存在 + cd 问题,两条都要报出来
	assert.ok(
		errors.some((e) => e.includes("regression")),
		"原有的分支缺失检查不能被挤掉",
	);
	assert.ok(errors.some((e) => e.includes("工作目录")));
});

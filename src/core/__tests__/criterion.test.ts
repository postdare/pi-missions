import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateCriterion } from "../criterion.ts";

const GOAL = "把导航栏在窄屏下改成汉堡菜单";

test("正常判据放行:说清了可观察的状态", () => {
	const r = evaluateCriterion({ goal: GOAL, text: "窄屏下导航折叠成汉堡,点开含全部链接,宽屏布局不变" });
	assert.equal(r.ok, true);
});

test("中文判据不含任何 ASCII 也放行(锚点只用来赦免空泛词,不是硬性要求)", () => {
	const r = evaluateCriterion({ goal: GOAL, text: "窄屏下导航折叠成汉堡菜单,点开能看到全部入口" });
	assert.equal(r.ok, true, "误杀正常中文判据比放过空泛判据更糟");
});

test("太短的判据拒绝", () => {
	const r = evaluateCriterion({ goal: GOAL, text: "能用" });
	assert.equal(r.ok, false);
	assert.ok(r.ok === false && r.reason.includes("太短"));
});

test("目标的复读拒绝 —— 判据必须是转写,不是复制", () => {
	const r = evaluateCriterion({ goal: GOAL, text: GOAL });
	assert.equal(r.ok, false);
	assert.ok(r.ok === false && r.reason.includes("复读"));
});

test("加了标点和空格的复读同样拒绝(归一化后比较)", () => {
	const r = evaluateCriterion({ goal: GOAL, text: "把导航栏,在窄屏下改成汉堡菜单。" });
	assert.equal(r.ok, false);
});

test("空泛且无锚点拒绝:这种判据 verifier 拿到也只能靠印象", () => {
	for (const text of ["页面样式正确显示出来", "改完之后一切正常没有问题", "交互体验更好了一些"]) {
		const r = evaluateCriterion({ goal: GOAL, text });
		assert.equal(r.ok, false, text);
	}
});

test("空泛词 + 具体锚点放行:「HTTP 200 正确返回」是具体的", () => {
	assert.equal(evaluateCriterion({ goal: GOAL, text: "刷新后接口返回 HTTP 200,列表正确渲染 5 条" }).ok, true);
	assert.equal(evaluateCriterion({ goal: GOAL, text: "media query 在 768px 处正确生效" }).ok, true);
});

test("引号里的字面量也算锚点", () => {
	assert.equal(evaluateCriterion({ goal: GOAL, text: "按钮文案正确显示为「立即领取」" }).ok, true);
});

test("英文空泛判据同样拦得住", () => {
	assert.equal(evaluateCriterion({ goal: "fix the nav", text: "it works properly now" }).ok, false);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { wrapGoal } from "../src/ui/tier-indicator.ts";

test("quick 档:输入目标自动拼 /mission quick", () => {
	assert.equal(wrapGoal("修复登录 bug", "quick"), "/mission quick 修复登录 bug");
});

test("standard/complex 档:拼 /mission new(档位由 pendingTier 消费)", () => {
	assert.equal(wrapGoal("迁移鉴权到 JWT", "standard"), "/mission new 迁移鉴权到 JWT");
	assert.equal(wrapGoal("迁移鉴权到 JWT", "complex"), "/mission new 迁移鉴权到 JWT");
});

test("以 / 开头的输入原样放行(逃生口:手动命令/普通消息)", () => {
	assert.equal(wrapGoal("/mission status", "complex"), "/mission status");
	assert.equal(wrapGoal("/missions", "quick"), "/missions");
});

test("空白输入放行,不拼命令", () => {
	assert.equal(wrapGoal("   ", "standard"), "   ");
});

test("无档位时不包裹", () => {
	assert.equal(wrapGoal("随便说点什么", null), "随便说点什么");
});

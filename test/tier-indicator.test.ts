import { test } from "node:test";
import assert from "node:assert/strict";
import { applyTierIndicator, wrapGoal } from "../src/ui/tier-indicator.ts";

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

test("档位选择期间按 Esc:取消选择、恢复默认编辑器、保留已输入文字", () => {
	let editorFactory: ((tui: any, theme: any) => any) | undefined;
	const notifications: string[] = [];
	const editorTexts: string[] = [];
	const ctx = {
		hasUI: true,
		ui: {
			setWidget: () => {},
			setEditorComponent: (factory?: any) => {
				editorFactory = factory;
			},
			setEditorText: (text: string) => editorTexts.push(text),
			notify: (m: string) => notifications.push(m),
			theme: { fg: (_c: string, s: string) => s },
		},
	};
	let cancelled = 0;
	applyTierIndicator(ctx, "quick", () => {
		cancelled += 1;
	});
	assert.ok(editorFactory, "档位生效时编辑器被替换");

	const editor = editorFactory!({} as any, {} as any);
	editor.handleInput("a"); // 普通按键照常下发,不抛错
	editor.handleInput("\x1b"); // Esc

	assert.equal(cancelled, 1, "onCancel 回调触发一次(清 pendingTier)");
	assert.equal(editorFactory, undefined, "取消后恢复默认编辑器");
	assert.ok(notifications.some((n) => n.includes("取消")));
	assert.equal(wrapGoal("新目标"), "新目标", "取消后输入不再被包裹成命令");
});

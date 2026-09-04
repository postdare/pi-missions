/**
 * pi-missions · 模型页的纯逻辑
 *
 * 重点是 resolveRoleView:面板必须显示**实际生效**的模型,
 * 而不是配置里写了什么 —— applyRole 在模型不可用时会静默回退到会话模型。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
	cycleThinking,
	DEFAULT_THINKING,
	resolveRoleView,
	THINKING_LEVELS,
	type ModelsConfig,
} from "../src/roles/models.ts";
import { visibleWidth } from "@earendil-works/pi-tui";
import { filterModels, modelRows } from "../src/ui/models-page.ts";

const yes = () => true;
const no = () => false;

test("未配置:显示跟随会话 + 角色默认 thinking", () => {
	const v = resolveRoleView({}, "verifier", yes, "anthropic/opus");
	assert.equal(v.state, "inherit");
	assert.ok(v.label.includes("anthropic/opus"));
	assert.equal(v.thinking, DEFAULT_THINKING.verifier);
	assert.equal(v.thinkingIsDefault, true);
});

test("配置且可用:显示配置值", () => {
	const cfg: ModelsConfig = { verifier: { provider: "openai", model: "gpt-x", thinking: "low" } };
	const v = resolveRoleView(cfg, "verifier", yes, "anthropic/opus");
	assert.equal(v.state, "configured");
	assert.equal(v.label, "openai/gpt-x");
	assert.equal(v.thinking, "low");
	assert.equal(v.thinkingIsDefault, false);
});

test("配置了但不可用:必须显示实际会用的那个,而不是配置值", () => {
	const cfg: ModelsConfig = { verifier: { provider: "openai", model: "gpt-x" } };
	const v = resolveRoleView(cfg, "verifier", no, "anthropic/opus");
	assert.equal(v.state, "unavailable");
	assert.ok(v.label.includes("openai/gpt-x"), "要说明配的是什么");
	assert.ok(v.label.includes("anthropic/opus"), "更要说明实际用的是什么");
});

test("只配了 thinking 没配模型,仍算跟随会话", () => {
	const v = resolveRoleView({ planner: { thinking: "max" } }, "planner", yes, "s/m");
	assert.equal(v.state, "inherit");
	assert.equal(v.thinking, "max");
	assert.equal(v.thinkingIsDefault, false);
});

test("thinking 循环从角色默认值起步并回绕", () => {
	assert.equal(cycleThinking(undefined, "verifier"), THINKING_LEVELS[1], "verifier 默认 off → 下一档");
	assert.equal(cycleThinking(THINKING_LEVELS.at(-1), "planner"), THINKING_LEVELS[0]);
	assert.equal(cycleThinking("不认识的档位", "planner"), THINKING_LEVELS[0]);
});

test("模型过滤按 provider/id/name 匹配,大小写无关", () => {
	const models = [
		{ provider: "anthropic", id: "claude-opus-5" },
		{ provider: "openai", id: "gpt-5.6", name: "Sol" },
	];
	assert.equal(filterModels(models, "").length, 2);
	assert.equal(filterModels(models, "OPUS")[0].id, "claude-opus-5");
	assert.equal(filterModels(models, "sol")[0].id, "gpt-5.6");
	assert.equal(filterModels(models, "nope").length, 0);
});

test("窄列宽时牺牲「配的是什么」,保住「实际用的是什么」", () => {
	const t = { fg: (_c: string, s: string) => s, bold: (s: string) => s };
	const d = {
		config: { verifier: { provider: "postdare", model: "glm-5.3-flash-一个很长的名字" } },
		models: [{ provider: "anthropic", id: "claude-opus-5" }],
		sessionLabel: "anthropic/claude-opus-5",
		cost: {},
		tokens: {},
		activeRole: null,
		dirName: "missions",
	};
	for (const width of [60, 80, 100, 140]) {
		const row = modelRows(d, 0, t, width).find((l) => l.includes("verifier"))!;
		assert.ok(
			row.includes("anthropic/claude-opus-5"),
			`width=${width}:实际生效的模型必须完整可见,否则这一页就退化成"照抄配置"`,
		);
		assert.ok(visibleWidth(row) <= width, `width=${width}:行不许超宽`);
	}
});

test("模型名那一列不随面板变宽而拉长 —— thinking 要紧跟模型名", () => {
	const t = { fg: (_c: string, s: string) => s, bold: (s: string) => s };
	const d = {
		config: {
			planner: { provider: "anthropic", model: "claude-opus-5", thinking: "high" },
			executor: { provider: "anthropic", model: "claude-sonnet-5", thinking: "medium" },
		},
		models: [
			{ provider: "anthropic", id: "claude-opus-5" },
			{ provider: "anthropic", id: "claude-sonnet-5" },
		],
		sessionLabel: "anthropic/claude-opus-5",
		cost: {},
		tokens: {},
		activeRole: null,
		dirName: "missions",
	};
	const offsetOf = (width: number) => {
		const row = modelRows(d, 0, t, width).find((l) => l.includes("planner"))!;
		return row.indexOf("high");
	};
	assert.equal(offsetOf(200), offsetOf(100), "列宽应由最长的模型名决定,而不是吃满剩余空间");
	// 而且要真的贴着最长的那个名字,不是留一大片空
	const row = modelRows(d, 0, t, 200).find((l) => l.includes("planner"))!;
	const longest = "anthropic/claude-opus-5(跟随会话)"; // inherit 行最长
	assert.ok(
		row.indexOf("high") - row.indexOf("anthropic/claude-opus-5") <= visibleWidth(longest) + 2,
		"模型名与 thinking 之间的空当不该超过最长名字 + 一格留白",
	);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import {
	applyTierIndicator,
	modelSummary,
	TIER_PLACEHOLDER,
	titledTopBorder,
	withPlaceholder,
	withSideBorders,
	wrapGoal,
} from "../src/ui/tier-indicator.ts";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import type { RoleModelView } from "../src/roles/models.ts";

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

	// CustomEditor 需要键位管理器(Ctrl+V 图片粘贴拦截在 handleInput 里);mock 只要 matches 返回 false
	const keybindings = { matches: () => false };
	const editor = editorFactory!({} as any, {} as any, keybindings);
	editor.handleInput("a"); // 普通按键照常下发,不抛错
	editor.handleInput("\x1b"); // Esc

	assert.equal(cancelled, 1, "onCancel 回调触发一次(清 pendingTier)");
	assert.equal(editorFactory, undefined, "取消后恢复默认编辑器");
	assert.ok(notifications.some((n) => n.includes("取消")));
	assert.equal(wrapGoal("新目标"), "新目标", "取消后输入不再被包裹成命令");
});

// ─────────────────────────── 模型摘要 ───────────────────────────

const view = (role: any, over: Partial<RoleModelView> = {}): RoleModelView =>
	({ role, state: "configured", label: "zhipu/glm-5.3-flash", thinking: "medium", thinkingIsDefault: true, ...over }) as RoleModelView;

test("modelSummary:四个角色同一模型时只显示一次,并剥掉 provider 前缀", () => {
	const views = ["planner", "executor", "verifier", "escalator"].map((r) => view(r));
	assert.equal(modelSummary(views, "zhipu/glm-5.3-flash"), "glm-5.3-flash");
});

test("modelSummary:只列偏离多数派的角色", () => {
	const views = [
		view("planner"),
		view("executor"),
		view("verifier", { label: "zhipu/glm-4.6-air" }),
		view("escalator"),
	];
	assert.equal(modelSummary(views, "zhipu/glm-5.3-flash"), "glm-5.3-flash(verifier glm-4.6-air)");
});

test("modelSummary:全员未配置时标出跟随会话(否则会以为在用便宜模型)", () => {
	const views = ["planner", "executor", "verifier", "escalator"].map((r) =>
		view(r, { state: "inherit", label: "zhipu/glm-5.3-flash(跟随会话)" }),
	);
	assert.equal(modelSummary(views, "zhipu/glm-5.3-flash"), "glm-5.3-flash(跟随会话)");
});

test("modelSummary:配了但不可用的角色按实际回退的模型比较,不按配置值", () => {
	const views = [
		view("planner"),
		view("executor"),
		view("verifier", {
			state: "unavailable",
			label: "openai/o9 → 实际用 zhipu/glm-5.3-flash",
			configured: "openai/o9",
			actual: "zhipu/glm-5.3-flash",
		}),
		view("escalator"),
	];
	// 实际跑的还是同一个模型 —— 指示条不该报一个假的"例外"
	assert.equal(modelSummary(views, "zhipu/glm-5.3-flash"), "glm-5.3-flash");
});

test("modelSummary:没有任何角色视图时返回空串(指示条省略这一段)", () => {
	assert.equal(modelSummary([], "zhipu/glm-5.3-flash"), "");
});

// ─────────────────────────── 空编辑器提示 ───────────────────────────

const dim = (x: string) => `\x1b[2m${x}\x1b[0m`;

test("withPlaceholder:贴上提示后每行可见宽度严格不变(差一列会撕开盒子)", () => {
	const lines = ["─".repeat(40), ` \x1b[7m \x1b[0m${" ".repeat(37)}`, "─".repeat(40)];
	const out = withPlaceholder(lines, "请输入目标", dim);
	assert.notEqual(out[1], lines[1], "提示贴上了");
	assert.ok(out[1].includes("请输入目标"));
	for (let i = 0; i < lines.length; i++) {
		assert.equal(visibleWidth(out[i]), visibleWidth(lines[i]), `第 ${i} 行宽度不变`);
	}
});

test("withPlaceholder:左内边距原样保留,提示接在光标之后", () => {
	const lines = ["─".repeat(40), `  \x1b[7m \x1b[0m${" ".repeat(36)}`, "─".repeat(40)];
	const out = withPlaceholder(lines, "请输入目标", dim);
	assert.ok(out[1].startsWith("  \x1b[7m \x1b[0m"), "左 padding 与光标块没被动过");
});

test("withPlaceholder:放不下就整条不贴,绝不截断出半截提示", () => {
	const lines = ["─".repeat(12), ` \x1b[7m \x1b[0m${" ".repeat(9)}`, "─".repeat(12)];
	assert.deepEqual(withPlaceholder(lines, TIER_PLACEHOLDER, dim), lines);
});

test("withPlaceholder:整行都是空格(编辑器未聚焦)时不打扰", () => {
	const lines = ["─".repeat(40), " ".repeat(40), "─".repeat(40)];
	assert.deepEqual(withPlaceholder(lines, "请输入目标", dim), lines);
});

test("档位指示生效时:空编辑器贴提示,一有输入就撤掉", () => {
	let editorFactory: ((tui: any, theme: any) => any) | undefined;
	const strict = {
		fg: (color: string, s: string) => {
			// 严格主题:未知色名直接抛 —— 真实 theme.fg 就是这个行为,宽松 mock 测不出来
			if (!["dim", "accent", "muted", "border"].includes(color)) throw new Error(`未知主题色 ${color}`);
			return `\x1b[2m${s}\x1b[0m`;
		},
	};
	const ctx = {
		hasUI: true,
		ui: {
			setWidget: () => {},
			setEditorComponent: (factory?: any) => {
				editorFactory = factory;
			},
			setEditorText: () => {},
			notify: () => {},
			theme: strict,
		},
	};
	applyTierIndicator(ctx, "standard");
	const editor = editorFactory!({ terminal: { rows: 40 } } as any, {
		borderColor: (x: string) => x,
		selectList: {},
	} as any);

	const rendered = editor.render(60);
	for (const [i, line] of rendered.entries()) {
		assert.equal(visibleWidth(line), 60, `第 ${i} 行宽度精确等于 width`);
	}
	assert.ok(stripTerminalSequences(rendered[0]).startsWith("╭"), "有左上角");
	assert.ok(stripTerminalSequences(rendered[0]).endsWith("╮"), "有右上角");
	assert.ok(stripTerminalSequences(rendered[1]).startsWith("│"), "内容行有左侧边");
	assert.ok(stripTerminalSequences(rendered[0]).includes(" standard "), "档位嵌在顶边框标题里");
	const empty = rendered.join("\n");
	assert.ok(empty.includes("请输入目标"), "空编辑器上有提示");

	editor.setText("迁移鉴权到 JWT");
	const typed = editor.render(60).join("\n");
	assert.ok(!typed.includes("请输入目标"), "一有输入提示就撤掉");
	assert.ok(typed.includes("迁移鉴权到 JWT"));
});

// ─────────────────────────── 顶边框标题 ───────────────────────────

// 上色函数只能加不可见的转义序列 —— 这里用带色标记的等价物会污染宽度断言
const paint = {
	border: (x: string) => `\x1b[90m${x}\x1b[39m`,
	title: (x: string) => `\x1b[33m${x}\x1b[39m`,
	right: (x: string) => `\x1b[2m${x}\x1b[0m`,
};

test("titledTopBorder:档位 + 模型嵌进边框,可见宽度精确等于 width", () => {
	for (const width of [40, 60, 80, 120, 200]) {
		const out = titledTopBorder("─".repeat(width), width, "standard", "glm-5.3-flash", paint);
		assert.equal(visibleWidth(stripTerminalSequences(out)), width, `width=${width}`);
		const plain = stripTerminalSequences(out);
		assert.ok(plain.includes("standard"), `width=${width} 有档位`);
		assert.ok(plain.includes("glm-5.3-flash"), `width=${width} 有模型`);
	}
});

test("titledTopBorder:窄终端先牺牲模型,档位保住", () => {
	const width = 20;
	const out = titledTopBorder("─".repeat(width), width, "standard", "glm-5.3-flash", paint);
	const plain = stripTerminalSequences(out);
	assert.equal(visibleWidth(plain), width);
	assert.ok(plain.includes("standard"));
	assert.ok(!plain.includes("glm-5.3-flash"), "模型是附加信息,放不下就丢");
});

test("titledTopBorder:连档位都放不下时原样返回,不吐出半截边框", () => {
	assert.equal(titledTopBorder("─".repeat(6), 6, "standard", "", paint), "─".repeat(6));
});

test("titledTopBorder:滚动指示器那一行不碰(上面还有内容比档位重要)", () => {
	const scroll = "─── ↑3 ──────────────────";
	assert.equal(titledTopBorder(scroll, scroll.length, "standard", "glm-5.3-flash", paint), scroll);
});

test("titledTopBorder:CJK 模型名按显示宽度算,不按码位", () => {
	const width = 60;
	const out = titledTopBorder("─".repeat(width), width, "complex", "本地大模型", paint);
	assert.equal(visibleWidth(stripTerminalSequences(out)), width);
});

// ─────────────────────────── 左右边框 ───────────────────────────

test("withSideBorders:上中下各就各位,拼成圆角盒", () => {
	const out = withSideBorders(["─ standard ──────", "  文字         ", "─────────────────"], (x) => x);
	assert.equal(out[0], "╭─ standard ──────╮");
	assert.equal(out[1], "│  文字         │");
	assert.equal(out[2], "╰─────────────────╯");
});

test("withSideBorders:滚动指示器也算下边框(否则盒子会一直找不到底)", () => {
	const out = withSideBorders(["─────", "  a  ", "─── ↓ 3 more ─"], (x) => x);
	assert.equal(out[2], "╰─── ↓ 3 more ─╯");
});

test("withSideBorders:自动补全菜单在盒外,用空格占位而不是套进盒里", () => {
	const out = withSideBorders(["─────", "  a  ", "─────", " /mission new ", " /missions "], (x) => x);
	assert.equal(out[3], "  /mission new  ");
	assert.equal(out[4], "  /missions  ");
	assert.ok(!out[3].includes("│"), "补全行不该有侧边");
});

test("withSideBorders:找不到下边框就整条不套边(退化成 pi 原样,不撕版面)", () => {
	const lines = ["─────", "  a  ", "  b  "];
	assert.deepEqual(withSideBorders(lines, (x) => x), lines);
});

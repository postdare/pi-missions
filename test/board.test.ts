import { test } from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	BOARD_BODY_LINES,
	boardActive,
	boardScrollFor,
	boardTrace,
	renderBoard,
	type BoardView,
} from "../src/ui/board.ts";
import type { LineTheme } from "../src/ui/dashboard.ts";

const theme = {
	fg: (_c: string, s: string) => s,
	bold: (s: string) => s,
} as unknown as LineTheme;

const NOW = 1_756_737_000_000;

const TRACE = [
	"初始化独立 AgentSession",
	"分析冻结验收标准",
	"完成第 2 轮核验",
	"浏览 /Users/kim/Projects/todo-list/internal",
	"读取 /Users/kim/Projects/todo-list/internal/codec/dto.go",
	"完成第 5 轮核验",
	"查找 **/*_test.go",
	"读取 /Users/kim/Projects/todo-list/internal/api/handler.go",
	"读取 /Users/kim/Projects/todo-list/internal/keymap/keymap.go",
];

function checkOf(over: Record<string, unknown> = {}) {
	return {
		taskId: "T1",
		attempt: 1,
		startedAt: NOW - 94_000,
		updatedAt: NOW,
		stage: "running_verifier",
		completedBranches: [],
		verifier: { status: "running", startedAt: NOW - 88_000, turns: 11, toolCalls: 22, trace: TRACE, ...over },
	} as never;
}

function view(over: Partial<BoardView> = {}): BoardView {
	return { expanded: false, selected: -1, scroll: 0, check: checkOf(), now: NOW, width: 96, ...over };
}

// ── 什么时候该出现 ────────────────────────────────────────────

test("没有子 agent 在跑就整块不出现 —— 输入框下面每一行都是永久成本", () => {
	assert.equal(renderBoard(view({ check: null }), theme).length, 0);
	assert.equal(boardActive({ check: null }), false);
});

test("核验已结束(不是 running)也不出现 —— 那时它没有进展可看", () => {
	for (const status of ["completed", "timeout", "degraded", "skipped", "pending", "failed"]) {
		assert.equal(
			renderBoard(view({ check: checkOf({ status }) }), theme).length,
			0,
			`status=${status} 时不该出现`,
		);
	}
});

// ── 收起态 ────────────────────────────────────────────────────

test("收起态只占一行 —— 它是常驻的", () => {
	for (const width of [40, 56, 64, 80, 96, 120, 200]) {
		assert.equal(renderBoard(view({ width }), theme).length, 1, `宽度 ${width}`);
	}
});

test("收起态给得出入口 —— 再窄也要让人知道有 ↓ 这条路", () => {
	for (const width of [40, 56, 80, 200]) {
		assert.match(renderBoard(view({ width }), theme)[0], /↓/, `宽度 ${width} 上丢了展开入口`);
	}
});

// 窄终端上先丢轮数、再丢当前动作。「在干什么」比「跑了几轮」重要 ——
// 前者是判断它还活着的依据,后者在展开态和常驻卡上都另有出口。
test("收起态的牺牲顺序:先丢轮数,再丢当前动作,身份与时长永远留着", () => {
	const wide = renderBoard(view({ width: 120 }), theme)[0];
	assert.match(wide, /keymap\.go/, "宽的时候动作要在");
	assert.match(wide, /11 轮/, "宽的时候轮数也在");

	const mid = renderBoard(view({ width: 72 }), theme)[0];
	assert.match(mid, /keymap\.go/, "中等宽度要保住动作");
	assert.doesNotMatch(mid, /11 轮/, "中等宽度该先丢轮数");

	const narrow = renderBoard(view({ width: 56 }), theme)[0];
	assert.match(narrow, /独立核验/, "再窄也要说清是谁");
	assert.match(narrow, /1m2[0-9]s/, "再窄也要说清跑了多久");
});

// ── 展开态 ────────────────────────────────────────────────────

test("展开态不超过 widget 的 10 行硬上限", () => {
	const long = { ...TRACE };
	void long;
	for (const width of [40, 56, 96, 200]) {
		const lines = renderBoard(view({ expanded: true, width }), theme);
		assert.ok(lines.length <= 10, `宽度 ${width} 出了 ${lines.length} 行,pi 会截断成 "widget truncated"`);
		assert.ok(lines.length <= BOARD_BODY_LINES + 2, "正文 + 标题 + 位置行");
	}
});

test("展开态默认跟随最新一条 —— 人想看的是它此刻在干什么", () => {
	const lines = renderBoard(view({ expanded: true }), theme);
	assert.match(lines.join("\n"), /▸ 读取 …\/keymap\/keymap\.go/);
});

test("选中项必须留在窗口里 —— 否则按半天上下键屏幕不动", () => {
	const lines = renderBoard(view({ expanded: true, selected: 0, scroll: 5 }), theme).join("\n");
	assert.match(lines, /▸ 初始化独立 AgentSession/, "选了第 0 条,窗口就该滚回顶部");
});

test("轨迹超过一屏时给出位置,不超过就报总数", () => {
	assert.match(renderBoard(view({ expanded: true }), theme).at(-1)!, /\/9/, "9 条 > 7 行,该给 x-y/9");
	const few = { ...checkOf(), verifier: { ...(checkOf() as never as any).verifier, trace: ["只有一条"] } };
	assert.match(renderBoard(view({ expanded: true, check: few as never }), theme).at(-1)!, /1 条/);
});

test("任何宽度下都不越界 —— 越界会炸 TUI", () => {
	for (const width of [40, 56, 64, 80, 96, 120, 200]) {
		for (const expanded of [false, true]) {
			for (const line of renderBoard(view({ expanded, width }), theme)) {
				assert.ok(visibleWidth(line) <= width, `宽度 ${width} expanded=${expanded}: "${line}"`);
			}
		}
	}
});

// ── scout ─────────────────────────────────────────────────────

test("侦查扇出走同一块看板,标题与轨迹都换成扇出口径", () => {
	const v = view({
		expanded: true,
		check: null,
		scout: {
			startedAt: NOW - 32_000,
			progress: { done: 1, total: 4, running: ["S2"], activity: { S1: "已交回结论", S2: "读 a.go" } },
		},
	});
	const out = renderBoard(v, theme).join("\n");
	assert.match(out, /侦查扇出/);
	assert.match(out, /1\/4/);
	assert.match(out, /S2 读 a\.go/);
	assert.deepEqual(boardTrace(v), ["S1 已交回结论", "S2 读 a.go"]);
	assert.doesNotMatch(out, /esc 收起/, "scout 运行时 Esc 留给宿主中断,不能提示成收起");
});

// ── 滚动位置 ──────────────────────────────────────────────────

test("boardScrollFor 与渲染用同一套窗口算法,按键壳不必自己算", () => {
	assert.equal(boardScrollFor(9, 0, 5), 0, "选中第一条要滚回顶部");
	assert.equal(boardScrollFor(9, 8, 0), 9 - BOARD_BODY_LINES, "选中最后一条要滚到底");
	assert.equal(boardScrollFor(3, -1, 0), 0, "总数不足一屏时不滚");
});

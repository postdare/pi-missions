import { test } from "node:test";
import assert from "node:assert/strict";
import { BOARD_BODY_LINES } from "../src/ui/board.ts";
import {
	WIDGET_NAV_IDLE,
	classifyWidgetKey,
	decideWidgetNav,
	type WidgetNavInput,
	type WidgetNavState,
} from "../src/ui/widget-keys.ts";
import { customUiOpen, wrapUiForBoard } from "../src/ui/custom-depth.ts";

const down = "\x1b[B";
const up = "\x1b[A";
const enter = "\r";
const esc = "\x1b";

const CARD: WidgetNavState = { focus: "card", selected: -1, scroll: 0 };
const onBoard = (selected: number, scroll = 0): WidgetNavState => ({ focus: "board", selected, scroll });

function input(over: Partial<WidgetNavInput> = {}): WidgetNavInput {
	return {
		key: "down",
		editorEmpty: true,
		customUiOpen: false,
		hasCard: true,
		boardActive: true,
		allowEscape: true,
		traceLen: 12,
		state: WIDGET_NAV_IDLE,
		...over,
	};
}

test("classifyWidgetKey 认出方向键和回车/Esc", () => {
	assert.equal(classifyWidgetKey(down), "down");
	assert.equal(classifyWidgetKey(up), "up");
	assert.equal(classifyWidgetKey(enter), "enter");
	assert.equal(classifyWidgetKey(esc), "escape");
	assert.equal(classifyWidgetKey("a"), "other");
	assert.equal(classifyWidgetKey("\t"), "other");
});

// ─────────────────────────── 三层守卫 ───────────────────────────

test("没有活跃 mission 就不介入,并把焦点清掉 —— 卡都不在,焦点无处可落", () => {
	const r = decideWidgetNav(input({ hasCard: false, boardActive: false, state: onBoard(3, 1) }));
	assert.equal(r.consume, false);
	assert.deepEqual(r.state, WIDGET_NAV_IDLE);
});

test("custom UI 开着时不截 —— 评审页 / missions 面板的 ↓ 不是 widget 的", () => {
	const r = decideWidgetNav(input({ customUiOpen: true, state: CARD }));
	assert.equal(r.consume, false);
	assert.deepEqual(r.state, CARD, "焦点原样留着,不能被别的页顺手清掉");
});

test("输入框有字就放行 —— 人在打字,↓ 是编辑器的", () => {
	assert.equal(decideWidgetNav(input({ editorEmpty: false })).consume, false);
	assert.equal(
		decideWidgetNav(input({ editorEmpty: false, state: onBoard(2) })).consume,
		false,
		"焦点已经落下来也一样:有字就不截",
	);
});

// ─────────────────────────── 焦点链 ───────────────────────────

test("焦点在输入框时只截 ↓ —— ↑ 是历史回溯,截了人就翻不到上一条命令", () => {
	assert.equal(decideWidgetNav(input({ key: "up" })).consume, false);
	assert.equal(decideWidgetNav(input({ key: "enter" })).consume, false, "↵ 是发消息");
	assert.equal(decideWidgetNav(input({ key: "escape" })).consume, false, "Esc 是中断");
	const r = decideWidgetNav(input({ key: "down" }));
	assert.equal(r.consume, true);
	assert.equal(r.state.focus, "card", "第一站是常驻状态卡,不是看板");
});

test("空输入框 ↓↓:先选中常驻卡,再展开看板", () => {
	const card = decideWidgetNav(input({ key: "down" })).state;
	assert.equal(card.focus, "card");
	const board = decideWidgetNav(input({ key: "down", state: card }));
	assert.equal(board.consume, true);
	assert.equal(board.state.focus, "board");
	assert.equal(board.state.selected, -1, "展开后仍跟随最新一条");
	assert.equal(board.state.scroll, 12 - BOARD_BODY_LINES, "首屏直接跟到最新窗口");
});

test("没有子 agent 在跑时,↓ 停在常驻卡上 —— 但照样吃掉,不许漏给编辑器翻历史", () => {
	const r = decideWidgetNav(input({ key: "down", boardActive: false, state: CARD }));
	assert.equal(r.consume, true);
	assert.deepEqual(r.state, CARD);
});

test("一路 ↑ 能回到输入框 —— 这是焦点链的出口,没有它人会被困住", () => {
	// 看板中段 → 往上逐条走
	const mid = decideWidgetNav(input({ key: "up", state: onBoard(2) }));
	assert.equal(mid.state.selected, 1, "还没到顶就是逐条上移");
	// 顶端再按 ↑ → 退回常驻卡
	const toCard = decideWidgetNav(input({ key: "up", state: onBoard(0) }));
	assert.equal(toCard.consume, true);
	assert.equal(toCard.state.focus, "card");
	// 常驻卡再按 ↑ → 交还输入框
	const toEditor = decideWidgetNav(input({ key: "up", state: CARD }));
	assert.equal(toEditor.consume, true);
	assert.deepEqual(toEditor.state, WIDGET_NAV_IDLE);
	// 回到输入框之后,↑ 必须重新变回历史回溯
	assert.equal(decideWidgetNav(input({ key: "up", state: toEditor.state })).consume, false);
});

test("看板消失时焦点收回常驻卡 —— 不能停在一个已经不渲染的行上", () => {
	const r = decideWidgetNav(input({ key: "other", boardActive: false, state: onBoard(3, 2) }));
	assert.equal(r.consume, false, "other 键仍然放行");
	assert.equal(r.state.focus, "card", "但焦点已经被收回来了");
});

// ─────────────────────────── 各层的 ↵ / Esc ───────────────────────────

test("常驻卡上 ↵ 开状态页,不开动作详情", () => {
	const r = decideWidgetNav(input({ key: "enter", state: CARD }));
	assert.equal(r.consume, true);
	assert.equal(r.openStatus, true);
	assert.equal(r.openDetail, false);
	assert.equal(r.state.focus, "card", "开完状态页焦点还在卡上");
});

test("看板上 ↵ 开动作详情,不开状态页", () => {
	const r = decideWidgetNav(input({ key: "enter", state: onBoard(4) }));
	assert.equal(r.consume, true);
	assert.equal(r.openDetail, true);
	assert.equal(r.openStatus, false);
	assert.equal(r.state.selected, 4);

	const follow = decideWidgetNav(input({ key: "enter", state: onBoard(-1) }));
	assert.equal(follow.state.selected, 11, "跟随中回车钉在最新一条");
});

test("Esc 一路收回输入框", () => {
	for (const state of [CARD, onBoard(4)]) {
		const r = decideWidgetNav(input({ key: "escape", state }));
		assert.equal(r.consume, true);
		assert.deepEqual(r.state, WIDGET_NAV_IDLE);
	}
});

test("宿主正忙时不截 Esc —— 那是中断,不是收起", () => {
	for (const state of [CARD, onBoard(2)]) {
		const r = decideWidgetNav(input({ key: "escape", allowEscape: false, state }));
		assert.equal(r.consume, false);
		assert.equal(r.state.focus, state.focus, "焦点不动");
	}
});

test("选中项夹在轨迹范围内,滚动跟着走", () => {
	const opened = decideWidgetNav(input({ key: "down", state: CARD })).state;
	const up1 = decideWidgetNav(input({ key: "up", state: opened }));
	assert.equal(up1.state.selected, 10, "跟随最新时 ↑ 从最后一条往上");
	assert.equal(up1.state.scroll, 12 - BOARD_BODY_LINES);

	const down1 = decideWidgetNav(input({ key: "down", state: up1.state }));
	assert.equal(down1.state.selected, 11);
	const bottom = decideWidgetNav(input({ key: "down", state: down1.state }));
	assert.equal(bottom.state.selected, 11, "到底不再往下");
});

test("对其它键放手 —— 字母要进输入框", () => {
	for (const state of [CARD, onBoard(2)]) {
		const r = decideWidgetNav(input({ key: "other", state }));
		assert.equal(r.consume, false);
		assert.equal(r.state.focus, state.focus);
	}
});

test("wrapUiForBoard 用深度计数标出 custom UI 是否开着", async () => {
	assert.equal(customUiOpen(), false);
	const ui: any = {
		custom: async () => {
			assert.equal(customUiOpen(), true, "await 期间必须算开着");
		},
		select: async () => "x",
		confirm: async () => true,
	};
	wrapUiForBoard(ui);
	wrapUiForBoard(ui);
	await ui.custom();
	assert.equal(customUiOpen(), false, "结束必须归零,包两次也不能泄漏");
	await ui.select();
	assert.equal(customUiOpen(), false);
});

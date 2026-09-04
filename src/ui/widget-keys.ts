/**
 * pi-missions · ui/widget-keys
 *
 * 输入框**下方**那几行的焦点模型(常驻状态卡 + 子 agent 看板)。
 *
 * widget 从不进 focus 链(`setWidget` 的组件不进 pi-tui 的 focus 环),按键只能靠
 * `onTerminalInput` 在编辑器之前截 —— 拦错了就是输入框方向键失灵,和 ctrl+m
 * 劫持回车同级(CLAUDE.md「UI 层的四个坑」第四条)。所以判定全在这个纯函数里,
 * 有单测;`runtime.ts` 只负责采输入、执行结果。
 *
 * 焦点是一条从输入框往下走的链:
 *
 *   none(输入框) ──↓──▶ card(常驻状态卡) ──↓──▶ board(看板展开,逐条选轨迹)
 *                ◀──↑──               ◀──↑── (选中项已经在顶端时)
 *
 *   card  上 ↵ = 打开 /mission status
 *   board 上 ↵ = 打开该条动作的原文
 *   任何一层 Esc = 一路收回输入框
 *
 * 三层守卫,顺序不能乱:
 *   1. 没有活跃 mission → 不介入,并把焦点清掉(卡都不在,焦点无处可落)
 *   2. 有别的 custom UI 盖着(/missions、评审页、pi 的 confirm)→ ↓ 是它们的
 *   3. 输入框有字 / 读不到输入框 → 放行,人在打字
 *
 * **↑ 只在焦点已经落下来之后才截。** 空输入框按 ↑ 是 pi 的历史回溯,焦点还在
 * none 时截了它,人就再也翻不到上一条命令 —— 这条有单测卡着,别为了"对称"去掉。
 * 同理 Esc:宿主正忙时(扇出堵在工具调用上)Esc 是中断,不能截。
 */
import { Key, matchesKey } from "@earendil-works/pi-tui";
import { boardScrollFor } from "./board.ts";

export type WidgetNavKey = "up" | "down" | "enter" | "escape" | "other";

/** 焦点落在哪一层。none = 还在输入框,widget 不接管任何键 */
export type WidgetFocus = "none" | "card" | "board";

export interface WidgetNavState {
	focus: WidgetFocus;
	/** 看板展开后选中第几条轨迹(0 基);-1 = 跟随最新一条 */
	selected: number;
	scroll: number;
}

export const WIDGET_NAV_IDLE: WidgetNavState = { focus: "none", selected: -1, scroll: 0 };

export interface WidgetNavInput {
	key: WidgetNavKey;
	editorEmpty: boolean;
	customUiOpen: boolean;
	/** 有活跃 mission —— 常驻卡在,焦点可以落到它上面 */
	hasCard: boolean;
	/** 有子 agent 在跑 —— 看板那一行在 */
	boardActive: boolean;
	/** 宿主正忙时(scout 堵在工具调用里)不截 Esc —— 那是中断 */
	allowEscape: boolean;
	traceLen: number;
	state: WidgetNavState;
}

export interface WidgetNavResult {
	consume: boolean;
	state: WidgetNavState;
	/** 打开选中那条轨迹的动作原文 */
	openDetail: boolean;
	/** 打开 /mission status */
	openStatus: boolean;
}

export function classifyWidgetKey(data: string): WidgetNavKey {
	if (matchesKey(data, Key.down)) return "down";
	if (matchesKey(data, Key.up)) return "up";
	if (matchesKey(data, Key.enter) || matchesKey(data, Key.return)) return "enter";
	if (matchesKey(data, Key.escape) || matchesKey(data, Key.esc)) return "escape";
	return "other";
}

export function decideWidgetNav(i: WidgetNavInput): WidgetNavResult {
	const at = (state: WidgetNavState, consume = true): WidgetNavResult => ({
		consume,
		state,
		openDetail: false,
		openStatus: false,
	});
	const card: WidgetNavState = { ...WIDGET_NAV_IDLE, focus: "card" };

	// ① 卡都不在了(mission 跑完/没有活跃 mission):焦点无处可落,清掉
	if (!i.hasCard) return at(WIDGET_NAV_IDLE, false);

	// 看板跑完了但焦点还停在它上面 —— 收回到卡上。不能让焦点留在一个已经不存在的行上,
	// 否则 ↑↓ 看着像失灵(按了没反应,因为那一层的渲染早就摘掉了)。
	const state = i.state.focus === "board" && !i.boardActive ? card : i.state;

	// ② / ③
	if (i.customUiOpen) return at(state, false);
	if (!i.editorEmpty) return at(state, false);
	if (i.key === "other") return at(state, false);

	// 焦点还在输入框:只认 ↓。↑ 是历史回溯,↵ 是发消息,Esc 是中断 —— 都不是我们的。
	if (state.focus === "none") return i.key === "down" ? at(card) : at(state, false);

	const enterBoard = (): WidgetNavResult =>
		at({ focus: "board", selected: -1, scroll: boardScrollFor(i.traceLen, -1, 0) });
	const moveBoard = (n: number): WidgetNavResult => {
		const selected = i.traceLen === 0 ? -1 : Math.max(0, Math.min(i.traceLen - 1, n));
		return at({ focus: "board", selected, scroll: boardScrollFor(i.traceLen, selected, state.scroll) });
	};

	if (state.focus === "card") {
		switch (i.key) {
			case "down":
				// 再往下就是看板。没有看板就停在卡上 —— 照样吃掉这一下,
				// 不然 ↓ 会漏给编辑器,人会看到焦点还在卡上却翻了历史。
				return i.boardActive ? enterBoard() : at(state);
			case "up":
				return at(WIDGET_NAV_IDLE);
			case "enter":
				return { consume: true, state, openDetail: false, openStatus: true };
			case "escape":
				return i.allowEscape ? at(WIDGET_NAV_IDLE) : at(state, false);
		}
		return at(state, false);
	}

	// focus === "board"
	const last = Math.max(0, i.traceLen - 1);
	const pinned = state.selected < 0 ? last : state.selected;
	switch (i.key) {
		case "down":
			return moveBoard(pinned + 1);
		case "up":
			// 选中项已经在顶端:再按就退回常驻卡。"一路按 ↑ 能回到输入框"是这条链的
			// 出口,没有它人就被困在看板里(Esc 在宿主忙时还截不了)。
			return pinned <= 0 ? at(card) : moveBoard(pinned - 1);
		case "enter":
			if (i.traceLen === 0) return at(state);
			return { consume: true, state: { ...state, selected: pinned }, openDetail: true, openStatus: false };
		case "escape":
			return i.allowEscape ? at(WIDGET_NAV_IDLE) : at(state, false);
	}
	return at(state, false);
}

/**
 * pi-missions · core/stall
 *
 * 相位停滞的判定:模型回合结束了,而相位没往前走 —— 这一次该推它,还是该报给人。
 *
 * 病灶:DO / PLAN / DEFINE 三个相位的终结动作都是**一次工具调用**
 * (mission_submit / mission_write_plan | mission_criterion / mission_define),
 * 而模型完全可以写一段"我这就去做 X"的总结然后结束回合。此时相位没变、
 * 磁盘没动,循环就停在原地,**而且没有任何提示** —— 人看着一个静止的界面,
 * 分不清它是在想还是已经死了。
 *
 * 真机记录(E2):`mission_define` 返回「进入 PLAN 相位,现在设计验收标准…」,
 * 模型 12 秒后写了一段纯文本总结就收工,5 分钟零工具调用,直到人工敲「继续」。
 * 同一个模型在上一个 mission 里 7 秒后自己接上了 —— 是不确定行为,不是必然。
 *
 * 判据的形状被两个相反的失败方式夹住:
 *   不推 → 就是上面那次事故,静默停摆。
 *   一直推 → 模型真卡住时(比如它认定当前信息做不出计划),每次 settle 都推一遍,
 *            把预算烧光,而且屏幕上什么异常都看不出来。
 * 所以是**推一次,再停就交给人**。第三次起彻底沉默 —— 报过一次的事再报是刷屏。
 */

import type { Phase } from "./types.ts";

/** 这一次 settle 该做什么 */
export type StallAction =
	/** 推一次简报,把它推回终结动作上 */
	| "nudge"
	/** 推过还是不动:报给人,不再推 */
	| "warn"
	/** 什么都不做 */
	| "silent";

/**
 * 会被推动的相位。
 *
 * 三个都收进来,因为它们是同一个形状:终结动作是一次工具调用,settle 而没调=卡住了。
 * DO 曾经犹豫过要不要排除(怕撞上"模型正等人回话"),查过闸门之后确定不必:
 * `toolsForPhase("do")` 是 `[内置八件 + mission_submit]`,**里面没有 ask_user_question**
 * (define/plan 同样没有)。这三个相位里模型没有任何"合法地停下来等人"的手段,
 * 所以一次 settle 就是一次停摆,没有需要放过的正当场景。
 *
 * check 与 act 不在此列:它们各自已经有驱动(startCheck / ADJUST_DONE + DO 简报)。
 * done 与 halted 也不在:那是终点,停下来正是对的。
 */
const DRIVEN: readonly Phase[] = ["define", "plan", "do"];

export function isDrivenPhase(phase: Phase): boolean {
	return DRIVEN.includes(phase);
}

/** 停滞计数。key 变了就说明有进展,计数归零 */
export interface StallState {
	/** `${phase}:${revision}` —— 两者任一变化都算"上一次 settle 之后有东西落了盘" */
	key: string;
	/** 本 key 下已经推过几次 */
	nudges: number;
}

export interface StallInput {
	phase: Phase;
	/** v2 snapshot 的 CAS revision;quick 内存任务恒为 0(那时只靠相位变化归零) */
	revision: number;
	/** 换脑挂起中:HANDOFF 自己会推 /mission next,这里不能抢 */
	pendingHandoff: boolean;
}

export function stallKey(phase: Phase, revision: number): string {
	return `${phase}:${revision}`;
}

/**
 * 纯函数:给出这一次 settle 的动作与新的计数。
 *
 * `prev` 为 null(本 mission 第一次 settle)时 key 必然算作新的,于是照常推一次 ——
 * 这是对的:第一次 settle 也可能就是停摆,DEFINE→PLAN 那次事故正是发生在
 * 进入 PLAN 后的第一次 settle。
 */
export function nextStall(prev: StallState | null, now: StallInput): { state: StallState; action: StallAction } {
	const key = stallKey(now.phase, now.revision);
	// key 变了 = 相位推进了或有东西落了盘,不算停滞。计数跟着新 key 从 0 开始。
	const nudges = prev && prev.key === key ? prev.nudges : 0;

	if (!isDrivenPhase(now.phase) || now.pendingHandoff) {
		return { state: { key, nudges }, action: "silent" };
	}
	if (nudges === 0) return { state: { key, nudges: 1 }, action: "nudge" };
	if (nudges === 1) return { state: { key, nudges: 2 }, action: "warn" };
	return { state: { key, nudges }, action: "silent" };
}

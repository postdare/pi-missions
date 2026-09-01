/**
 * pi-missions · core/tier
 *
 * 三档与自动升档规则。升档自动,降档手动 —— 防止 agent 在小任务里死磕,
 * 也防止大任务躲在低档位里绕过验证闸门。
 *
 * 判据必须机械可测(I7):改动文件数、是否触及公开 API、尝试次数、
 * 改方案(L2)次数。绝不让 LLM 自评"这个任务复杂吗"。
 */

import type { TaskState, Tier } from "./types.ts";

const RANK: Record<Tier, number> = { quick: 0, standard: 1, complex: 2 };

export function tierRank(tier: Tier): number {
	return RANK[tier];
}

export interface PromotionSignals {
	tier: Tier;
	/** 当前任务(quick 档用其 attempts 判定) */
	currentTask: TaskState | null;
	/** 本 mission 触碰过的文件数 */
	touchedFiles: number;
	touchedPublicApi: boolean;
	/** 改方案(L2/L3)次数。反复改方案 = 任务边界在漂移 */
	escalations: number;
}

export interface Promotion {
	to: Tier;
	reason: string;
}

/**
 * 纯函数:给定机械可测的信号,决定是否升档。
 * 返回 null 表示维持当前档位。
 */
export function evaluatePromotion(s: PromotionSignals): Promotion | null {
	if (s.tier === "quick") {
		if (s.touchedPublicApi) {
			return { to: "standard", reason: "触及公开 API,升档 standard 补验证闸门" };
		}
		if (s.touchedFiles > 5) {
			return { to: "standard", reason: `改动面达 ${s.touchedFiles} 个文件,超出 quick 范围` };
		}
		if ((s.currentTask?.attempts ?? 0) >= 2) {
			return { to: "standard", reason: "quick 档进入第 2 次尝试,升档 standard 补 PLAN" };
		}
		return null;
	}

	if (s.tier === "standard") {
		// 里程碑漂移的机械代理:同一 mission 内 2 次及以上改方案。
		// 每次 L2 都说明任务分解错了;错两次说明问题定义层面需要里程碑化管理。
		if (s.escalations >= 2) {
			return { to: "complex", reason: "已 2 次改方案(L2),任务边界漂移,升档 complex" };
		}
		return null;
	}

	return null;
}

// ─────────────────────────── 进入 DO 的准入判定 ───────────────────────────

export interface AdmissionSignals {
	tier: Tier;
	/** quick 档:是否已经拿到一条冻结的验证命令(--verify 给的) */
	hasVerifyCommand: boolean;
}

export type Admission =
	| { ok: true }
	| { ok: false; promoteTo: Tier; reason: string };

/**
 * 纯函数:能否直接进入 DO,还是必须先升档去 PLAN。
 *
 * quick 档不落盘、无 AC、无子进程 Verifier,判定的唯一依据就是那条验证命令。
 * 它必须在动手之前就定下来 —— 让执行者干完活再补一条,等于判定标准由被判定方
 * 事后选定,I2(执行期只读)与 I3(证据来自执行者之外)同时失守。
 *
 * 写不出判定命令 = 任务没想清楚。这种输入交给 standard 档的 PLAN 相位去拆,
 * 而不是放进一个没有裁判的快车道。
 *
 * standard/complex 的准入由 validatePlan + PLAN_FROZEN 把关,这里恒放行。
 */
export function evaluateAdmission(s: AdmissionSignals): Admission {
	if (s.tier === "quick" && !s.hasVerifyCommand) {
		return {
			ok: false,
			promoteTo: "standard",
			reason: "quick 档需要一条验证命令作为判定依据(--verify);没有就说明任务还没想清楚,升档 standard 先做 PLAN",
		};
	}
	return { ok: true };
}

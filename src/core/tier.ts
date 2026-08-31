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

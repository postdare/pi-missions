/**
 * pi-missions · core/review
 *
 * 计划评审的打回判据。
 *
 * 冻结前的人工确认原本是一个二值弹窗:拒绝之后返回一句"人工拒绝了计划,请根据反馈
 * 修改后重新调用" —— 而"反馈"是空的,系统里没有任何地方承载它。planner 只收到 1 bit,
 * 只能猜哪里不满意,大概率原地改个措辞再交一次。
 *
 * 所以打回要带一段意见,并且要记账。记账是为了回答一个机械问题:
 * **这轮评审是在收敛,还是在原地打转?**
 *
 * 连续打回到上限就不再让 planner 重交,直接转 DEFINE(L3)。理由是硬的:
 * 同一份问题定义下改了三版方案人都不满意,那不是方案的问题,是完成条件没定对;
 * 继续在 PLAN 里磨等于**在错的问题上做高质量的工作**。
 *
 * 选硬拦而不是软警告,是因为这个项目的判定一贯是硬的 —— 软警告等于没有。
 * 这与 breaker.ts 是同一种形状:那里数"同一失败签名连续出现",这里数"人不满意"。
 */

/** 连续打回多少次就不再重交,转 L3 回 DEFINE */
export const PLAN_REJECT_CAP = 3;

export interface PlanReviewSignals {
	/** 含本次在内,本 mission 的累计打回次数 */
	rejections: number;
}

export type PlanReviewVerdict =
	| { ok: true; remaining: number }
	| { ok: false; escalate: true; reason: string };

/** 纯函数:这次打回之后,是让 planner 重交,还是转回 DEFINE 重新定义问题 */
export function evaluatePlanReview(s: PlanReviewSignals): PlanReviewVerdict {
	if (s.rejections >= PLAN_REJECT_CAP) {
		return {
			ok: false,
			escalate: true,
			reason:
				`计划已被连续打回 ${s.rejections} 次(上限 ${PLAN_REJECT_CAP})。` +
				"同一份问题定义下改了这么多版方案还是不对,问题多半不在方案 —— 转 L3 回 DEFINE 重新定义问题。",
		};
	}
	return { ok: true, remaining: PLAN_REJECT_CAP - s.rejections };
}

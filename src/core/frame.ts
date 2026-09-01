/**
 * pi-missions · core/frame
 *
 * FRAME 相位的提问预算。
 *
 * FRAME 存在的理由:AC 必须在 PLAN 冻结,而需求模糊时根本写不出 AC ——
 * 系统的入口条件不成立。此时 agent 的行为是可预测的:它会编一条 AC 出来凑格式
 * ("AC1: 用户体验良好"),然后整套判定建立在一条假标准上。FRAME 把"改问题定义"
 * (升级阶梯的 L3)提到最前面,先把目标问清楚再进 PLAN。
 *
 * 关于退出条件要诚实:FRAME 的产出是一句话,不是可执行的东西,**没有**机械判据
 * 能证明"这个目标已经足够清楚"。真正的过滤器仍然在下游 —— PLAN 的 validatePlan
 * 与冻结基线。FRAME 的价值是让"想不清楚"在烧掉一轮 PLAN 之前就暴露,并且让人
 * 有一次介入的机会。
 *
 * 这里唯一机械可测的是**提问预算**:一个 mission 只许问一轮、最多 3 个问题。
 * 超出说明这需求该退回给人重新描述,不是靠追问能补齐的 ——
 * agent 连环追问二十条的体验比直接说"我不理解"更糟。
 */

/** 一轮最多几个问题 */
export const FRAME_QUESTION_CAP = 3;

export interface AskInput {
	/** 本 mission 已经问过几轮 */
	askedRounds: number;
	questions: string[];
}

export type AskVerdict = { ok: true; questions: string[] } | { ok: false; reason: string };

/**
 * 纯函数:这一轮提问是否放行。
 *
 * 只许一轮:第二次调用一律拒绝,并明确告诉模型剩下的路是把问题挑最重要的问完,
 * 或者直接说"我不理解",而不是继续追问。
 */
export function evaluateAsk(input: AskInput): AskVerdict {
	const questions = input.questions.map((q) => q.trim()).filter(Boolean);

	if (input.askedRounds > 0) {
		return {
			ok: false,
			reason:
				"本 mission 的提问机会已经用掉了(每个 mission 只许问一轮)。" +
				"根据已有回答调用 mission_frame 定义问题;若信息仍然不足以定义,直接说明缺什么,由人重新描述需求。",
		};
	}
	if (questions.length === 0) {
		return { ok: false, reason: "没有实际问题。不需要提问就直接调用 mission_frame。" };
	}
	if (questions.length > FRAME_QUESTION_CAP) {
		return {
			ok: false,
			reason:
				`一次最多 ${FRAME_QUESTION_CAP} 个问题,你给了 ${questions.length} 个。` +
				"挑出真正'不知道就写不出验收标准'的那几个 —— 超过这个数说明该退回去重新描述需求。",
		};
	}
	return { ok: true, questions };
}

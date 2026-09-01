/**
 * pi-missions · core/spike
 *
 * 探针任务(spike)。
 *
 * FRAME 处理的是"描述不清":答案在人的脑子里,问一轮就能补齐。
 * 但还有一类模糊,答案不在人那里,而在代码/环境/依赖里,不看一眼谁也不知道 ——
 * "旧 ORM 的私有 API 到底用在 3 处还是 300 处""瓶颈在 SQL 还是序列化"。
 * 这类问题上 mission_ask 是无效的:你问人,人也不知道。
 *
 * 没有 spike 时,系统只有两个出口,都不对:planner 硬猜一个方案(猜错走 L2,
 * 烧掉整轮),或者写一条含糊的 AC 把不确定性带进 DO(现在会被冻结基线打回)。
 * spike 是第三条路:先花一小笔钱去看一眼,拿着结论回来重新规划。
 *
 * 三条硬约束,每条都是机械的:
 *   1. 产物是书面结论,不是代码 —— 闸门只放行写结论文件(见 hooks/gate)
 *   2. 一次 attempt,不进 ACT、不进熔断 —— 探针的失败本身就是一条结论
 *   3. 强制以重写 PLAN 结尾 —— 结论不允许直接合进实现
 *
 * 第 3 条是关键。没有它,agent 会一边"调研"一边顺手把代码改了,最后你既没拿到
 * 干净的结论,也没拿到干净的方案 —— 而且那些改动是在没有 AC 的状态下做的,
 * 等于绕过了整个验证闸门。
 */

export type TaskKind = "impl" | "spike";

/** 结论文件的最小长度。低于此视为没写(挡 "TODO" / 空文件) */
export const SPIKE_REPORT_MIN_CHARS = 80;

export interface SpikePlanSignals {
	/** 本次计划里被标记为 spike 的任务 id */
	spikeTaskIds: string[];
	/** 本 mission 是否已经跑过 spike(不论成败) */
	alreadyRanSpike: boolean;
}

/**
 * 纯函数:计划里的 spike 安排是否合法。返回错误数组,空数组 = 合法。
 *
 * 每个 mission 最多一个 spike。它以重写 PLAN 结尾,所以"再探一次"在机制上
 * 等价于无限期推迟动手;真需要重新定义问题,那是 L3 的事,不是再打一根探针。
 */
export function validateSpikePlan(s: SpikePlanSignals): string[] {
	const errors: string[] = [];
	if (s.spikeTaskIds.length > 1) {
		errors.push(
			`一个计划最多一个 spike,当前有 ${s.spikeTaskIds.length} 个(${s.spikeTaskIds.join(", ")})。` +
				"spike 完成后计划会被整体重写,排在它后面的任务本来就是临时的。",
		);
	}
	if (s.spikeTaskIds.length > 0 && s.alreadyRanSpike) {
		errors.push(
			"本 mission 已经跑过一次 spike,不能再排。" +
				"拿现有结论去规划;如果连问题定义都错了,走 L3 升级回 FRAME,而不是再探一次。",
		);
	}
	return errors;
}

/** 结论文件内容是否算数(hard 证据的判据:机械、零模型成本) */
export function reportIsSubstantive(content: string | null): boolean {
	return !!content && content.trim().length >= SPIKE_REPORT_MIN_CHARS;
}

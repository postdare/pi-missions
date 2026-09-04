/**
 * pi-missions · core/verifier-budget
 *
 * 独立核验的预算判定:什么时候该把它掐掉。
 *
 * # 为什么不是一个总时长
 *
 * 原来是一条 `setTimeout(abort, 300_000)`。真机上五轮核验的实测:
 *
 *   T1  300s 超时   23 轮 38 次调用      T4  236s  22 轮 40 次调用
 *   T2  225s 完成   21 轮 33 次调用      T5   68s   8 轮 12 次调用
 *   T3  232s 完成   14 轮 24 次调用
 *
 * 三次实质性核验挤在 225–236 秒这条 11 秒宽的带子里,而阈值正好压在 300 ——
 * **余量只有 30%,调用次数稍多一点就翻车**。T1 就是那一次,它被掐掉时
 * 仍在读新文件,判定随之降级 hard-only,那一轮的 I3 是空的。
 *
 * 光把数字调大是错的:核验已经是最贵的角色(那一轮 verifier 输出 token
 * 是 executor 的 4.6 倍),把上限翻倍等于给最贵的一条路再加一倍最坏情况。
 *
 * # 该分开的是两件事
 *
 * 「跑得久」和「卡住了」在旧机制里长得一模一样,而它们要的处置正相反:
 *
 *   turn 23 · 38 次调用 · 一直在读新文件   → 在干活,再给它时间
 *   turn 1  · 0 次调用  · 五分钟没动静     → 卡住了,现在就掐
 *
 * 所以按**静默时长**判,总时长只留一个宽松的兜底。这样干活的不被误杀,
 * 真卡住的反而杀得比以前更快(120 秒 vs 300 秒)。
 *
 * 静默口径的依据也在上面那组数据里:每轮间隔约 11–16 秒,120 秒是它的
 * 六到十倍。低于这个数会误杀慢 provider,高于就失去"早掐"的意义。
 */

/** 多久没有任何动静就算卡住。实测每轮间隔 11–16 秒,这里留了 6–10 倍余量 */
export const DEFAULT_VERIFIER_IDLE_MS = 120_000;

/**
 * 总时长兜底。真正干活的判据是静默,这条只防"一直有动静但永远不收敛"——
 * 所以可以给得比旧的 300 秒宽得多,它不再是常规路径上的闸门。
 */
export const DEFAULT_VERIFIER_CEILING_MS = 900_000;

export interface VerifierBudget {
	/** 多久没动静算卡住 */
	idleMs: number;
	/** 总时长硬上限 */
	ceilingMs: number;
}

export interface BudgetInput {
	startedAt: number;
	/**
	 * 最近一次有动静的时刻(换了工具调用、进了新一轮、活动文案变了)。
	 * 还没有过任何动静时传 startedAt —— 初始化本身不算动静,
	 * 一个连 session 都建不起来的核验应当按静默计时。
	 */
	lastActivityAt: number;
	now: number;
}

export type BudgetVerdict = "running" | "idle" | "ceiling";

/**
 * 判定当前是否还该让核验继续跑。
 *
 * 静默优先于总时长:两条同时越线时报 `idle`,因为它才是可执行的诊断
 * ——「它卡住了」指向 provider 或模型,「它跑太久了」谁也不知道下一步做什么。
 */
export function checkVerifierBudget(input: BudgetInput, budget: VerifierBudget): BudgetVerdict {
	if (input.now - input.lastActivityAt >= budget.idleMs) return "idle";
	if (input.now - input.startedAt >= budget.ceilingMs) return "ceiling";
	return "running";
}

/** 掐掉的理由,写进 CHECK.json 的 message 与 LOG 的 WARN */
export function budgetReason(verdict: Exclude<BudgetVerdict, "running">, budget: VerifierBudget): string {
	return verdict === "idle"
		? `连续 ${Math.round(budget.idleMs / 1000)}s 没有任何动静,判定它卡住了`
		: `总时长超过 ${Math.round(budget.ceilingMs / 1000)}s 仍未收敛`;
}

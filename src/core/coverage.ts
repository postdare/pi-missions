/**
 * pi-missions · core/coverage
 *
 * 完成条件(doneWhen)与验收标准(AC)的覆盖校验。
 *
 * ARCHITECTURE §8.3 说"目标的清晰度无法用退出码表达",这句话是对的,
 * 但它推出的结论过强了:**判不了"清楚",不代表判不了"覆盖"。**
 *
 * DEFINE 产出一张人话的完成条件清单(DW1/DW2…),PLAN 的每条 AC 声明它 covers 哪几条。
 * 这里做两个方向的集合运算:
 *
 *   正向(没漏)—— 每条 doneWhen 至少被一条 AC 覆盖。
 *                  漏掉的那条就是"人以为会做、机器不会验"的那部分,是最贵的一类缺口。
 *   反向(没夹带)—— 每条 AC 至少覆盖一条 doneWhen。
 *                    孤儿 AC 意味着 planner 在人批准的目标之外自己加了戏;
 *                    它会被冻结成只读,然后用整套熔断机制去追一个没人要的东西。
 *
 * 这是 DEFINE 的产出第一次有机械化的下游后果 —— 在此之前 Definition 只是给人看的散文。
 *
 * 调用方只在 mission 经过 DEFINE 时才调它(`plan.definition` 存在)。quick 档没有 DEFINE
 * 相位,判定依据是 PLAN 相位冻结的单条判据(core/criterion.ts),这里无话可说 —— 那是档位差异,
 * 不是可以为空的兼容口子:definition 一旦存在,doneWhen 就必须非空。
 */

export interface CoverageInput {
	/** DEFINE 产出的完成条件。空数组本身就是错误 */
	doneWhen: { id: string }[];
	/** PLAN 提交的验收标准 */
	acs: { id: string; covers: string[] }[];
}

/** 纯函数:返回错误信息数组,空数组 = 通过 */
export function evaluateCoverage(input: CoverageInput): string[] {
	// 取值保护不是兼容口子:这两个数组来自 LLM 的工具参数与 MISSION.md 的 fence,
	// 类型上必填不代表运行时一定在。裁判被畸形输入打崩,比判错更糟 ——
	// 缺字段一律走"没有覆盖"这条错误路径,而不是抛异常。
	const dwIds = (input.doneWhen ?? []).map((d) => d.id.trim()).filter(Boolean);
	if (dwIds.length === 0) {
		return ["definition.doneWhen 为空:没有完成条件就没有东西可覆盖,回 DEFINE 把问题定义补完整"];
	}

	const errors: string[] = [];
	const known = new Set(dwIds);
	const covered = new Set<string>();

	for (const ac of input.acs) {
		const covers = (ac.covers ?? []).map((c) => c.trim()).filter(Boolean);
		if (covers.length === 0) {
			errors.push(
				`${ac.id} 没有声明它覆盖哪条完成条件(covers 为空)。` +
					"每条 AC 都必须对应人批准过的某条 doneWhen —— 不对应任何完成条件的 AC 是夹带进来的," +
					"它会被冻结成只读,然后用整套熔断机制去追一个没人要的东西。",
			);
			continue;
		}
		for (const c of covers) {
			if (!known.has(c)) {
				errors.push(`${ac.id} 的 covers 引用了不存在的完成条件 "${c}"(现有:${dwIds.join(", ")})`);
				continue;
			}
			covered.add(c);
		}
	}

	const missing = dwIds.filter((id) => !covered.has(id));
	if (missing.length > 0) {
		errors.push(
			`这些完成条件没有任何 AC 覆盖:${missing.join(", ")}。` +
				"人批准的是这张清单,漏掉的那条就是'人以为会做、机器不会验'的部分 —— " +
				"要么补一条能跑出退出码的 AC,要么这条本来就该是 nonGoal,回 DEFINE 改问题定义(L3)。",
		);
	}
	return errors;
}

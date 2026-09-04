/**
 * pi-missions · core/replan
 *
 * L2 重规划时的 AC 不可变校验。
 *
 * ARCHITECTURE §4.1 那张表把它当既成事实写着 ——
 * `| L2 | 改方案 | 任务分解,**AC 不变** | 回 PLAN,强制换脑 |`,
 * 「基线只在首次冻结跑」那段更是直接拿它当理由:
 * 「而 L2 的定义就是 AC 不变、只改方案,planner 连改 AC 脱身的余地都没有」。
 *
 * **在这个文件出现之前,没有任何代码守这条。** `writePlan()` 把提交上来的
 * acceptanceCriteria 直接合并进新计划,三道校验(结构 / 覆盖 / 探针额度)
 * 没有一道比对新旧。
 *
 * 真机实证(E7,09-04):T5 被独立核验判 FAIL,理由是「不得以削弱既有断言的方式变绿」;
 * 模型升 L2 回 PLAN,重交的 AC5 把「无需修改现有测试断言」这句**删掉了** ——
 * 正是判它失败的那一句。coverage 照样放行(DW4 仍被 AC5 盖着,它只查覆盖不查正文)。
 *
 * 两个洞叠起来才是全貌:基线只在首次冻结跑,理由是「L2 的定义就是 AC 不变」——
 * 于是 L2 上改完的 AC **永远不过红绿校验**。E4 那道闸门在重规划路径上是关着的,
 * 而关它的理由是一条没人守的不变量。
 *
 * 这里只做集合与字面量比对,不做语义判断 —— 判「改得对不对」需要模型,
 * 而让模型评价模型自己改的判据,就又回到自评了(同 core/criterion.ts 的立场)。
 */

import type { ReplanCause } from "./types.ts";

/** 只取比对需要的字段,不依赖 store/mission 的完整类型 */
export interface AcSnapshot {
	id: string;
	text: string;
	verify: string;
	covers: string[];
	baseline?: string;
}

export interface AcImmutabilityInput {
	/**
	 * 这一趟是**怎么回到 PLAN 的**(`MissionState.replanCause`)。
	 * 只有 `"escalation"`(L2)才锁 AC。
	 */
	cause: ReplanCause;
	/** 上一次冻结的那份 AC。空数组 = 还没冻结过,无基准可比 */
	frozen: AcSnapshot[];
	/** 本次提交的 AC */
	submitted: AcSnapshot[];
}

const HOW_TO = "改 AC 要走 L3(回 DEFINE 重新定义问题 + 人工确认);L2 只能改任务分解,判定标准不动。";

/** 归一化:空白折叠 + 去首尾,避免「多打一个空格」被判成改了判据 */
function norm(s: string | undefined): string {
	return (s ?? "").replace(/\s+/g, " ").trim();
}

function coversOf(ac: AcSnapshot): string {
	return [...(ac.covers ?? [])].map((c) => c.trim()).filter(Boolean).sort().join(",");
}

/**
 * 纯函数:这次提交允不允许动 AC。返回错误信息数组,空数组 = 通过。
 *
 * 两条放行规则,都机械可测:
 *   1. 没有冻结基准 —— 首次规划。无从比对。
 *   2. `cause !== "escalation"` —— 不是 L2 回来的。包括:
 *      探针返回(带着实测结论重写计划,那是它的设计终点)、
 *      L3(绕道 DEFINE,`doneWhen` 本身可能已经变了)、
 *      以及首次规划被评审打回后重交(`cause` 还是 null)。
 *   其余(L2 且有基准)—— 逐条比对 id/text/verify/covers/baseline。
 *
 * **只比 id 等于没比**:E7 那次 id 一个没变,变的是 text。
 *
 * **判别式一定要问"因为什么回来的",不能问"层级是几"** —— 这是真机换来的:
 * 第一版写成 `escalationLevel >= 3 放行、其余比对`,而探针返回时层级仍是 1
 * (spike 不进熔断、不进 ACT),于是掉进为 L2 准备的那一档。E6(09-04)当场撞上:
 * 探针量完回 PLAN,AC2/AC3/AC4 三条改动全被退回,理由还指着 L3 ——
 * 而这个 mission 从头到尾没升过一次级。
 */
export function evaluateAcImmutability(input: AcImmutabilityInput): string[] {
	const frozen = input.frozen ?? [];
	const submitted = input.submitted ?? [];

	if (frozen.length === 0) return [];
	if (input.cause !== "escalation") return [];

	const errors: string[] = [];
	const byId = new Map(frozen.map((ac) => [ac.id, ac]));

	const removed = frozen.filter((ac) => !submitted.some((s) => s.id === ac.id)).map((ac) => ac.id);
	if (removed.length > 0) {
		errors.push(`L2 重规划删掉了已冻结的 AC:${removed.join(", ")}。${HOW_TO}`);
	}

	for (const ac of submitted) {
		const was = byId.get(ac.id);
		if (!was) {
			errors.push(`L2 重规划新增了 AC ${ac.id}(冻结时不存在)。${HOW_TO}`);
			continue;
		}
		const diffs: string[] = [];
		if (norm(was.text) !== norm(ac.text)) {
			diffs.push(`text(冻结时:「${norm(was.text)}」)`);
		}
		if (norm(was.verify) !== norm(ac.verify)) {
			diffs.push(`verify(冻结时:${norm(was.verify)})`);
		}
		if (coversOf(was) !== coversOf(ac)) {
			diffs.push(`covers(冻结时:${coversOf(was) || "空"})`);
		}
		// baseline 缺省是 "red",两边都要过一遍缺省再比,否则「显式写 red」会被误判成改动
		if ((was.baseline ?? "red") !== (ac.baseline ?? "red")) {
			diffs.push(`baseline(冻结时:${was.baseline ?? "red"})`);
		}
		if (diffs.length > 0) {
			errors.push(`${ac.id} 的 ${diffs.join("、")} 被改了。${HOW_TO}`);
		}
	}

	return errors;
}

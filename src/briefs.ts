/**
 * pi-missions · briefs
 *
 * 渲染 State Card、DO/ACT/handoff 简报的纯函数。
 * 从 runtime.ts 提取 —— 它们不依赖 Runtime 实例,接 (plan, state) 返回字符串。
 * runtime.ts 保留管道职责:采证据 → judge → 喂事件 → 翻译 effects。
 */

import type { MissionPlan } from "./store/mission.ts";
import { findTask } from "./store/mission.ts";
import type { MissionState } from "./core/types.ts";
import { roundCapFor } from "./core/define.ts";
import type { QuickCriterion } from "./runtime.ts";

export const QUICK_JUDGE_LABEL: Record<QuickCriterion["judge"], string> = {
	ai: "独立验证者(读 diff 逐条核对)",
	human: "人工终审(提交后由人判定,不是自动判定)",
	command: "命令退出码",
};

export function renderStateCard(
	plan: MissionPlan,
	state: MissionState,
	dirName = "missions",
	generation?: number,
	quickCriterion?: QuickCriterion | null,
): string {
	const task = state.currentTask ? findTask(plan, state.currentTask) : undefined;
	const t = state.currentTask ? state.tasks[state.currentTask] : undefined;
	const acs =
		plan.acceptanceCriteria.length > 0
			? plan.acceptanceCriteria
					.map(
						(c) =>
							`  - ${c.id}: ./${dirName}/state/${state.missionId}/generations/${generation ?? "<generation>"}/verify.sh ${c.verify} 退出码 0 —— ${c.text}`,
					)
					.join("\n")
			: plan.tier === "quick"
				? // 必须印出**真实的判据和裁判**。曾经这里写死一句"判定依据是 --verify 冻结的
					// 那条命令",于是 planner 读到的是"没有冻结的 AC",转头就准备自己造一套 ——
					// 判定标准在卡片上隐形,等于 I2(执行期只读)在模型眼里根本不存在。
					quickCriterion
					? `  quick: ${quickCriterion.text}\n  核对方: ${QUICK_JUDGE_LABEL[quickCriterion.judge]}`
					: "  (quick 档判据尚未冻结:先调用 mission_criterion 定一条,之后才解锁写工具)"
				: "  (尚未冻结:本相位的产出就是可执行的 AC,由 mission_write_plan 提交)";
	const lines = [
		`[MISSION] ${state.missionId} · ${state.tier} · phase=${state.phase}` +
			(state.currentTask ? ` · task=${state.currentTask} · attempt=${t?.attempts ?? 0}` : ""),
		`GOAL: ${plan.goal}`,
		`AC(冻结,不可修改):`,
		acs,
	];
	if (plan.definition) {
		const f = plan.definition;
		lines.push(`完成条件(每条都要有 AC 覆盖):${f.doneWhen.map((d) => `${d.id} ${d.text}`).join(" · ")}`);
		if (f.constraints.length) lines.push(`约束(DEFINE 已确认):${f.constraints.join(" · ")}`);
		if (f.nonGoals.length) lines.push(`不做:${f.nonGoals.join(" · ")}`);
		if (f.verifySeam) lines.push(`验证接缝:${f.verifySeam}`);
	}
	if (task?.kind === "spike") {
		lines.push(
			`CURRENT TASK: ${task.id} ${task.title} —— 探针(spike),产出是书面结论,不是代码`,
			`  要回答:${task.question ?? ""}`,
			`  结论写到:./${dirName}/spikes/${state.missionId}/${task.id}.md(闸门只放行这一个文件)`,
			"  一次机会,不重试;提交后系统会带着结论回到 PLAN 重新规划。",
		);
	} else if (task) {
		// quick 的判据已经完整印在上面的 AC 段里,这里不再重复;standard/complex 印 verify 分支。
		// 曾经的兜底文案是"verify: submit 时提供" —— 那和 mission_submit 不接受任何参数
		// 直接矛盾,等于在卡片上告诉执行者"判定标准可以事后补"(I2/I3 的反面)。
		const verifyNote = task.verify.join(", ");
		lines.push(`CURRENT TASK: ${task.id} ${task.title}${verifyNote ? `(verify: ${verifyNote})` : ""}`);
	}
	if (t?.lastFailureReason) lines.push(`PREV FAILURE: ${t.lastFailureReason}`);
	if (t?.awaitingEvidence && state.phase === "do") {
		lines.push(`AWAITING EVIDENCE: 上一轮因「${t.awaitingEvidence.reason}」无法判定，请补充机械证据或修改实现后再提交`);
	}
	// 打回意见必须跟着 State Card 走:换脑之后新会话读不到上一轮的对话,
	// 没有它 planner 又回到"只知道被拒、不知道为什么"的状态
	if (state.phase === "plan" && state.planReview.notes.length > 0) {
		const notes = state.planReview.notes;
		lines.push(`PREV REJECTION(第 ${state.planReview.rejections} 次): ${notes[notes.length - 1]}`);
		if (notes.length > 1) lines.push(`  更早的打回:${notes.slice(0, -1).join(" / ")}`);
	}
	if (state.pendingHandoff) lines.push(`⏸ 换脑挂起中:${state.pendingHandoff}。请执行 /mission next。`);
	if (state.phase === "define") {
		const asked = state.defineAsks;
		const cap = roundCapFor(state.tier);
		if (asked >= cap) {
			lines.push(
				`提问轮次已用完(${asked}/${cap}):根据已有回答调用 mission_define;仍不足以定义就说明缺什么,由人重新描述。`,
			);
		} else {
			lines.push(
				`先定义问题:读代码,必要时 mission_ask 提问(已用 ${asked}/${cap} 轮,每轮最多 3 个,每个问题必须带推荐答案)。` +
					"不要写代码或设计方案。",
			);
			if (asked > 0 && state.defineSettled.length > 0) {
				lines.push(`已落定:${state.defineSettled.join(" · ")} —— 再问一轮必须让这个清单变长。`);
			}
			if (state.defineAnswers.length > 0) {
				// 已收到的回答就摆在这里:换脑后的新会话照这个抄 resolved,不必靠上下文
				for (const rec of state.defineAnswers.slice(-6)) {
					lines.push(`问:${rec.q.replace(/\s+/g, " ")}`);
					lines.push(`答:${rec.a.replace(/\s+/g, " ")}`);
				}
			}
		}
	}
	if (state.phase === "do" && task && task.kind !== "spike") {
		lines.push(`你只需完成 ${task.id}。完成后调用 mission_submit,不要自行判定通过。`);
	}
	return lines.join("\n");
}

export function renderDoBrief(plan: MissionPlan, state: MissionState, spikeReportRel?: string | null): string {
	const task = state.currentTask ? findTask(plan, state.currentTask) : undefined;
	const t = state.currentTask ? state.tasks[state.currentTask] : undefined;
	if (task?.kind === "spike") {
		return [
			`[pi-missions] 进入 DO:${task.id} ${task.title} —— 这是一次**探针(spike)**,不是实现任务。`,
			`要回答的问题:${task.question ?? ""}`,
			`只做调查(读代码、grep、跑只读命令),把结论写进 ${spikeReportRel ?? "结论文件"} ——`,
			"闸门只放行写这一个文件,改实现会被拦。结论要给出依据的事实(文件、数量、报错、测量值),",
			"不要写\"需要进一步调研\"。写完调用 mission_submit;之后系统会带着结论回到 PLAN 重新规划。",
			"探针只打一次,没有第二次尝试。",
		].join("\n");
	}
	if (t?.awaitingEvidence) {
		const acList = t.awaitingEvidence.acIds.length > 0 ? ` (涉及 AC: ${t.awaitingEvidence.acIds.join(", ")})` : "";
		return [
			`[pi-missions] 回到 DO:${state.currentTask} —— 上一轮判定因「${t.awaitingEvidence.reason}」无结论${acList}。`,
			"本系统已启用补证据闸门:在工作区有实际改动前,原样重交将被直接拦截。",
			"请按以下指引补全证据后重试:",
			"1. 为对应 verify 分支补充能够跑出明确结论的机械断言,或完善实现使只读验证者可核验;",
			"2. 重交前请在终端自测对应 verify 分支,确认其已能产出确定结果;",
			"3. 若缺少证据是因计划分解/AC 分配有误(如对应分支应由后续任务负责),请调用 mission_escalate 升级方案,切勿盲目硬改。",
			"补充证据后调用 mission_submit 重新判定。",
		].join("\n");
	}
	const lines = [`[pi-missions] 进入 DO:${state.currentTask} ${task?.title ?? ""}(第 ${t?.attempts ?? 1} 次尝试)`];
	if (t?.lastFailureReason) lines.push(`上一轮失败:${t.lastFailureReason} —— 换思路,不要重复同一修法。`);
	lines.push("完成后调用 mission_submit。");
	return lines.join("\n");
}

export function renderActBrief(plan: MissionPlan, state: MissionState): string {
	const t = state.currentTask ? state.tasks[state.currentTask] : undefined;
	return [
		`[pi-missions] 进入 ACT:${state.currentTask} 第 ${t?.attempts ?? "?"} 次尝试验证失败。`,
		`失败:${t?.lastFailureReason ?? "见 LOG.md"}`,
		"分析失败性质并给出下一轮的修法(实现问题),或调用 mission_escalate 升级(方案/问题定义问题)。你只有这一轮,不能写代码。",
	].join("\n");
}

export function renderHandoffBrief(
	plan: MissionPlan,
	state: MissionState,
	dirName = "missions",
	generation?: number,
	quickCriterion?: QuickCriterion | null,
	inMemory = false,
): string {
	return [
		renderStateCard(plan, state, dirName, generation, quickCriterion),
		"",
		`工作流规则见 ${dirName}/README.md;当前相位规则见 ${dirName}/phases/${state.phase}.md。`,
		state.phase === "plan"
			? inMemory
				? // quick 不落盘:没有 LOG.md 可读。指着一个不存在的文件让人去读,
					// 换来的是新会话花好几轮 ls/cat 找不到,然后在没有失败历史的情况下瞎猜。
					"重规划:该 mission 不落盘,没有 LOG.md —— 失败历史只有上面 PREV FAILURE 那一条,别去 missions/state 找。"
				: `重规划:先读 ${dirName}/state 下该 mission 的 LOG.md 失败记录,再调用 mission_write_plan。`
			: "",
		state.phase === "define"
			? `重新定义问题(L3):先读 ${dirName}/state 下该 mission 的 LOG.md 与 archive/ 里的旧 MISSION.md,` +
				"弄清原来的问题定义错在哪。提问预算已重置,可以再问一轮,然后调用 mission_define。"
			: "",
	]
		.filter(Boolean)
		.join("\n");
}

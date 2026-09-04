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
import { scoutRoundCapFor, type ScoutFanoutProgress, type ScoutFinding } from "./core/scout.ts";
import type { QuickCriterion } from "./runtime.ts";

export const QUICK_JUDGE_LABEL: Record<QuickCriterion["judge"], string> = {
	ai: "独立验证者(读 diff 逐条核对)",
	human: "人工终审(提交后由人判定,不是自动判定)",
	command: "命令退出码",
};

/**
 * State Card 的验收标准段。
 *
 * 这一段在**每个相位**都渲染,所以每条占位文案都必须对当前相位成立 ——
 * 尤其不能提该相位拿不到的工具。踩过两次:
 *   · DEFINE 相位印"本相位的产出就是可执行的 AC,由 mission_write_plan 提交" ——
 *     两句都错:AC 是下一相位的产出,而 DEFINE 的工具集里没有 mission_write_plan。
 *     define.md 正好反着写("在这里写 AC 是 PLAN 的活"),卡片每轮打自己一次脸。
 *   · quick 判据缺失时印"先调用 mission_criterion" —— 只有 PLAN 拿得到那个工具。
 */
function renderAcBlock(
	plan: MissionPlan,
	state: MissionState,
	dirName: string,
	generation: number | undefined,
	quickCriterion?: QuickCriterion | null,
): string {
	if (plan.acceptanceCriteria.length > 0) {
		return plan.acceptanceCriteria
			.map(
				(c) =>
					`  - ${c.id}: ./${dirName}/state/${state.missionId}/generations/${generation ?? "<generation>"}/verify.sh ${c.verify} 退出码 0 —— ${c.text}`,
			)
			.join("\n");
	}
	if (plan.tier === "quick") {
		// 必须印出**真实的判据和裁判**。曾经这里写死一句"判定依据是 --verify 冻结的
		// 那条命令",于是 planner 读到的是"没有冻结的 AC",转头就准备自己造一套 ——
		// 判定标准在卡片上隐形,等于 I2(执行期只读)在模型眼里根本不存在。
		if (quickCriterion) {
			return `  quick: ${quickCriterion.text}\n  核对方: ${QUICK_JUDGE_LABEL[quickCriterion.judge]}`;
		}
		// 判据缺失只在 PLAN 是正常状态(还没定);别处出现是状态坏了,
		// 这时指路一个模型看不见的工具,只会让它撞几轮闸门然后自己拟一条继续做。
		return state.phase === "plan"
			? "  (quick 档判据尚未冻结:先调用 mission_criterion 定一条,之后才解锁写工具)"
			: "  (quick 档判据缺失 —— 这不该发生。请 /mission abort 后重开,不要自己拟一条继续做)";
	}
	return state.phase === "define"
		? "  (还没有 AC:先把问题定义清楚,AC 是下一相位 PLAN 的产出)"
		: "  (尚未冻结:本相位的产出就是可执行的 AC,由 mission_write_plan 提交)";
}

export function renderStateCard(
	plan: MissionPlan,
	state: MissionState,
	dirName = "missions",
	generation?: number,
	quickCriterion?: QuickCriterion | null,
): string {
	const task = state.currentTask ? findTask(plan, state.currentTask) : undefined;
	const t = state.currentTask ? state.tasks[state.currentTask] : undefined;
	const acs = renderAcBlock(plan, state, dirName, generation, quickCriterion);
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
	// 侦查结论跟着 State Card 走,理由与上面的打回意见逐字相同:换脑之后新会话读不到
	// 上一轮的对话,而额度已经烧掉了。查明的与未查明的**分开印** —— 混在一起的话,
	// planner 会把自己的假设当成核实过的事实写进 AC,那正是 scout 想消除的东西。
	if (state.phase === "plan") {
		const used = state.scoutRounds ?? 0;
		const scap = scoutRoundCapFor(state.tier);
		if (scap > 0 && used > 0) {
			lines.push(`侦查轮次:已用 ${used}/${scap}(闸门细则见 mission_scout 的工具说明)。`);
		}
		const findings = state.scoutFindings ?? [];
		for (const f of findings.filter((x) => x.status === "answered")) {
			const cite = f.citations.length ? `(出处:${f.citations.join(", ")})` : "";
			lines.push(`已查明 ${f.id}${f.surprised ? "(与假设有出入)" : ""}:${f.answer.replace(/\s+/g, " ")}${cite}`);
		}
		for (const f of findings.filter((x) => x.status === "unanswered")) {
			lines.push(`未查明 ${f.id}:${f.answer.replace(/\s+/g, " ")} —— 这不是事实,按风险项处理,别据它写 AC。`);
		}
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
			// 只报**此刻的状态**,不复述闸门规则 —— 那些在 mission_ask 的工具说明里,
			// 模型决定调用时正好看得到。卡片每轮都注入,复述规则是纯开销。
			lines.push(`提问轮次:已用 ${asked}/${cap}(闸门细则见 mission_ask 的工具说明)。`);
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
		// 这里**不要**指路 mission_escalate:DO 的工具集是 [内置工具 + mission_submit]
		// (toolsForPhase("do")),里面没有它。原文案让执行者去调一个它看不见的工具,
		// 而且恰好是在它最需要出口的时候 —— 无结论不进 ACT,只回 DO。
		return [
			`[pi-missions] 回到 DO:${state.currentTask} —— 上一轮判定因「${t.awaitingEvidence.reason}」无结论${acList}。`,
			"无结论不是失败:不计尝试次数,但也换不来通过 —— 判定拿不到能说话的证据。",
			"工作区没有实际改动时原样重交会被直接拦下,所以先做下面这件事再提交:",
			"1. 给对应 verify 分支补一条能跑出明确结论的机械断言;或者把实现补完整,让只读验证者核得动;",
			"2. 提交前自己先跑一遍那个分支,确认它现在能给出确定的红或绿。",
			"如果这条判据根本不该由当前任务负责(比如它验的是后续任务的产出),不要硬凑一个绿 ——",
			"把这个判断明确写出来,连续 3 轮无结论系统会停机等人,那时你写下的理由就是人要看的东西。",
			"补好证据后调用 mission_submit 重新判定。",
		].join("\n");
	}
	const lines = [`[pi-missions] 进入 DO:${state.currentTask} ${task?.title ?? ""}(第 ${t?.attempts ?? 1} 次尝试)`];
	if (t?.lastFailureReason) lines.push(`上一轮失败:${t.lastFailureReason} —— 换思路,不要重复同一修法。`);
	lines.push("完成后调用 mission_submit。");
	return lines.join("\n");
}

export function renderActBrief(plan: MissionPlan, state: MissionState): string {
	const t = state.currentTask ? state.tasks[state.currentTask] : undefined;
	// quick 的 ACT 工具集里没有 mission_escalate(toolsForPhase("act", "quick")),
	// 它的出口是自动升档回 PLAN。对它说"或调用 mission_escalate"是指一个看不见的工具,
	// 而且把出口说反了 —— 升档是把判定收严,不是换个级别接着修。
	const exit =
		state.tier === "quick"
			? "这一轮之后系统会自动升档 standard 并带着你的诊断回 PLAN 重写计划(判据会摊开成冻结 AC + verify.sh),你不需要调用任何工具。"
			: "分析失败性质并给出下一轮的修法(实现问题),或调用 mission_escalate 升级(方案/问题定义问题)。";
	return [
		`[pi-missions] 进入 ACT:${state.currentTask} 第 ${t?.attempts ?? "?"} 次尝试验证失败。`,
		`失败:${t?.lastFailureReason ?? (state.tier === "quick" ? "见上一轮判定" : "见 LOG.md")}`,
		`${exit}你只有这一轮,不能写代码。`,
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
		// 同 LOG.md 那条:quick 不铺脚手架,`missions/README.md` 与 `phases/<phase>.md`
		// 都不存在。指着不存在的文件让新会话去读,换来的是几轮 ls/cat 白跑 ——
		// 而这一档的相位规则本来就每轮注入在系统提示里(QUICK_PHASE_RULES),不必去找。
		inMemory
			? "当前相位的规则已经在系统提示里,这一档不铺 missions/ 脚手架 —— 没有 README.md,也没有 phases/,别去找。"
			: `工作流规则见 ${dirName}/README.md;当前相位规则见 ${dirName}/phases/${state.phase}.md。`,
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


// ─────────────────────────── 侦查扇出(scout)的渲染 ───────────────────────────

/**
 * 扇出结果的信封 —— planner 调完 mission_scout 立刻读到的那段。
 *
 * 两条纪律都是防同一件事(planner 把自己的假设当成核实过的事实):
 *   · 查明与未查明**分开列**,未查明的那几条明说"这是你的假设,不是事实"
 *   · 顶部点名哪几条与假设有出入 —— 顺着读下去最容易滑过的恰恰是这几条,
 *     而它们正是这一轮扇出唯一买到的东西
 *
 * 顺序保持提问顺序(不按"有出入"重排):id 是 planner 自己编的,乱序会让它对不上号。
 */
export function renderScoutEnvelope(
	round: number,
	findings: ScoutFinding[],
	failures: Record<string, string> = {},
): string {
	const answered = findings.filter((f) => f.status === "answered");
	const missing = findings.filter((f) => f.status === "unanswered");
	const surprises = answered.filter((f) => f.surprised).map((f) => f.id);
	const head =
		`第 ${round} 轮侦查回来了(${findings.length} 路:查明 ${answered.length},未查明 ${missing.length}` +
		(surprises.length ? `;与你的假设有出入:${surprises.join("、")}` : "") +
		")。";

	const lines: string[] = [head, ""];
	for (const f of findings) {
		if (f.status === "answered") {
			lines.push(`${f.id} ${f.surprised ? "与假设有出入" : "符合假设"}`);
			lines.push(`  问:${f.question}`);
			lines.push(`  你的假设:${f.assume}`);
			lines.push(`  结论:${f.answer}`);
			lines.push(`  出处:${f.citations.join(", ")}`);
		} else {
			lines.push(`${f.id} 未查明${failures[f.id] ? `(${failures[f.id]})` : ""}`);
			lines.push(`  问:${f.question}`);
			lines.push(`  ${f.answer}`);
		}
	}
	lines.push("");
	lines.push("这些结论已经落盘,换脑之后也在 State Card 里,不必转抄。");
	if (missing.length > 0) {
		lines.push(
			`标「未查明」的那 ${missing.length} 条不是事实,是你自己的假设 —— ` +
				"在计划里当风险项处理(或者排一个 spike 去量),别据它写 AC。",
		);
	}
	lines.push("本轮到此为止:不要继续分析,现在写计划并调用 mission_write_plan。");
	return lines.join("\n");
}

/** 扇出进行中的进度文本(经工具的 onUpdate 流式回显)。一路一行,窄终端也读得下 */
export function renderScoutProgress(p: ScoutFanoutProgress): string {
	const head = `侦查扇出 ${p.done}/${p.total} 路已回`;
	const rows = Object.entries(p.activity).map(([id, act]) => `  ${id}  ${act}`);
	return [head, ...rows].join("\n");
}

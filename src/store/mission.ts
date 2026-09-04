/**
 * pi-missions · store/mission
 *
 * MISSION.md 的单向投影:
 *   正文与尾部 ```mission fence 都给人审阅/排障,v2 的唯一机器真相源是 SNAPSHOT.json。
 *   L0 由结构化 plan 渲染 generation,resume 不反向解析 MISSION.md。
 */

import type { Tier } from "../core/types.ts";
import type { Baseline } from "../core/baseline.ts";
import type { TaskKind } from "../core/spike.ts";
import { formatVerifyScriptIssues, inspectVerifyScript } from "../core/verify-script.ts";

export interface AcceptanceCriterion {
	id: string;
	text: string;
	/** verify.sh 的分支名 —— AC 的可执行入口,不写裸命令(I9) */
	verify: string;
	/**
	 * 这条 AC 覆盖 definition.doneWhen 里的哪几条(DW1/DW2…)。
	 * 校验见 core/coverage.ts:没漏(每条 DW 都有 AC)+ 没夹带(每条 AC 都有归属)。
	 */
	covers: string[];
	/**
	 * 冻结时该分支应有的状态。缺省 "red"。
	 * red = 现在必须失败(红→绿才是证据);green = 回归项,现在必须已经通过。
	 * 校验见 core/baseline.ts。
	 */
	baseline?: Baseline;
}

export interface PlanTask {
	id: string;
	title: string;
	/** 本任务必须通过的 verify.sh 分支名列表(spike 任务必须为空) */
	verify: string[];
	/** impl(缺省)= 写代码;spike = 打探针出结论,见 core/spike.ts */
	kind?: TaskKind;
	/** spike 必填:这根探针要回答的那一个问题。判定就是核对结论有没有回答它 */
	question?: string;
}

export interface PlanMilestone {
	id: string;
	title: string;
	tasks: PlanTask[];
}

/** 一条人话的完成条件。PLAN 必须把它翻译成能跑出退出码的 AC */
export interface DoneWhen {
	/** DW1 / DW2 …,AC 的 covers 用它指代 */
	id: string;
	text: string;
}

/** DEFINE 相位的产出:锐化后的目标 + 完成条件 + 明确的边界。PLAN 据此设计 AC */
export interface Definition {
	/** 已确认的约束/前提(来自人工回答或代码事实) */
	constraints: string[];
	/** 明确不做的事 —— 边界写不出来,AC 就会漂 */
	nonGoals: string[];
	/**
	 * 人话的完成条件清单。这是 DEFINE 唯一有机械化下游后果的产出:
	 * 每条必须被至少一条 AC 覆盖(core/coverage.ts),否则计划冻结不了。
	 */
	doneWhen: DoneWhen[];
	/**
	 * 打算在哪一层验证(已有集成测试 / 契约比对 / CLI 冒烟 / grep 计数)。
	 * 接缝要事先约定,不留到写 AC 时临时决定 —— 选错接缝原本要到冻结基线那一关才炸,
	 * 那时整轮 PLAN 已经烧完了。不做机械校验,它的用途是上确认卡给人看一眼。
	 */
	verifySeam?: string;
	/**
	 * DEFINE 问答的落盘(没问过就是空数组)。人的回答只活在上下文里,换脑即丢,
	 * 而提问额度已经烧掉了 —— 这是"内存态不可信"的一个真实缺口。
	 */
	resolved: { q: string; a: string }[];
	at: number;
}

/** 一条方案决策。满足 ADR 三条判据(难逆转/反直觉/有真权衡)的,值得标 sticky */
export interface ApproachDecision {
	/** D1 / D2 … */
	id: string;
	/** 决定了什么 */
	text: string;
	/** 为什么 —— 没有理由的决策不是决策,是偏好 */
	why: string;
	/** 否决了什么。半年后有人再提同一个方案时,这一行能省掉一整轮讨论 */
	rejected?: string;
	/** 难以逆转 + 反直觉 + 有真权衡。留给将来 mission 完成时提示落 ADR */
	sticky?: boolean;
}

/**
 * 方案。原本 MissionPlan 从 goal 直接跳到 verify 分支,
 * 中间的"打算怎么做"没有任何载体 —— 于是人看不到架构,L2(改方案)也没有落点。
 *
 * 它没有可追溯的对端(决策与 AC 不是一一对应:一条"不动 User 表"的决策可能不产生
 * 任何 AC,它的价值是排除了一整片方案空间),所以**不假装它可机械判定** ——
 * 校验只做最弱的一档,真正的过滤器是人在计划评审页读它。
 */
export interface Approach {
	summary: string;
	decisions: ApproachDecision[];
}

export interface MissionPlan {
	missionId: string;
	tier: Tier;
	goal: string;
	/**
	 * DEFINE 的产出。**只有 quick 档没有** —— 它不经过 DEFINE 相位,
	 * 判定依据是 `--verify` 冻结的那条命令。standard/complex 一定有。
	 */
	definition?: Definition;
	/** 方案。complex 强制,standard/quick 可选 */
	approach?: Approach;
	acceptanceCriteria: AcceptanceCriterion[];
	milestones: PlanMilestone[];
	/** verify.sh 完整内容,与 MISSION.md 原子冻结(Q6) */
	verifyScript: string;
	createdAt: number;
}

const FENCE_RE = /```mission\s*\n([\s\S]*?)\n```/;

export function taskOrder(plan: MissionPlan): string[] {
	return plan.milestones.flatMap((m) => m.tasks.map((t) => t.id));
}

export function spikeTaskIds(plan: MissionPlan): string[] {
	return allTasks(plan)
		.filter((t) => t.kind === "spike")
		.map((t) => t.id);
}

export function allTasks(plan: MissionPlan): PlanTask[] {
	return plan.milestones.flatMap((m) => m.tasks);
}

export function findTask(plan: MissionPlan, taskId: string): PlanTask | undefined {
	return allTasks(plan).find((t) => t.id === taskId);
}

export function findMilestoneOf(plan: MissionPlan, taskId: string): PlanMilestone | undefined {
	return plan.milestones.find((m) => m.tasks.some((t) => t.id === taskId));
}

export function isLastTaskOfMilestone(plan: MissionPlan, taskId: string): boolean {
	const ms = findMilestoneOf(plan, taskId);
	return !!ms && ms.tasks[ms.tasks.length - 1]?.id === taskId;
}

/** 校验计划结构;返回错误信息数组,空数组 = 合法 */
export function validatePlan(plan: MissionPlan): string[] {
	const errors: string[] = [];
	if (!plan.goal?.trim()) errors.push("goal 为空");
	if (plan.acceptanceCriteria.length === 0) errors.push("至少需要一条验收标准(AC)");
	if (taskOrder(plan).length === 0) errors.push("至少需要一个任务");

	// approach:complex 强制。它是 L2(改方案)的载体,也是人在评审页真正要读的东西 ——
	// 里程碑级的 mission 没有方案说明,等于让人批准一份只有验收标准的合同。
	const ap = plan.approach;
	if (plan.tier === "complex") {
		if (!ap?.summary?.trim()) errors.push("complex 档必须写 approach.summary(整体怎么做、动哪几个模块)");
		if (!ap?.decisions?.length) errors.push("complex 档必须至少写一条 approach.decisions(方案决策)");
	}
	if (ap) {
		const dIds = new Set<string>();
		for (const d of ap.decisions ?? []) {
			if (dIds.has(d.id)) errors.push(`决策 id 重复:${d.id}`);
			dIds.add(d.id);
			if (!d.text?.trim()) errors.push(`${d.id} 的 text 为空`);
			if (!d.why?.trim()) errors.push(`${d.id} 没写为什么 —— 没有理由的决策不是决策,是偏好`);
		}
	}

	const acIds = new Set<string>();
	const verifyNames = new Set<string>();
	for (const ac of plan.acceptanceCriteria) {
		if (acIds.has(ac.id)) errors.push(`AC id 重复:${ac.id}`);
		acIds.add(ac.id);
		if (!ac.verify?.trim()) errors.push(`${ac.id} 缺少 verify 入口(验收标准必须可执行)`);
		verifyNames.add(ac.verify);
	}

	const taskIds = new Set<string>();
	for (const t of allTasks(plan)) {
		if (taskIds.has(t.id)) errors.push(`任务 id 重复:${t.id}`);
		taskIds.add(t.id);

		// spike 走另一套判定(结论文件 + 独立验证者核对是否回答了问题),
		// 它没有 verify 分支 —— 探针的产出是结论,不是绿色
		if (t.kind === "spike") {
			if (!t.question?.trim()) errors.push(`${t.id} 是 spike,必须写明它要回答的那一个问题(question)`);
			if (t.verify.length > 0) {
				errors.push(`${t.id} 是 spike,不能有 verify 分支(它的产出是书面结论,不是退出码)`);
			}
			continue;
		}

		if (t.question?.trim()) errors.push(`${t.id} 不是 spike,不该带 question`);
		if (t.verify.length === 0) errors.push(`${t.id} 没有 verify 分支(无法判定的事不该进入 DO)`);
		for (const v of t.verify) {
			if (!verifyNames.has(v) && !scriptHasBranch(plan.verifyScript, v)) {
				errors.push(`${t.id} 引用的 verify 分支 "${v}" 既不在 AC 列表也不在 verify.sh 里`);
			}
		}
	}

	for (const v of verifyNames) {
		if (!scriptHasBranch(plan.verifyScript, v)) {
			errors.push(`AC 引用的 verify.sh 分支 "${v}" 在脚本里不存在(case 分支或函数)`);
		}
	}

	// 分支存在 ≠ 分支跑得到源码。三个真实 mission 连着栽在"脚本自己把 cwd 切走"上,
	// 而这个坑要跑完整轮基线(每条 AC 各跑一遍测试)才暴露,报出来的还是隔了一层的
	// 症状(某条声明 green 的 AC 却是红的)。在这里拦掉,代价是零。
	errors.push(...formatVerifyScriptIssues(inspectVerifyScript(plan.verifyScript)));
	return errors;
}

/** 粗检 verify.sh 是否包含某个分支:case 的 `name)` 或函数 `name()` 或子命令判断 */
function scriptHasBranch(script: string, name: string): boolean {
	const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`(^|[\\s|(])${esc}\\s*\\)|"${esc}"|'${esc}'|${esc}\\s*\\(\\s*\\)`, "m").test(script);
}

export function renderMissionMd(plan: MissionPlan): string {
	const lines: string[] = [
		`# Mission: ${plan.missionId}`,
		"",
		`tier: ${plan.tier}`,
		`goal: ${plan.goal}`,
		"",
		"## Frozen Acceptance Criteria",
		"",
		"> 本节只读。修改必须走 L3 升级,并以 `mission-escalate(L3):` 前缀单独提交。",
		"",
	];
	for (const ac of plan.acceptanceCriteria) {
		const covers = ac.covers.length > 0 ? `, 覆盖: ${ac.covers.join("+")}` : "";
		lines.push(`- ${ac.id} (verify: \`${ac.verify}\`, baseline: ${ac.baseline ?? "red"}${covers}): ${ac.text}`);
	}
	lines.push("");

	if (plan.definition) {
		const f = plan.definition;
		lines.push("## Define", "", `> 问题定义(DEFINE 相位产出)`, "");
		lines.push("完成条件(每条都必须被上面的 AC 覆盖):", "");
		for (const d of f.doneWhen) lines.push(`- ${d.id}: ${d.text}`);
		lines.push("");
		for (const c of f.constraints) lines.push(`- 约束:${c}`);
		for (const n of f.nonGoals) lines.push(`- 不做:${n}`);
		if (f.verifySeam?.trim()) lines.push(`- 接缝:${f.verifySeam}`);
		lines.push("");
		if (f.resolved.length > 0) {
			lines.push("<details><summary>DEFINE 问答记录</summary>", "");
			for (const r of f.resolved) lines.push(`- 问:${r.q}`, `  答:${r.a}`);
			lines.push("", "</details>", "");
		}
	}

	if (plan.approach) {
		lines.push("## Approach", "", "> 方案(L2 升级改的就是这一段)", "", plan.approach.summary, "");
		for (const d of plan.approach.decisions) {
			lines.push(`- ${d.id}: ${d.text}`);
			lines.push(`  - 为什么:${d.why}`);
			if (d.rejected?.trim()) lines.push(`  - 否决:${d.rejected}`);
		}
		lines.push("");
	}

	if (plan.tier === "complex") {
		lines.push("## Milestones", "");
		for (const ms of plan.milestones) {
			lines.push(`- [ ] ${ms.id} ${ms.title} → [${ms.id}.md](./${ms.id}.md)`);
		}
		lines.push("", "> 任务明细按里程碑分文件(I8),到哪个里程碑读哪个文件。", "");
	} else {
		lines.push("## Tasks", "");
		for (const ms of plan.milestones) {
			for (const t of ms.tasks) {
				lines.push(`- [ ] ${t.id} ${describeTask(t)}`);
			}
		}
		lines.push("");
	}

	lines.push("```mission", JSON.stringify(fencePayload(plan), null, 2), "```", "");
	return lines.join("\n");
}

export function renderMilestoneMd(plan: MissionPlan, ms: PlanMilestone): string {
	const lines = [`# ${ms.id}: ${ms.title}`, "", `> Mission: ${plan.missionId} · AC 见 MISSION.md`, "", "## Tasks", ""];
	for (const t of ms.tasks) {
		lines.push(`- [ ] ${t.id} ${describeTask(t)}`);
	}
	lines.push("");
	return lines.join("\n");
}

/** 任务在 MISSION.md 里的一行描述 */
function describeTask(t: PlanTask): string {
	return t.kind === "spike"
		? `${t.title} **[spike]** —— 要回答:${t.question ?? ""}(产出书面结论,完成后重写计划)`
		: `${t.title} (verify: ${t.verify.map((v) => `\`${v}\``).join(", ")})`;
}

/** 只解析 fence;没有 fence 或 JSON 非法则返回 null(绝不回读散文) */
export function parseMissionMd(content: string): MissionPlan | null {
	const m = content.match(FENCE_RE);
	if (!m) return null;
	try {
		const payload = JSON.parse(m[1]) as ReturnType<typeof fencePayload>;
		return {
			missionId: payload.missionId,
			tier: payload.tier,
			goal: payload.goal,
			definition: payload.definition,
			approach: payload.approach,
			acceptanceCriteria: payload.acceptanceCriteria,
			milestones: payload.milestones,
			verifyScript: payload.verifyScript,
			createdAt: payload.createdAt,
		};
	} catch {
		return null;
	}
}

function fencePayload(plan: MissionPlan) {
	return {
		missionId: plan.missionId,
		tier: plan.tier,
		goal: plan.goal,
		definition: plan.definition,
		approach: plan.approach,
		acceptanceCriteria: plan.acceptanceCriteria,
		milestones: plan.milestones,
		verifyScript: plan.verifyScript,
		createdAt: plan.createdAt,
	};
}

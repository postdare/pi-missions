/**
 * pi-missions · store/mission
 *
 * MISSION.md 的渲染与解析(Q11):
 *   正文给人看,尾部 ```mission fence 里的 JSON 是机器的 source of truth。
 *   L0 由 mission_write_plan 的结构化参数渲染,resume 时只解析 fence,
 *   绝不回读散文。AC 冻结校验同时覆盖正文与 fence。
 */

import type { Tier } from "../core/types.ts";
import type { Baseline } from "../core/baseline.ts";

export interface AcceptanceCriterion {
	id: string;
	text: string;
	/** verify.sh 的分支名 —— AC 的可执行入口,不写裸命令(I9) */
	verify: string;
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
	/** 本任务必须通过的 verify.sh 分支名列表 */
	verify: string[];
}

export interface PlanMilestone {
	id: string;
	title: string;
	tasks: PlanTask[];
}

/** FRAME 相位的产出:锐化后的目标 + 明确的边界。PLAN 据此设计 AC */
export interface Framing {
	/** 已确认的约束/前提(来自人工回答或代码事实) */
	constraints: string[];
	/** 明确不做的事 —— 边界写不出来,AC 就会漂 */
	nonGoals: string[];
	at: number;
}

export interface MissionPlan {
	missionId: string;
	tier: Tier;
	goal: string;
	/** FRAME 的产出;quick 档与老 mission 没有 */
	framing?: Framing;
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
		lines.push(`- ${ac.id} (verify: \`${ac.verify}\`, baseline: ${ac.baseline ?? "red"}): ${ac.text}`);
	}
	lines.push("");

	if (plan.framing) {
		lines.push("## Frame", "", `> 问题定义(FRAME 相位产出)`, "");
		for (const c of plan.framing.constraints) lines.push(`- 约束:${c}`);
		for (const n of plan.framing.nonGoals) lines.push(`- 不做:${n}`);
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
				lines.push(`- [ ] ${t.id} ${t.title} (verify: ${t.verify.map((v) => `\`${v}\``).join(", ")})`);
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
		lines.push(`- [ ] ${t.id} ${t.title} (verify: ${t.verify.map((v) => `\`${v}\``).join(", ")})`);
	}
	lines.push("");
	return lines.join("\n");
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
			framing: payload.framing,
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
		framing: plan.framing,
		acceptanceCriteria: plan.acceptanceCriteria,
		milestones: plan.milestones,
		verifyScript: plan.verifyScript,
		createdAt: plan.createdAt,
	};
}

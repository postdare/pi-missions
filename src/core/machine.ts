/**
 * pi-missions · core/machine
 *
 * 相位状态机。纯 reducer:(state, event) → { state, effects }
 *
 * 机器本身不执行任何副作用,只产出 Effect 清单交给 hooks 层翻译成 pi API 调用。
 * 这是 core 能被单测的前提,也是"L0 是唯一裁判"的物理保证。
 *
 * 熔断判定(breaker.decide)已并入 VERDICT(fail) 的处理:失败到达时
 * 机器内部直接判定 retry / escalate / halt,签名计数也在机器内更新。
 * hooks 层只是"采集证据 → judge → 发 VERDICT → 执行 effects"的哑管道。
 *
 * 升级阶梯就是相位图上的反向边 —— 往回走一格,而不是一套外挂机制:
 *
 *   FRAME ──▶ PLAN ──▶ DO ⇄ CHECK ──▶ ACT
 *     ▲         ▲        ▲                │
 *     └─ L3 ────┴─ L2 ───┴──── L1 ────────┘
 *   改问题定义   改方案        改实现
 *
 *   ┌───────┐ frame  ┌──────┐      ┌──────┐  submit  ┌───────┐
 *   │ FRAME │──done─▶│ PLAN │─freeze─▶│  DO  │───────▶│ CHECK │
 *   └───────┘        └──────┘      └──────┘           └───┬───┘
 *       ▲                ▲            ▲                   │
 *       │                │            │  PASS ┌───────────┴───┐FAIL
 *       │                │            │       ▼               ▼
 *       │                │            │  next task ──▶   ┌─────┐
 *       │                │            └──────────────────│ ACT │
 *       │                │             ADJUST_DONE(L1)   └──┬──┘
 *       │                └──── ESCALATE L2 ─────────────────┤
 *       └────────── ESCALATE L3(人工确认后)────────────────┘
 */

import type {
	Effect,
	EscalationLevel,
	MissionEvent,
	MissionState,
	Phase,
	Role,
	TaskState,
	TransitionResult,
	Tier,
	Verdict,
} from "./types.ts";
import { applyFailure, decide, resetAfterEscalation } from "./breaker.ts";
import { tierRank } from "./tier.ts";

export const ROLE_OF: Record<Phase, Role | null> = {
	// FRAME 与 PLAN 共用 planner:同一种"读代码 + 想清楚问题"的工作,
	// 不为一个只跑一两轮的相位在 models.json 和成本分账里多开一个维度。
	frame: "planner",
	plan: "planner",
	do: "executor",
	check: "verifier",
	act: "escalator",
	done: null,
	halted: null,
};

/** 连续 INCONCLUSIVE 上限:环境漂移不修复,重试无意义,停机等人 */
export const INCONCLUSIVE_STREAK_CAP = 3;

/**
 * 换脑策略。I5 要求"每次升级必须换干净上下文",这条无条件成立。
 * 任务切换是否换脑则按档位:只有 complex 强制换,其余交给上下文水位触发。
 */
function shouldHandoffOnAdvance(tier: Tier): boolean {
	return tier === "complex";
}

export function transition(state: MissionState, event: MissionEvent): TransitionResult {
	switch (event.type) {
		// ─────────────── 任意相位都可中止 ───────────────
		case "ABORT":
			if (state.phase === "halted" || state.phase === "done") {
				return reject(state, `已处于 ${state.phase},忽略 ABORT`);
			}
			return ok(
				{ ...state, phase: "halted" as const },
				[
					log(`ABORT ${event.reason}`),
					{ type: "RESTORE" },
					{ type: "NOTIFY", level: "warning", message: `任务已终止:${event.reason}` },
				],
				event.at,
			);

		// ─────────────── FRAME:问一轮 / 定义完成 ───────────────
		case "FRAME_ASKED": {
			if (state.phase !== "frame") return reject(state, "FRAME_ASKED 只能在 frame 相位");
			return ok(
				{ ...state, frameAsks: (state.frameAsks ?? 0) + 1 },
				[log("FRAME 提问一轮,等待人工回答")],
				event.at,
			);
		}

		case "FRAME_DONE": {
			if (state.phase !== "frame") return reject(state, "FRAME_DONE 只能在 frame 相位");
			if (state.pendingHandoff) return reject(state, "换脑挂起中,请先 /mission next");
			return ok(
				{ ...state, phase: "plan" as const },
				[...enter("plan"), log("FRAME done, 问题定义已确定 → PLAN")],
				event.at,
			);
		}

		// ─────────────── PLAN → DO ───────────────
		case "PLAN_FROZEN": {
			if (state.phase !== "plan") return reject(state, "PLAN_FROZEN 只能在 plan 相位");
			if (state.pendingHandoff) return reject(state, "换脑挂起中,请先 /mission next");
			// 重规划(L2/L3 后)会携带新的任务顺序:保留已有任务的状态,新任务置 pending
			const order = event.taskOrder ?? state.taskOrder;
			const first = order[0];
			if (!first) return reject(state, "计划中没有任务,无法进入 DO");

			let tasks: Record<string, TaskState> = {};
			for (const id of order) {
				tasks[id] = state.tasks[id] ?? {
					id,
					status: "pending" as const,
					attempts: 0,
					sameSignatureCount: 0,
					inconclusiveStreak: 0,
				};
			}
			tasks = setTask(tasks, first, (t) => ({
				...t,
				status: t.status === "done" ? t.status : ("running" as const),
				attempts: t.status === "done" ? t.attempts : Math.max(1, t.attempts),
			}));

			return ok(
				{ ...state, phase: "do" as const, currentTask: first, taskOrder: order, tasks },
				[
					{ type: "FREEZE_AC" },
					...enter("do"),
					log(`PLAN frozen, start ${first} attempt=${tasks[first].attempts}`),
				],
				event.at,
			);
		}

		// ─────────────── DO → CHECK ───────────────
		case "SUBMIT": {
			if (state.phase !== "do") return reject(state, "SUBMIT 只能在 do 相位");
			if (state.pendingHandoff) return reject(state, "换脑挂起中,请先 /mission next");
			if (!state.currentTask) return reject(state, "无当前任务");
			return ok(
				{ ...state, phase: "check" as const },
				[...enter("check"), log(`${state.currentTask} submitted, verifying`)],
				event.at,
			);
		}

		// ─────────────── CHECK → DO / ACT / PLAN / DONE / HALTED ───────────────
		case "VERDICT": {
			if (state.phase !== "check") return reject(state, "VERDICT 只能在 check 相位");
			const taskId = state.currentTask;
			if (!taskId) return reject(state, "无当前任务");
			const task = state.tasks[taskId];
			const attempt = task?.attempts ?? 1;
			const verdict = event.verdict;

			// 环境漂移等无结论情况:回 DO,不计 attempts,不进熔断。
			// 但连续无结论说明环境问题没人修,达到上限停机等人(I9 的防死循环)。
			if (verdict.outcome === "inconclusive") {
				const streak = (task?.inconclusiveStreak ?? 0) + 1;
				if (streak >= INCONCLUSIVE_STREAK_CAP) {
					return ok(
						{
							...state,
							phase: "halted" as const,
							tasks: setTask(state.tasks, taskId, (t) => ({ ...t, inconclusiveStreak: streak })),
						},
						[
							log(`${taskId} a=${attempt} verdict=INCONCLUSIVE×${streak} → HALTED`),
							{ type: "RESTORE" },
							{
								type: "NOTIFY",
								level: "error",
								message: `连续 ${streak} 次无法判定(${verdict.reason}),停机等待人工检查环境`,
							},
						],
						event.at,
					);
				}
				return ok(
					{
						...state,
						phase: "do" as const,
						tasks: setTask(state.tasks, taskId, (t) => ({ ...t, inconclusiveStreak: streak })),
					},
					[
						...enter("do"),
						log(`${taskId} a=${attempt} verdict=INCONCLUSIVE why=${compact(verdict.reason)}`),
						{
							type: "NOTIFY",
							level: "warning",
							message: `无法判定(不计入熔断,${streak}/${INCONCLUSIVE_STREAK_CAP}):${verdict.reason}`,
						},
					],
					event.at,
				);
			}

			if (verdict.outcome === "fail") {
				return failTransition(state, event.at, taskId, task, verdict);
			}

			// PASS —— 推进到下一任务,或整体完成
			let tasks = setTask(state.tasks, taskId, (t) => ({
				...t,
				status: "done" as const,
				inconclusiveStreak: 0,
				lastFailureReason: undefined,
			}));
			const next = nextTask(state.taskOrder, taskId);

			if (!next) {
				return ok(
					{ ...state, phase: "done" as const, currentTask: null, tasks },
					[
						log(`${taskId} a=${attempt} verdict=PASS · mission done`),
						{ type: "RESTORE" },
						{ type: "NOTIFY", level: "info", message: `Mission ${state.missionId} 全部任务完成` },
					],
					event.at,
				);
			}

			tasks = setTask(tasks, next, (t) => ({ ...t, status: "running" as const, attempts: 1 }));

			const effects: Effect[] = [
				log(`${taskId} a=${attempt} verdict=PASS → ${next}`),
				{ type: "ADVANCE_TASK", taskId: next },
			];
			let pendingHandoff = state.pendingHandoff;
			if (shouldHandoffOnAdvance(state.tier)) {
				pendingHandoff = `advance to ${next}`;
				effects.push({ type: "HANDOFF", reason: `advance to ${next}` });
			}
			effects.push(...enter("do"));

			return ok(
				{ ...state, phase: "do" as const, currentTask: next, tasks, pendingHandoff },
				effects,
				event.at,
			);
		}

		// ─────────────── ACT → DO(L1 重试) ───────────────
		case "ADJUST_DONE": {
			if (state.phase !== "act") return reject(state, "ADJUST_DONE 只能在 act 相位");
			const taskId = state.currentTask;
			if (!taskId) return reject(state, "无当前任务");

			const tasks = setTask(state.tasks, taskId, (t) => ({ ...t, attempts: t.attempts + 1 }));
			const attempt = tasks[taskId].attempts;

			return ok(
				{ ...state, phase: "do" as const, tasks },
				[...enter("do"), log(`${taskId} retry attempt=${attempt}`)],
				event.at,
			);
		}

		// ─────────────── 人工/主动升级(L2/L3) ───────────────
		case "ESCALATE": {
			if (state.phase !== "act" && state.phase !== "do") {
				return reject(state, "ESCALATE 只能在 do 或 act 相位");
			}
			const taskId = state.currentTask;
			if (!taskId) return reject(state, "无当前任务");
			if (event.to <= state.escalation.level) {
				return reject(state, `不能从 L${state.escalation.level} 降级到 L${event.to}`);
			}
			return escalateTransition(state, event.at, taskId, event.to, event.reason);
		}

		case "ESCALATION_CONFIRMED": {
			if (state.escalation.level !== 3) return reject(state, "当前无待确认的 L3 升级");
			const taskId = state.currentTask;
			const tasks = taskId ? setTask(state.tasks, taskId, resetAfterEscalation) : state.tasks;
			// L3 = 改问题定义,落点是 FRAME 而不是 PLAN:AC 本身错了,
			// 直接重新分解方案只会在同一个错误的问题上换个姿势。
			// 提问预算一并重置 —— 新的问题定义值得再问一轮。
			return ok(
				{
					...state,
					phase: "frame" as const,
					tasks,
					frameAsks: 0,
					pendingHandoff: "escalate L3",
				},
				[
					log("L3 confirmed, rewriting mission definition → FRAME"),
					{ type: "ARCHIVE_PLAN", reason: "L3 escalation" },
					{ type: "HANDOFF", reason: "escalate L3" },
					...enter("frame"),
				],
				event.at,
			);
		}

		case "ESCALATION_REJECTED":
			return ok(
				{ ...state, phase: "halted" as const },
				[
					log("L3 rejected by human, halted"),
					{ type: "RESTORE" },
					{
						type: "NOTIFY",
						level: "warning",
						message: "已停机。任务状态保留在仓库中,可 /mission resume 恢复。",
					},
				],
				event.at,
			);

		// ─────────────── 换脑 ───────────────
		case "HANDOFF_REQUEST": {
			if (state.phase === "done" || state.phase === "halted") {
				return reject(state, `已处于 ${state.phase},忽略 HANDOFF_REQUEST`);
			}
			if (state.pendingHandoff) return reject(state, "已有挂起的换脑请求");
			return ok(
				{ ...state, pendingHandoff: event.reason },
				[log(`HANDOFF requested why=${compact(event.reason)}`), { type: "HANDOFF", reason: event.reason }],
				event.at,
			);
		}

		case "HANDOFF_DONE": {
			if (!state.pendingHandoff) return reject(state, "当前无挂起的换脑请求");
			const sessionMap = { ...state.sessionMap };
			if (event.sessionFile && state.currentTask) {
				sessionMap[state.currentTask] = event.sessionFile;
			}
			return ok(
				{ ...state, pendingHandoff: null, sessionMap },
				[log(`HANDOFF done (was: ${compact(state.pendingHandoff)})`)],
				event.at,
			);
		}

		// ─────────────── 机械升档 ───────────────
		case "PROMOTE_TIER": {
			if (state.phase === "done" || state.phase === "halted") {
				return reject(state, `已处于 ${state.phase},忽略升档`);
			}
			if (tierRank(event.to) <= tierRank(state.tier)) {
				return reject(state, `不能从 ${state.tier} 降档/平移到 ${event.to}(降档只能人工重建 mission)`);
			}
			const effects: Effect[] = [
				log(`TIER ${state.tier} → ${event.to} why=${compact(event.reason)}`),
				{ type: "NOTIFY", level: "warning", message: `已自动升档 ${state.tier} → ${event.to}:${event.reason}` },
			];
			if (state.tier === "quick") effects.push({ type: "PERSIST_PLAN" });
			return ok({ ...state, tier: event.to }, effects, event.at);
		}

		default: {
			const never: never = event;
			return reject(state, `未知事件 ${JSON.stringify(never)}`);
		}
	}
}

// ─────────────────────────── 失败处理(breaker 并入点) ───────────────────────────

/**
 * VERDICT(fail) 的处理。签名计数在机器内更新(applyFailure),
 * retry / escalate / halt 由 breaker.decide 判定 —— hooks 层不做任何决策。
 */
function failTransition(
	state: MissionState,
	at: number,
	taskId: string,
	task: TaskState | undefined,
	verdict: Verdict,
): TransitionResult {
	const sig = verdict.signature ?? "nosig";
	const base: TaskState =
		task ?? { id: taskId, status: "running", attempts: 1, sameSignatureCount: 0, inconclusiveStreak: 0 };
	const counted = applyFailure({ ...base, inconclusiveStreak: 0 }, sig);
	counted.lastFailureReason = compact(verdict.reason);

	const action = decide({ tier: state.tier, task: base, signature: sig, level: state.escalation.level });
	const header = `${taskId} a=${base.attempts} verdict=FAIL sig=${sig} ev=${compact(verdict.reason)}`;

	if (action.action === "halt") {
		return ok(
			{ ...state, phase: "halted" as const, tasks: setTask(state.tasks, taskId, () => counted) },
			[
				log(`${header} act=HALT why=${compact(action.reason)}`),
				{ type: "RESTORE" },
				{ type: "NOTIFY", level: "error", message: action.reason },
			],
			at,
		);
	}

	if (action.action === "escalate") {
		const withCount = { ...state, tasks: setTask(state.tasks, taskId, () => counted) };
		return escalateTransition(withCount, at, taskId, action.to, action.reason, header);
	}

	// retry:进 ACT,让 escalator 角色分析失败并给出下一轮修法,然后 ADJUST_DONE 回 DO
	return ok(
		{ ...state, phase: "act" as const, tasks: setTask(state.tasks, taskId, () => counted) },
		[
			...enter("act"),
			log(`${header} act=fix-impl (同签名 ${action.sameSignatureCount},再 ${action.remaining} 次将升级)`),
		],
		at,
	);
}

/** L2/L3 升级的统一路径(自动熔断与人工/主动共用) */
function escalateTransition(
	state: MissionState,
	at: number,
	taskId: string,
	to: 2 | 3,
	reason: string,
	logHeader?: string,
): TransitionResult {
	const record = {
		at,
		taskId,
		from: state.escalation.level as EscalationLevel,
		to,
		signature: state.tasks[taskId]?.lastSignature,
		reason,
	};
	const escalation = { level: to as EscalationLevel, history: [...state.escalation.history, record] };
	const line = `${logHeader ? `${logHeader} ` : ""}${taskId} ESCALATE→L${to} why=${compact(reason)}`;

	// L3 要改冻结 AC,必须人工确认。状态先不迁移,等 CONFIRMED/REJECTED。
	if (to === 3) {
		return ok(
			{ ...state, escalation },
			[
				log(`${line} (待人工确认)`),
				{
					type: "CONFIRM",
					question: `L3 升级将重写问题定义并修改冻结的验收标准。\n理由:${reason}\n确认继续?`,
				},
			],
			at,
		);
	}

	// L2:重写方案,AC 不变。立刻换脑 —— 在被污染的上下文里重新规划毫无意义(I5)。
	const tasks = setTask(state.tasks, taskId, resetAfterEscalation);
	return ok(
		{ ...state, phase: "plan" as const, tasks, escalation, pendingHandoff: `escalate L2 on ${taskId}` },
		[log(line), { type: "HANDOFF", reason: `escalate L2 on ${taskId}` }, ...enter("plan")],
		at,
	);
}

// ─────────────────────────── 辅助 ───────────────────────────

/** 进入某相位的标准副作用:切工具集 + 切角色模型 */
function enter(phase: Phase): Effect[] {
	const effects: Effect[] = [{ type: "SET_TOOLS", phase }];
	const role = ROLE_OF[phase];
	if (role) effects.push({ type: "SET_ROLE", role });
	return effects;
}

function log(line: string): Effect {
	return { type: "LOG", line };
}

function ok(state: MissionState, effects: Effect[], at: number): TransitionResult {
	return { state: { ...state, updatedAt: at }, effects };
}

function reject(state: MissionState, error: string): TransitionResult {
	return { state, effects: [], error };
}

function setTask(
	tasks: Record<string, TaskState>,
	id: string,
	fn: (t: TaskState) => TaskState,
): Record<string, TaskState> {
	const current: TaskState = tasks[id] ?? {
		id,
		status: "pending",
		attempts: 0,
		sameSignatureCount: 0,
		inconclusiveStreak: 0,
	};
	return { ...tasks, [id]: fn(current) };
}

function nextTask(order: string[], current: string): string | null {
	const i = order.indexOf(current);
	return i >= 0 && i + 1 < order.length ? order[i + 1] : null;
}

function compact(s: string): string {
	return s.replace(/\s+/g, " ").trim().slice(0, 120);
}

/**
 * mission 的起始相位。
 * quick 档没有 AC 也没有 PLAN(判定依据是 --verify 冻结的命令),建好立刻冻结进 DO;
 * standard/complex 先过 FRAME —— 需求模糊时写不出 AC,这是 I2 的入口条件。
 */
export const START_PHASE: Record<Tier, Phase> = {
	quick: "plan",
	standard: "frame",
	complex: "frame",
};

/** 便于 hooks 层与测试构造初始状态 */
export function initialState(params: {
	missionId: string;
	tier: Tier;
	taskOrder: string[];
	envFingerprint?: string | null;
}): MissionState {
	const tasks: Record<string, TaskState> = {};
	for (const id of params.taskOrder) {
		tasks[id] = { id, status: "pending", attempts: 0, sameSignatureCount: 0, inconclusiveStreak: 0 };
	}
	return {
		missionId: params.missionId,
		tier: params.tier,
		phase: START_PHASE[params.tier],
		currentTask: null,
		taskOrder: params.taskOrder,
		tasks,
		escalation: { level: 1, history: [] },
		envFingerprint: params.envFingerprint ?? null,
		pendingHandoff: null,
		sessionMap: {},
		frameAsks: 0,
		cost: {},
		metrics: { touchedFiles: [], touchedPublicApi: false },
		updatedAt: 0,
	};
}

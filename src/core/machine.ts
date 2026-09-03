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
 *   DEFINE ─▶ PLAN ──▶ DO ⇄ CHECK ──▶ ACT
 *     ▲         ▲        ▲                │
 *     └─ L3 ────┴─ L2 ───┴──── L1 ────────┘
 *   改问题定义   改方案        改实现
 *
 *   ┌────────┐ define ┌──────┐      ┌──────┐  submit  ┌───────┐
 *   │ DEFINE │─done─▶│ PLAN │─freeze─▶│  DO  │───────▶│ CHECK │
 *   └────────┘       └──────┘      └──────┘           └───┬───┘
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
	InconclusiveCause,
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
import { evaluatePlanReview, PLAN_REJECT_CAP } from "./review.ts";

export const ROLE_OF: Record<Phase, Role | null> = {
	// DEFINE 与 PLAN 共用 planner:同一种"读代码 + 想清楚问题"的工作,
	// 不为一个只跑一两轮的相位在 models.json 和成本分账里多开一个维度。
	define: "planner",
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
 * 停机时该把人指向哪儿。成因说错等于把人支到错误的方向 ——
 * 真实事故:核验模型 400,连着三轮判无结论,提示写的却是"环境可能漂移"。
 */
const HALT_HINT: Record<InconclusiveCause, string> = {
	evidence: "停机等待人工检查证据采集(verify 分支是否真的跑出了输出)",
	judge: "停机等待修复核验裁判",
};

/**
 * 换脑策略。I5 要求"每次升级必须换干净上下文",这条无条件成立。
 * 任务切换是否换脑则按档位:只有 complex 强制换,其余交给上下文水位触发。
 */
function shouldHandoffOnAdvance(tier: Tier): boolean {
	return tier === "complex";
}

export function transition(state: MissionState, event: MissionEvent): TransitionResult {
	switch (event.type) {
		case "RECORD_TOUCHED_FILE": {
			const touchedFiles = state.metrics.touchedFiles.includes(event.path)
				? state.metrics.touchedFiles
				: [...state.metrics.touchedFiles, event.path];
			return ok(
				{
					...state,
					metrics: {
						touchedFiles,
						touchedPublicApi: state.metrics.touchedPublicApi || event.publicApi,
					},
				},
				[],
				event.at,
			);
		}

		case "RECORD_ROLE_COST": {
			const tk = event.tokens;
			const hasTokens = !!tk && tk.input + tk.output + tk.cacheRead + tk.cacheWrite > 0;
			if (!Number.isFinite(event.amount) || event.amount < 0 || (event.amount === 0 && !hasTokens)) {
				return reject(state, "RECORD_ROLE_COST 需要正数 amount,或携带非零 token 用量");
			}
			const prevTk = state.tokens?.[event.role];
			return ok(
				{
					...state,
					cost:
						event.amount > 0
							? { ...state.cost, [event.role]: (state.cost[event.role] ?? 0) + event.amount }
							: state.cost,
					tokens: hasTokens
						? {
								...state.tokens,
								[event.role]: {
									input: (prevTk?.input ?? 0) + tk!.input,
									output: (prevTk?.output ?? 0) + tk!.output,
									cacheRead: (prevTk?.cacheRead ?? 0) + tk!.cacheRead,
									cacheWrite: (prevTk?.cacheWrite ?? 0) + tk!.cacheWrite,
								},
							}
						: state.tokens,
				},
				[],
				event.at,
			);
		}

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

		// ─────────────── DEFINE:问一轮 / 定义完成 ───────────────
		case "DEFINE_ASKED": {
			if (state.phase !== "define") return reject(state, "DEFINE_ASKED 只能在 define 相位");
			const round = state.defineAsks + 1;
			// 记下本轮的结账快照:下一轮要靠它判断"上一轮问答有没有推进决策"
			return ok(
				{ ...state, defineAsks: round, defineSettled: [...event.settled] },
				[log(`DEFINE 第 ${round} 轮提问(已落定 ${event.settled.length} 条决策),等待人工回答`)],
				event.at,
			);
		}

		case "DEFINE_ANSWERED": {
			if (state.phase !== "define") return reject(state, "DEFINE_ANSWERED 只能在 define 相位");
			if (state.defineAsks === 0) return reject(state, "还没有问过任何一轮,答案无处对账");
			if (event.answers.length === 0) return reject(state, "答案为空:问答页要么收到答案,要么中断,不存在空答案");
			// 记录按轮累积:mission_define.resolved 的上游,换脑后照这里抄
			return ok(
				{ ...state, defineAnswers: [...state.defineAnswers, ...event.answers] },
				[log(`DEFINE 第 ${state.defineAsks} 轮收到 ${event.answers.length} 条回答`)],
				event.at,
			);
		}

		case "DEFINE_DONE": {
			if (state.phase !== "define") return reject(state, "DEFINE_DONE 只能在 define 相位");
			if (state.pendingHandoff) return reject(state, "换脑挂起中,请先 /mission next");
			return ok(
				{ ...state, phase: "plan" as const },
				[...enter("plan"), log("DEFINE done, 问题定义已确定 → PLAN")],
				event.at,
			);
		}

		case "RECOVER_INTERRUPTED_CHECK": {
			if (state.phase !== event.from) {
				return reject(state, `RECOVER_INTERRUPTED_CHECK 与当前相位 ${state.phase} 不匹配`);
			}
			return ok(
				{ ...state, phase: "do" as const },
				[...enter("do"), log(`RECOVER interrupted ${event.from} → DO`)],
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

			const spikes = new Set(event.spikes ?? []);
			let tasks: Record<string, TaskState> = {};
			for (const id of order) {
				const prev = state.tasks[id];
				tasks[id] = {
					...(prev ?? {
						id,
						status: "pending" as const,
						attempts: 0,
						sameSignatureCount: 0,
						inconclusiveStreak: 0,
						submittedTreeFp: null,
						awaitingEvidence: null,
					}),
					awaitingEvidence: null,
					// kind 随每次计划重写更新:同一个 id 可以从 spike 变成 impl
					kind: spikes.has(id) ? ("spike" as const) : ("impl" as const),
				};
			}
			tasks = setTask(tasks, first, (t) => ({
				...t,
				status: t.status === "done" ? t.status : ("running" as const),
				attempts: t.status === "done" ? t.attempts : Math.max(1, t.attempts),
			}));

			const sessionMap = { ...state.sessionMap };
			if (event.sessionFile) sessionMap[first] = event.sessionFile;
			return ok(
				{
					...state,
					phase: "do" as const,
					currentTask: first,
					taskOrder: order,
					tasks,
					baseCommit: event.baseCommit ?? state.baseCommit,
					sessionMap,
				},
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
			const task = state.tasks[state.currentTask];
			if (
				task?.awaitingEvidence &&
				event.treeFp !== undefined &&
				event.treeFp !== null &&
				task.awaitingEvidence.treeFp !== null &&
				task.awaitingEvidence.treeFp !== undefined &&
				event.treeFp === task.awaitingEvidence.treeFp
			) {
				const reason = task.awaitingEvidence.reason || "缺少验收证据";
				return reject(
					state,
					`上一轮判定因「${reason}」无法判定，当前工作区未检测到任何改动（树指纹相同）。请先补充对应机械证据或修改实现，若判定标准/计划有误请调用 mission_escalate 升级。`,
				);
			}
			const tasks = setTask(state.tasks, state.currentTask, (t) => ({
				...t,
				submittedTreeFp: event.treeFp !== undefined ? event.treeFp : (t.submittedTreeFp ?? null),
				awaitingEvidence: null,
			}));
			return ok(
				{ ...state, phase: "check" as const, tasks },
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
				const cause = verdict.inconclusiveCause;
				const isEvidence = cause === "evidence";
				const awaitingEvidence = isEvidence
					? {
							reason: verdict.reason,
							acIds: verdict.missingAcIds ?? verdict.failing.map((e) => e.acId),
							treeFp: task?.submittedTreeFp ?? null,
						}
					: null;
				// 裁判本身坏了(核验模型报错、人工终审弹不出来):回 DO 是纯浪费 ——
				// 执行者改什么都换不来一个能用的裁判,下一轮还是同一个错。首轮即停机。
				const halt = cause === "judge" || streak >= INCONCLUSIVE_STREAK_CAP;
				const haltMessage =
					cause === "judge"
						? `${verdict.reason},停机等待修复核验裁判(检查 missions/models.json 的 verifier 配置)`
						: `连续 ${streak} 次无法判定(${verdict.reason}),${HALT_HINT[cause ?? "evidence"]}`;
				if (halt) {
					return ok(
						{
							...state,
							phase: "halted" as const,
							tasks: setTask(state.tasks, taskId, (t) => ({
								...t,
								inconclusiveStreak: streak,
								lastInconclusiveCause: cause,
								awaitingEvidence,
							})),
						},
						[
							log(
								`${taskId} a=${attempt} verdict=INCONCLUSIVE×${streak} cause=${cause ?? "evidence"} why=${compact(verdict.reason)} → HALTED`,
							),
							{ type: "RESTORE" },
							{ type: "NOTIFY", level: "error", message: haltMessage },
						],
						event.at,
					);
				}
				return ok(
					{
						...state,
						phase: "do" as const,
						tasks: setTask(state.tasks, taskId, (t) => ({
							...t,
							inconclusiveStreak: streak,
							lastInconclusiveCause: cause,
							awaitingEvidence,
						})),
					},
					[
						...enter("do"),
						log(
							`${taskId} a=${attempt} verdict=INCONCLUSIVE cause=${cause ?? "evidence"} why=${compact(verdict.reason)}`,
						),
						{
							type: "NOTIFY",
							level: "warning",
							message: `无法判定(不计入熔断,${streak}/${INCONCLUSIVE_STREAK_CAP}):${verdict.reason}`,
						},
					],
					event.at,
				);
			}

			// 探针任务:成败都回 PLAN 带着结论重新规划。
			// 不进 ACT(时间盒:一次 attempt),不进熔断(探针失败本身就是一条结论),
			// 也不推进到下一任务 —— 它后面的任务是基于未知写的,本来就该重写。
			if (task?.kind === "spike") {
				return spikeTransition(state, event.at, taskId, verdict);
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
				awaitingEvidence: null,
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
			// quick 没有可升的级。L2 回 PLAN,而 quick 在 PLAN 只有 mission_criterion ——
			// 于是"升级方案"实际执行成了**重写判据**,由刚刚被这条判据判失败的执行者来写。
			// (freezeQuickCriterion 的守卫是 phase !== "plan",升级之后正好放行。)
			// 闸门已经不发这个工具,这里是最后一道:闸门是粗粒度的,状态机才是裁判。
			// quick 的正确出口是自动升档,不需要任何人调用工具。
			if (state.tier === "quick") {
				return reject(
					state,
					"quick 档不能手动升级:它没有可改的方案,回 PLAN 只能重写判据,而那是提交后修改判定标准。" +
						"这一档失败一次就会自动升档 standard(回 PLAN 把判据摊开成冻结 AC + verify.sh),不需要你做任何事。",
				);
			}
			const taskId = state.currentTask;
			if (!taskId) return reject(state, "无当前任务");
			if (event.to <= state.escalation.level) {
				return reject(state, `不能从 L${state.escalation.level} 降级到 L${event.to}`);
			}
			return escalateTransition(state, event.at, taskId, event.to, event.reason);
		}

		// ─────────────── PLAN:人工打回 ───────────────
		case "PLAN_REJECTED": {
			if (state.phase !== "plan") return reject(state, "PLAN_REJECTED 只能在 plan 相位");
			const comment = event.comment.trim();
			const rejections = state.planReview.rejections + 1;
			const notes = [...state.planReview.notes, comment].slice(-PLAN_REJECT_CAP);
			const planReview = { rejections, notes };
			const verdict = evaluatePlanReview({ rejections });

			if (verdict.ok) {
				return ok(
					{ ...state, planReview },
					[log(`PLAN rejected ×${rejections}(还剩 ${verdict.remaining} 次):${compact(comment)}`)],
					event.at,
				);
			}

			// 上限到了:不再让 planner 重交,直接走 L3 的落点(与 ESCALATION_CONFIRMED 同形)。
			// 换脑是强制的 —— 重新定义问题不能在已经被三版废方案污染的上下文里做。
			return ok(
				{
					...state,
					phase: "define" as const,
					planReview,
					defineAsks: 0,
					defineSettled: [],
					defineAnswers: [],
					escalation: {
						level: 3,
						history: [
							...state.escalation.history,
							{
								at: event.at,
								taskId: state.currentTask ?? "",
								from: state.escalation.level,
								to: 3 as const,
								reason: `计划连续被打回 ${rejections} 次:${compact(comment)}`,
							},
						],
					},
					pendingHandoff: "plan rejected ×" + rejections,
				},
				[
					log(`PLAN rejected ×${rejections} → L3, rewriting mission definition → DEFINE`),
					{ type: "ARCHIVE_PLAN", reason: `plan rejected ×${rejections}` },
					{ type: "HANDOFF", reason: "plan rejected" },
					{ type: "NOTIFY", level: "warning" as const, message: verdict.reason },
					...enter("define"),
				],
				event.at,
			);
		}

		case "ESCALATION_CONFIRMED": {
			if (state.escalation.level !== 3) return reject(state, "当前无待确认的 L3 升级");
			const taskId = state.currentTask;
			const tasks = taskId ? setTask(state.tasks, taskId, resetAfterEscalation) : state.tasks;
			// L3 = 改问题定义,落点是 DEFINE 而不是 PLAN:AC 本身错了,
			// 直接重新分解方案只会在同一个错误的问题上换个姿势。
			// 提问预算一并重置 —— 新的问题定义值得再问一轮。
			return ok(
				{
					...state,
					phase: "define" as const,
					tasks,
					defineAsks: 0,
					defineSettled: [],
					defineAnswers: [],
					pendingHandoff: "escalate L3",
				},
				[
					log("L3 confirmed, rewriting mission definition → DEFINE"),
					{ type: "ARCHIVE_PLAN", reason: "L3 escalation" },
					{ type: "HANDOFF", reason: "escalate L3" },
					...enter("define"),
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

		case "HANDOFF_CANCELLED": {
			if (!state.pendingHandoff) return reject(state, "当前无挂起的换脑请求");
			return ok(
				{ ...state, pendingHandoff: null },
				[
					log(`HANDOFF cancelled: ${compact(event.reason)}`),
					{ type: "NOTIFY", level: "warning", message: `换脑已取消:${event.reason}` },
				],
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
			// 从 quick 升档要和熔断那条路落在同一个地方 —— 理由见 promoteFromQuick
			if (state.tier === "quick") {
				const taskId = state.currentTask;
				return promoteFromQuick({
					state,
					at: event.at,
					to: event.to,
					reason: event.reason,
					taskId,
					tasks: taskId ? setTask(state.tasks, taskId, resetAfterEscalation) : state.tasks,
				});
			}
			return ok({ ...state, tier: event.to }, [
				log(`TIER ${state.tier} → ${event.to} why=${compact(event.reason)}`),
				{ type: "NOTIFY", level: "warning", message: `已自动升档 ${state.tier} → ${event.to}:${event.reason}` },
			], event.at);
		}

		default: {
			const never: never = event;
			return reject(state, `未知事件 ${JSON.stringify(never)}`);
		}
	}
}

// ─────────────────────────── 失败处理(breaker 并入点) ───────────────────────────

/**
 * 探针任务的收尾:不论 pass/fail 都回 PLAN。
 *
 * 换脑是必须的 —— 探针的上下文里全是调研噪音,拿它去重新规划正是 I5 要避免的事。
 * 归档旧计划保留审计链:这份计划是基于未知写的,它被结论取代了。
 */
function spikeTransition(state: MissionState, at: number, taskId: string, verdict: Verdict): TransitionResult {
	const passed = verdict.outcome === "pass";
	const tasks = setTask(state.tasks, taskId, (t) => ({
		...t,
		status: passed ? ("done" as const) : ("blocked" as const),
		inconclusiveStreak: 0,
		lastFailureReason: passed ? undefined : failureReason(verdict.reason),
		awaitingEvidence: null,
	}));
	const reason = `spike ${taskId} ${passed ? "结论已产出" : "未产出结论"}`;
	return ok(
		{
			...state,
			phase: "plan" as const,
			currentTask: null,
			tasks,
			spikesRun: state.spikesRun + 1,
			pendingHandoff: reason,
		},
		[
			log(`${taskId} verdict=${passed ? "PASS" : "FAIL"} (spike) → 回 PLAN 重新规划 why=${compact(verdict.reason)}`),
			{ type: "ARCHIVE_PLAN", reason },
			{ type: "HANDOFF", reason },
			...enter("plan"),
			{
				type: "NOTIFY",
				level: passed ? "info" : "warning",
				message: passed
					? `探针 ${taskId} 已出结论,回到 PLAN 重新规划`
					: `探针 ${taskId} 没跑出结论(${verdict.reason}),仍回到 PLAN —— 探针只打一次`,
			},
		],
		at,
	);
}

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
	const counted = applyFailure({ ...base, inconclusiveStreak: 0, awaitingEvidence: null }, sig);
	counted.lastFailureReason = failureReason(verdict.reason);

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

	// quick 撞阈值:升档而不是 L2。落盘必须排在一切 LOG 之前 ——
	// PERSIST_PLAN 会把 inMemory 翻成 false,在那之前写的 LOG 全部会被丢掉
	// (runtime 的 LOG effect 对 inMemory 是空操作),而这几行正是换脑之后
	// 新会话唯一能读到的失败历史。
	if (action.action === "promote") {
		return promoteFromQuick({
			state,
			at,
			to: action.to,
			reason: action.reason,
			taskId,
			tasks: setTask(state.tasks, taskId, () => resetAfterEscalation(counted)),
			leadingLog: `${header} act=PROMOTE ${state.tier}→${action.to} why=${compact(action.reason)}`,
		});
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

/**
 * 从 quick 升档:回 PLAN + 挂换脑 + 先落盘。
 *
 * 两个入口共用 —— 熔断(failTransition 的 promote 分支)与机械升档(PROMOTE_TIER)。
 * 曾经各写各的,结果 PROMOTE_TIER 那份只改 tier、不改相位,留下一个
 * tier=standard / phase=do / 没有任何 AC 的 mission。而 runCheck 按
 * `state.tier === "quick"` 分流:档位一变它就不再看那条冻结判据,转去跑空的
 * verify.sh,采不到证据判 inconclusive,回 DO 再来一遍,三次之后停机 ——
 * 人工终审的那条判据从此再没被问过。实测 quick 只要失败一次就必然走进这条路。
 *
 * quick 必须回 PLAN 的理由是结构性的:**它根本没有计划**(acceptanceCriteria 空、
 * verifyScript 空串)。升档的全部意义就是把那一条判据摊开成冻结 AC + verify.sh,
 * 而那只能在 PLAN 相位做。
 */
function promoteFromQuick(input: {
	state: MissionState;
	at: number;
	to: Tier;
	reason: string;
	taskId: string | null;
	/** 已经做过 resetAfterEscalation 的任务表 */
	tasks: MissionState["tasks"];
	/** 熔断入口要在前面补一行 verdict 摘要 */
	leadingLog?: string;
}): TransitionResult {
	const { state, at, to, reason, taskId, tasks } = input;
	const why = `promote ${state.tier}→${to}${taskId ? ` on ${taskId}` : ""}`;
	const lastFailure = taskId ? (tasks[taskId]?.lastFailureReason ?? null) : null;
	return ok(
		{ ...state, tier: to, phase: "plan" as const, tasks, pendingHandoff: why },
		[
			// PERSIST_PLAN 必须排在一切 LOG 之前:换脑靠磁盘重附着,
			// 目录还没建出来的时候写 LOG 等于把失败原因扔了。
			{ type: "PERSIST_PLAN" },
			...(input.leadingLog ? [log(input.leadingLog)] : []),
			log(`TIER ${state.tier} → ${to} why=${compact(reason)}`),
			log(`升档前的失败原因:${compact(lastFailure ?? "-")}`),
			{ type: "HANDOFF", reason: why },
			...enter("plan"),
			{ type: "NOTIFY", level: "warning", message: `已自动升档 ${state.tier} → ${to}:${reason}` },
		],
		at,
	);
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
		submittedTreeFp: null,
		awaitingEvidence: null,
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
 * 失败原因的截断 —— 比 LOG 的 compact 更宽。
 *
 * lastFailureReason 是 semi/human 失败信息进入模型上下文的唯一通道
 * (verdict 卡片只给 TUI 看)。semi/human 证据不可重放:executor 在 DO 相位
 * 有 bash 可以重跑 hard 证据,但 escalator 在 ACT 相位只有只读工具,
 * 这段文字是它对失败原因的全部认知。120 字符放不下两条 AC 的理由,
 * 截断等于扔掉不可重放的诊断信息。
 */
function failureReason(s: string): string {
	return s.replace(/\s+/g, " ").trim().slice(0, 500);
}

/**
 * mission 的起始相位。
 * quick 档没有 AC 也没有 PLAN(判定依据是 --verify 冻结的命令),建好立刻冻结进 DO;
 * standard/complex 先过 DEFINE —— 需求模糊时写不出 AC,这是 I2 的入口条件。
 */
export const START_PHASE: Record<Tier, Phase> = {
	quick: "plan",
	standard: "define",
	complex: "define",
};

/** 便于 hooks 层与测试构造初始状态 */
export function initialState(params: {
	missionId: string;
	tier: Tier;
	taskOrder: string[];
}): MissionState {
	const tasks: Record<string, TaskState> = {};
	for (const id of params.taskOrder) {
		tasks[id] = {
			id,
			status: "pending",
			attempts: 0,
			sameSignatureCount: 0,
			inconclusiveStreak: 0,
			submittedTreeFp: null,
			awaitingEvidence: null,
		};
	}
	return {
		missionId: params.missionId,
		tier: params.tier,
		phase: START_PHASE[params.tier],
		currentTask: null,
		taskOrder: params.taskOrder,
		tasks,
		escalation: { level: 1, history: [] },
		baseCommit: null,
		pendingHandoff: null,
		sessionMap: {},
		defineAsks: 0,
		defineSettled: [],
		defineAnswers: [],
		planReview: { rejections: 0, notes: [] },
		spikesRun: 0,
		cost: {},
		metrics: { touchedFiles: [], touchedPublicApi: false },
		updatedAt: 0,
	};
}

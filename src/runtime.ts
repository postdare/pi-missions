/**
 * pi-missions · runtime
 *
 * core(裁判)与 pi(执行面)之间的哑管道:
 *   采集证据 → judge → 发事件给 machine → 把产出的 Effect 翻译成 pi API 调用。
 * 不做任何判定 —— 所有"对不对/升不升/停不停"的决定都在 core 里。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { Effect, MissionEvent, MissionState, Phase, Role, Tier, TransitionResult } from "./core/types.ts";
import { initialState, transition, ROLE_OF } from "./core/machine.ts";
import { evaluateCriterion } from "./core/criterion.ts";
import { evaluatePromotion } from "./core/tier.ts";
import { evaluateBaseline, shouldProbeBaseline, type BaselineProbe } from "./core/baseline.ts";
import { evaluateAsk, needsScopeConfirm, normalizeAskAnswers, roundCapFor, type AskQuestion } from "./core/define.ts";
import { evaluateScout, type ScoutQuestion } from "./core/scout.ts";
import { evaluateCoverage } from "./core/coverage.ts";
import { openPlanReview } from "./ui/plan-review.ts";
import { openDefineReview } from "./ui/define-review.ts";
import { openAskReview } from "./ui/ask-review.ts";
import { validateSpikePlan } from "./core/spike.ts";
import type { DoneWhen, Definition, MissionPlan } from "./store/mission.ts";
import {
	findTask,
	spikeTaskIds,
	taskOrder,
	validatePlan,
} from "./store/mission.ts";
import { loadConfig, matchGlob, type MissionsConfig } from "./store/config.ts";
import { layout, modelsJson, spikeReport, statePaths, type RepoLayout } from "./store/paths.ts";
import { ensureScaffold } from "./store/scaffold.ts";
import { appendLog } from "./store/log.ts";
import { computeGitTreeFingerprint, ensureInfoExclude, isGitRepo } from "./store/git.ts";
import { loadCheckState, removeCheckState, type CheckState } from "./store/check.ts";
import { renderWidgetCard } from "./ui/dashboard.ts";
import {
	renderStateCard,
	renderDoBrief,
	renderActBrief,
	renderHandoffBrief,
	renderScoutEnvelope,
	renderScoutProgress,
} from "./briefs.ts";
import { CheckRunner } from "./check-runner.ts";
import {
	applyRole,
	DEFAULT_THINKING,
	loadModelsConfig,
	saveModelsConfig,
	profileFromJson,
	profileToJson,
	restoreProfile,
	saveProfile,
	type ModelsConfig,
	type RoleModelConfig,
	type SavedProfile,
} from "./roles/models.ts";
import { type VerifierControl } from "./roles/verifier.ts";
import { runScouts } from "./roles/scout.ts";
import { BUILTIN_ALL, gateCheck, MISSION_TOOLS, toolsForPhase } from "./hooks/gate.ts";
import { IncrementalDiagnostics } from "./hooks/diagnostics.ts";
import {
	MissionRepository,
	type HandoffRecord,
	type MissionSnapshotV2,
	type StagedPlan,
} from "./store/repository.ts";

/**
 * quick 档的判定依据。必须先于执行冻结(I2/I3),但**不必是一条命令**:
 * I3 要的是判定权在执行者之外,而独立 verifier 和人都在执行者之外。
 *
 *   ai      独立 Verifier AgentSession 核对这句判据。**默认档** ——
 *           它保住了 quick 最值钱的东西:DO→CHECK→ACT 能无人值守地自转几轮。
 *   human   人工终审。不可重放(mission 结束后没留下能重跑的东西),
 *           换来的是真机/视觉这类模型判不了的场景。
 *   command 机械命令。零成本、可重放,顺带当回归护栏 —— 但它只能覆盖
 *           "写得出 shell 断言"的那部分任务,所以不再是准入门槛。
 */
export type QuickCriterion =
	| { judge: "ai"; text: string }
	| { judge: "human"; text: string }
	| { judge: "command"; text: string; command: string };

export interface ActiveMission {
	plan: MissionPlan;
	state: MissionState;
	/** quick 档升 standard 前:计划与状态只在内存(Q18) */
	inMemory: boolean;
	/** 目标目录是 git 仓库(降级模式=false 时 AC 冻结有 git 审计链) */
	git: boolean;
	/** quick 档判定的唯一依据。必须在进 DO 前定下,不接受事后补(见 QuickCriterion) */
	quickCriterion?: QuickCriterion;
	/** v2 snapshot 的 CAS revision；quick 内存任务固定为 0 */
	revision: number;
	/** 当前不可变 generation；quick 内存任务固定为 0 */
	generation: number;
	/** 待验证的换脑握手；必须与 state.pendingHandoff 同进同出 */
	handoff: HandoffRecord | null;
}

/** 换脑后给新会话的第一句推动语。按落点相位分流 —— 换脑不只发生在 DO */
const HANDOFF_NUDGE: Record<string, string> = {
	define: "开始重新定义问题",
	plan: "开始重新规划",
	do: "开始执行当前任务",
	act: "开始分析上一轮失败",
	check: "等待系统判定",
};

/** 基线探针的单分支超时。与 CHECK 同量级:基线本来就该快速失败 */
const BASELINE_TIMEOUT_MS = 600_000;

export class Runtime {
	active: ActiveMission | null = null;
	/** 面板/命令选定的待用档位;下一次 /mission new 消费掉 */
	pendingTier: Tier | null = null;
	private savedProfile: SavedProfile | null = null;
	private diagnostics: IncrementalDiagnostics | null = null;
	private suppressHandoffFollowUp = false;
	// internal:以下两个成员开放给 CheckRunner(src/check-runner.ts)读写,
	// 其余代码不应触碰。开放原因是 CHECK 编排要跨 await 读写进度与控制句柄。
	liveCheckState: CheckState | null = null;
	activeVerifierControl: VerifierControl | null = null;
	private checkPromises = new WeakMap<ActiveMission, Promise<void>>();
	private stagedPlan: StagedPlan | null = null;

	// internal:pi/cwd 是 Runtime 的注入面,CheckRunner 经此调用 exec/notify
	readonly pi: any;
	readonly cwd: string;
	private readonly checkRunner: CheckRunner;

	constructor(pi: any, cwd: string) {
		this.pi = pi;
		this.cwd = cwd;
		this.checkRunner = new CheckRunner(this);
	}

	get config(): MissionsConfig {
		return loadConfig(this.cwd);
	}

	get layout(): RepoLayout {
		return layout(this.cwd, this.config.missionsDir);
	}

	get repository(): MissionRepository {
		return new MissionRepository(this.layout);
	}

	get exec() {
		return (cmd: string, args: string[], opts?: { cwd?: string; timeout?: number; signal?: AbortSignal }) =>
			this.pi.exec(cmd, args, { cwd: this.cwd, ...opts });
	}

	// ─────────────────────────── 生命周期 ───────────────────────────

	/** /mission new:scaffold + 初始状态 + 进入 plan 相位 */
	async startNew(
		ctx: any,
		goal: string,
		tier: "standard" | "complex",
	): Promise<{ id: string; phase: Phase } | { error: string }> {
		if (this.busy()) return { error: "已有进行中的 mission,先 /mission abort 或 /mission resume" };
		const l = this.layout;
		ensureScaffold(l);
		const git = await isGitRepo(this.exec, this.cwd);
		if (git) this.ensureStateExcludes();

		goal = sanitizeGoal(goal);
		const id = `${new Date().toISOString().slice(0, 10)}-${slugify(goal)}`;
		const plan: MissionPlan = {
			missionId: id,
			tier,
			goal,
			acceptanceCriteria: [],
			milestones: [],
			verifyScript: "",
			createdAt: Date.now(),
		};
		const snapshot = this.repository.create(plan, initialState({ missionId: id, tier, taskOrder: [] }));
		this.active = {
			plan: snapshot.plan,
			state: snapshot.state,
			inMemory: false,
			git,
			revision: snapshot.revision,
			generation: snapshot.artifacts.generation,
			handoff: snapshot.handoff,
		};
		this.liveCheckState = null;
		removeCheckState(statePaths(l, id).checkJson);
		this.savedProfile = saveProfile(this.pi, ctx);
		this.persistProfile();
		const phase = this.active.state.phase; // standard/complex 起于 DEFINE(见 core/machine START_PHASE)
		this.pi.setActiveTools(toolsForPhase(phase, tier));
		const role = ROLE_OF[phase];
		if (role) await applyRole(this.pi, ctx, role, this.modelsConfig(), (m) => this.warn(ctx, m));
		this.refreshWidget(ctx);
		return { id, phase };
	}

	/**
	 * /mission quick:单任务,不落盘,起于 PLAN 相位(START_PHASE.quick)。
	 *
	 * **不问人**。开工前多一次交互,小任务就不值得开 mission 了 —— 判据由 AI
	 * 在 PLAN 相位看过代码之后自己定,过 core/criterion.ts 的闸门后才冻结进 DO。
	 * 那个相位只有只读工具(见 toolsForPhase),所以"判据先于写代码"是物理保证的。
	 *
	 * criterion 非空 = 调用方已经给了判据(--verify 加速路径),直接冻结跳过这一步。
	 */
	/**
	 * 返回类型里的 `tier: "quick"` 是字面量而不是 `Tier`,这是有意的:
	 * 旧版没给 --verify 会当场升档 standard,调用方因此得按落点分流。现在不会了 ——
	 * 没判据只是停在 PLAN 相位等 mission_criterion。用字面量钉住,免得那个分支再长回来。
	 */
	async startQuick(
		ctx: any,
		task: string,
		criterion?: QuickCriterion | null,
	): Promise<{ id: string; tier: "quick" } | { error: string }> {
		if (this.busy()) return { error: "已有进行中的 mission,先 /mission abort" };

		task = sanitizeGoal(task);
		const id = `quick-${Date.now().toString(36)}`;
		const plan: MissionPlan = {
			missionId: id,
			tier: "quick",
			goal: task,
			acceptanceCriteria: [],
			milestones: [{ id: "M1", title: task, tasks: [{ id: "T1", title: task, verify: [] }] }],
			verifyScript: "",
			createdAt: Date.now(),
		};
		this.active = {
			plan,
			state: initialState({ missionId: id, tier: "quick", taskOrder: ["T1"] }),
			inMemory: true,
			git: await isGitRepo(this.exec, this.cwd),
			quickCriterion: criterion ?? undefined,
			revision: 0,
			generation: 0,
			handoff: null,
		};
		this.liveCheckState = null;
		this.savedProfile = saveProfile(this.pi, ctx);

		// 已有判据(--verify):直接冻结进 DO。没有:停在 PLAN,只读工具 + mission_criterion,
		// 等 AI 看过代码再交一条 —— 这一步不打断人。
		if (!criterion) {
			this.pi.setActiveTools(toolsForPhase("plan", "quick"));
			await applyRole(this.pi, ctx, "planner", this.modelsConfig(), (m) => this.warn(ctx, m));
			this.refreshWidget(ctx);
			return { id, tier: "quick" };
		}
		const r = await this.applyEvent({ type: "PLAN_FROZEN", at: Date.now(), taskOrder: ["T1"] }, ctx);
		if (r.error) return { error: r.error };
		return { id, tier: "quick" };
	}

	/**
	 * quick 的判据冻结。AI 在 PLAN 相位调 mission_criterion 落到这里:
	 * 过 L0 闸门 → 写进 active → PLAN_FROZEN 进 DO(工具集随之解锁写工具)。
	 *
	 * 判据不合格不抛异常,把理由退回去让它重写 —— 与 mission_ask 拒绝懒问题同形。
	 */
	async freezeQuickCriterion(
		ctx: any,
		criterion: QuickCriterion,
	): Promise<{ ok: true } | { error: string }> {
		const a = this.active;
		if (!a) return { error: "无活动 mission" };
		if (a.state.tier !== "quick") return { error: "mission_criterion 只用于 quick 档" };
		if (a.state.phase !== "plan") return { error: `当前相位是 ${a.state.phase},判据已经冻结过了` };

		const verdict = evaluateCriterion({ goal: a.plan.goal, text: criterion.text });
		if (!verdict.ok) return { error: verdict.reason };

		a.quickCriterion = { ...criterion, text: verdict.text };
		const r = await this.applyEvent({ type: "PLAN_FROZEN", at: Date.now(), taskOrder: ["T1"] }, ctx);
		if (r.error) return { error: r.error };
		return { ok: true };
	}

	/** /mission resume:从仓库重附着到当前会话(Q15) */
	async resume(ctx: any, missionId: string): Promise<{ ok: true } | { error: string }> {
		if (this.busy()) return { error: "已有进行中的 mission,先 /mission abort" };
		const r = await this.attach(ctx, missionId, { clearPendingHandoff: true });
		if ("error" in r) return r;
		if (this.active!.state.phase === "done") return { error: "该 mission 已完成" };
		return { ok: true };
	}

	/**
	 * 磁盘重附着(I1 的兑现)。
	 * pi 在 newSession/reload/重启时会重建扩展实例,内存态必然丢失 ——
	 * 会话即上下文,状态即进度:进度从仓库恢复,上下文靠换脑重建。
	 */
	private async attach(
		ctx: any,
		missionId: string,
		opts: { clearPendingHandoff: boolean },
	): Promise<{ ok: true } | { error: string }> {
		const loaded = this.repository.activate(missionId);
		if (!loaded.ok) return { error: loaded.error };
		const snapshot = loaded.snapshot;
		ensureScaffold(this.layout);
		this.active = this.activeFromSnapshot(snapshot, await isGitRepo(this.exec, this.cwd));
		this.liveCheckState = null;
		// 用户现场(thinking/模型)随 mission 持久化;已有则以磁盘为准(跨会话接力)
		this.savedProfile = this.loadProfile() ?? saveProfile(this.pi, ctx);
		this.persistProfile();
		if (snapshot.state.phase === "check" || snapshot.state.phase === "act") {
			removeCheckState(statePaths(this.layout, missionId).checkJson);
			const recovered = await this.applyEvent(
				{
					type: "RECOVER_INTERRUPTED_CHECK",
					at: Date.now(),
					from: snapshot.state.phase,
				},
				ctx,
			);
			if (recovered.error) return { error: recovered.error };
		}
		if (opts.clearPendingHandoff && this.active.state.pendingHandoff) {
			removeCheckState(statePaths(this.layout, missionId).checkJson);
			const cancelled = await this.applyEvent(
				{ type: "HANDOFF_CANCELLED", at: Date.now(), reason: "人工恢复 mission" },
				ctx,
			);
			if (cancelled.error) return { error: cancelled.error };
		}
		this.pi.setActiveTools(this.toolsForActivePhase());
		const role = ROLE_OF[this.active.state.phase];
		if (role) await applyRole(this.pi, ctx, role, this.modelsConfig(), (m) => this.warn(ctx, m));
		this.refreshWidget(ctx);
		return { ok: true };
	}

	/** 驱动类命令入口:内存丢了就从磁盘悄悄接上(CURRENT 指针)。 */
	async ensureAttached(ctx: any): Promise<boolean> {
		if (this.active) return true;
		const current = this.repository.readCurrent();
		if (!current.ok) return false;
		const r = await this.attach(ctx, current.snapshot.missionId, { clearPendingHandoff: false });
		return "ok" in r;
	}

	/**
	 * 磁盘上有冻结计划、却没有运行态的 mission。
	 *
	 * 这是**换机器接力做了一半**的样子:generations/ 随 git 走过来了,
	 * SNAPSHOT.json 与 CURRENT 没有(它们不进版本控制,见 ensureStateExcludes)。
	 * 这个情形完全可判定,却曾经只表现为 ensureAttached 返回 false、命令回一句
	 * "无活动 mission" —— 对一个以"失败要机械且响亮"为纲的系统,这处失败太安静了:
	 * 人看到的是"这儿什么都没有",而实际是"东西在,只是进度没跟过来"。
	 */
	detachedMissions(): string[] {
		try {
			if (!fs.existsSync(this.layout.state)) return [];
			return fs
				.readdirSync(this.layout.state, { withFileTypes: true })
				.filter((e) => e.isDirectory())
				.map((e) => e.name)
				.filter((id) => {
					const sp = statePaths(this.layout, id);
					return !fs.existsSync(sp.snapshotJson) && fs.existsSync(sp.generationsDir);
				});
		} catch {
			return [];
		}
	}

	/** 上面那种情形的一句人话提示;没有就返回 null。命令层把它接在"无活动 mission"后面 */
	detachedHint(): string | null {
		const ids = this.detachedMissions();
		if (ids.length === 0) return null;
		const dir = this.config.missionsDir;
		return (
			`\n注意:磁盘上有 ${ids.length} 个 mission 只剩冻结计划、没有运行态(${ids.slice(0, 3).join("、")}` +
			`${ids.length > 3 ? " 等" : ""})。\n` +
			`SNAPSHOT.json 与 CURRENT 不进版本控制(状态机用 CAS revision 推进,没有合并语义),` +
			`所以 git clone/pull 带不过来进度。\n` +
			`要接着干,把原机器的 ${dir}/state/CURRENT 与 ${dir}/state/<id>/SNAPSHOT.json 带外拷过来` +
			`(rsync/scp,别 git add -f),再执行 /mission resume <id>。`
		);
	}

	/** session_start:只允许带正确 token 的 new session 消费换脑请求 */
	async onSessionStart(
		event: { reason?: string; previousSessionFile?: string },
		ctx: any,
	): Promise<void> {
		if (this.active && !this.active.state.pendingHandoff) {
			// 同进程会话切换:重挂闸门即可
			this.pi.setActiveTools(toolsForPhase(this.active.state.phase, this.active.state.tier));
			this.refreshWidget(ctx);
			return;
		}
		const current = this.repository.readCurrent();
		if (!current.ok) {
			if (current.code === "corrupt") ctx.ui.notify(`Mission 状态损坏:${current.error}`, "error");
			return;
		}
		const snapshot = current.snapshot;
		if (snapshot.state.phase === "done" || snapshot.state.phase === "halted") return;
		if (snapshot.state.pendingHandoff && snapshot.handoff) {
			if (event.reason !== "new") {
				ctx.ui.notify(
					`Mission "${snapshot.missionId}" 正在等待换脑，只能由 /mission next 创建的新会话接力。`,
					"warning",
				);
				return;
			}
			const marker = readHandoffMarker(ctx);
			const valid =
				marker?.missionId === snapshot.missionId &&
				marker.token === snapshot.handoff.token &&
				marker.revision === snapshot.handoff.requestedRevision &&
				marker.revision === snapshot.revision &&
				event.previousSessionFile === snapshot.handoff.parentSession;
			if (!valid) {
				ctx.ui.notify(`Mission "${snapshot.missionId}" 接力失败:handoff token、父会话或 revision 不匹配`, "error");
				return;
			}
			const r = await this.attach(ctx, snapshot.missionId, { clearPendingHandoff: false });
			if ("error" in r) {
				ctx.ui.notify(`Mission "${snapshot.missionId}" 接力失败:${r.error}`, "error");
				return;
			}
			const done = await this.applyEvent(
				{
					type: "HANDOFF_DONE",
					at: Date.now(),
					sessionFile: safeSessionFile(ctx),
					token: marker.token,
					revision: marker.revision,
				},
				ctx,
			);
			if (done.error) ctx.ui.notify(`Mission "${snapshot.missionId}" 接力失败:${done.error}`, "error");
			return;
		}
		// 进程重启且不在换脑途中:不自动接管,避免劫持不相干的会话
		ctx.ui.notify(
			`检测到未完成的 mission "${snapshot.missionId}"(${snapshot.state.phase}),/mission resume ${snapshot.missionId} 恢复`,
			"info",
		);
	}

	// ─────────────────────────── 事件应用与效果翻译 ───────────────────────────

	async applyEvent(ev: MissionEvent, ctx: any): Promise<TransitionResult> {
		if (!this.active) return { state: null as never, effects: [], error: "无活动 mission" };
		if (ev.type === "ABORT") void this.activeVerifierControl?.abort();
		if (ev.type === "SUBMIT" && ev.treeFp === undefined) {
			// 排掉自家状态件:指纹判的是产出变没变,不是工作区变没变(见 computeGitTreeFingerprint)
			const treeFp = this.active.git
				? await computeGitTreeFingerprint(this.exec, this.cwd, [`${this.config.missionsDir}/state`])
				: null;
			ev = { ...ev, treeFp };
		}
		const r = transition(this.active.state, ev);
		if (r.error) {
			if (!this.active.inMemory) {
				appendLog(statePaths(this.layout, this.active.state.missionId).logMd, `EVENT ${ev.type} rejected: ${r.error}`);
			}
			return r;
		}
		const previousState = this.active.state;
		const previousHandoff = this.active.handoff;
		const previousPlan = this.active.plan;
		this.active.state = r.state;
		if (!previousState.pendingHandoff && r.state.pendingHandoff) {
			this.active.handoff = {
				token: crypto.randomUUID(),
				parentSession: safeSessionFile(ctx),
				requestedRevision: this.active.revision + 1,
				reason: r.state.pendingHandoff,
			};
		} else if (ev.type === "HANDOFF_DONE" || ev.type === "HANDOFF_CANCELLED") {
			this.active.handoff = null;
		} else if (r.state.pendingHandoff && this.active.handoff) {
			// marker 必须绑定即将提交的 snapshot revision；挂起期间若仍有记账事件，
			// 旧 marker 会自然过期，重跑 /mission next 才能生成新的合法 marker。
			this.active.handoff = {
				...this.active.handoff,
				requestedRevision: this.active.revision + 1,
			};
		}
		if (ev.type === "ABORT") {
			this.liveCheckState = null;
			if (!this.active.inMemory) {
				removeCheckState(statePaths(this.layout, this.active.state.missionId).checkJson);
			}
		}
		const persistError = await this.persist();
		if (persistError) {
			this.active.state = previousState;
			this.active.handoff = previousHandoff;
			this.active.plan = previousPlan;
			return { state: previousState, effects: [], error: persistError };
		}
		await this.translateEffects(r.effects, ctx);
		this.refreshWidget(ctx);
		return r;
	}

	private async translateEffects(effects: Effect[], ctx: any): Promise<void> {
		for (const e of effects) {
			switch (e.type) {
				case "SET_TOOLS":
					this.pi.setActiveTools(toolsForPhase(e.phase, this.active?.state.tier));
					break;
				case "SET_ROLE":
					await applyRole(this.pi, ctx, e.role, this.modelsConfig(), (m) => this.warn(ctx, m));
					break;
				case "HANDOFF":
					ctx.ui.notify(`需要换脑(${e.reason}):正在自触发 /mission next;若未生效请手动执行`, "warning");
					if (!this.suppressHandoffFollowUp) {
						this.pi.sendUserMessage("/mission next", { deliverAs: "followUp", expandPromptTemplates: true });
					}
					break;
				case "LOG":
					if (!this.active!.inMemory) {
						appendLog(statePaths(this.layout, this.active!.state.missionId).logMd, e.line);
					}
					break;
				case "CONFIRM": {
					let confirmed = false;
					if (ctx.hasUI) {
						confirmed = await ctx.ui.confirm("pi-missions · L3 升级确认", e.question);
					} else {
						ctx.ui.notify("非交互环境无法确认 L3 升级,视为拒绝", "warning");
					}
					await this.applyEvent(
						{ type: confirmed ? "ESCALATION_CONFIRMED" : "ESCALATION_REJECTED", at: Date.now() },
						ctx,
					);
					break;
				}
				case "ADVANCE_TASK":
					this.ensureSpikeDir();
					break; // State Card 与 widget 已反映
				case "FREEZE_AC":
					await this.onFreezeAc(ctx);
					this.ensureSpikeDir();
					break;
				case "PERSIST_PLAN":
					await this.persistPlanFiles();
					break;
				case "ARCHIVE_PLAN":
					this.archivePlan(e.reason);
					break;
				case "RESTORE":
					// 必须排在 savedProfile 置空之前 —— 工具集是从它里面还原的
					this.pi.setActiveTools(this.toolsForActivePhase());
					await restoreProfile(this.pi, ctx, this.savedProfile);
					this.savedProfile = null;
					this.diagnostics?.dispose();
					this.diagnostics = null;
					break;
				case "NOTIFY":
					ctx.ui.notify(e.message, e.level);
					break;
			}
		}
	}

	private async onFreezeAc(ctx: any): Promise<void> {
		const a = this.active!;
		if (a.inMemory) return; // quick 档:无盘可落(Q18)
		if (a.git) {
			ctx.ui.notify(
				`AC 已冻结。建议提交:${this.config.missionsDir}/state/${a.state.missionId}/generations/${a.generation}/`,
				"info",
			);
		} else {
			ctx.ui.notify("非 git 仓库:AC 冻结仅靠 L0 闸门,无 git 审计链(降级模式)", "warning");
		}
		appendLog(statePaths(this.layout, a.state.missionId).logMd, `generation=${a.generation}`);
	}

	/** 探针任务开始前先把结论目录建好,免得执行者第一次写文件就撞在 ENOENT 上 */
	private ensureSpikeDir(): void {
		const s = this.currentSpikeReport();
		if (s) fs.mkdirSync(path.dirname(s.abs), { recursive: true });
	}

	private async persistPlanFiles(): Promise<void> {
		const a = this.active!;
		ensureScaffold(this.layout);
		// handoff 必须一起写:quick 升档时 pendingHandoff 与 record 同一次事件生成,
		// 而这里是它第一次落盘的机会。丢了就等于把换脑的钥匙锁在内存里(见 repository.create)。
		const snapshot = this.repository.create(a.plan, a.state, a.handoff);
		a.inMemory = false;
		this.applySnapshotMetadata(snapshot);
		if (a.git) this.ensureStateExcludes();
	}

	private archivePlan(reason: string): void {
		const a = this.active!;
		const sp = statePaths(this.layout, a.plan.missionId);
		const missionMd = sp.generationMissionMd(a.generation);
		if (!fs.existsSync(missionMd)) return;
		fs.mkdirSync(sp.archiveDir, { recursive: true });
		const dest = path.join(sp.archiveDir, `MISSION-${Date.now()}.md`);
		fs.copyFileSync(missionMd, dest);
		appendLog(sp.logMd, `plan archived → ${path.relative(this.cwd, dest)} (${reason})`);
	}

	// ─────────────────────────── CHECK:L0 亲自判定(Q9) ───────────────────────────

	/**
	 * 启动一次 CHECK,同一个 mission 附着实例只允许一个。
	 * slash command 用 void 调用即可立即归还输入权;agent_settled 可 await 同一个 Promise。
	 */
	startCheck(ctx: any): Promise<void> {
		const active = this.active;
		if (!active) return Promise.resolve();
		const current = this.checkPromises.get(active);
		if (current) return current;
		const guarded = this.runCheck(ctx)
			.catch((error: unknown) => {
				const message = error instanceof Error ? error.message : String(error);
				try {
					if (!active.inMemory) {
						appendLog(statePaths(this.layout, active.state.missionId).logMd, `CHECK BACKGROUND ERROR ${message}`);
					}
				} catch {
					/* 后台错误已尽力记录,不能再次抛出形成 unhandled rejection */
				}
				try {
					ctx.ui.notify(`CHECK 后台执行异常:${message}`, "error");
				} catch {
					/* UI 可能已随会话销毁 */
				}
			})
			.finally(() => {
				if (this.checkPromises.get(active) === guarded) this.checkPromises.delete(active);
			});
		this.checkPromises.set(active, guarded);
		return guarded;
	}

	async steerVerifier(ctx: any, message: string): Promise<{ ok: true } | { error: string }> {
		return this.checkRunner.steer(ctx, message);
	}

	/**
	 * CHECK 编排已提取到 src/check-runner.ts 的 CheckRunner。
	 * 保留本方法签名:startCheck 的并发守卫与冒烟测试的 rt.runCheck 挂钩都从这里进。
	 */
	async runCheck(ctx: any): Promise<void> {
		return this.checkRunner.run(ctx);
	}

	// ─────────────────────────── tick(agent_settled 内层循环) ───────────────────────────

	async onAgentSettled(ctx: any): Promise<void> {
		const a = this.active;
		if (!a) return;

		if (a.state.phase === "check") {
			await this.startCheck(ctx);
			return;
		}

		if (a.state.phase === "act") {
			// ACT = 一轮诊断对话,结束后自动回 DO(L1 改实现)
			const r = await this.applyEvent({ type: "ADJUST_DONE", at: Date.now() }, ctx);
			if (r.error || a.state.pendingHandoff) return;
			// 升档判定必须排在 DO 简报**之前**:ADJUST_DONE 刚把 attempts 加了 1,
			// "quick 第 2 次尝试就升档"正是此刻才成立,而升档会挂起换脑 ——
			// 先发一句"进入 DO,第 2 次尝试"再换脑,是在骗下一个会话。
			//
			// (这里原本直接 return,而 DO 相位的每一轮都以 mission_submit 结束、相位当场
			// 变 check,于是"phase=do 且 attempts>=2"的 settled 永远不会出现 ——
			// tier.ts 里为 quick 写的那条逃生梯从来没接上过。)
			if (await this.maybePromote(ctx)) return;
			this.pi.sendUserMessage(renderDoBrief(a.plan, a.state, this.currentSpikeReport()?.rel), { deliverAs: "followUp" });
			return;
		}

		const phase = a.state.phase;
		if (phase === "do" || phase === "plan" || phase === "define") {
			if (await this.maybePromote(ctx)) return;
			// 上下文水位守卫:压缩是有损的,换脑是无损的(状态在仓库里)
			if (!a.state.pendingHandoff) {
				const usage = ctx.getContextUsage();
				const watermark = this.config.contextWatermark ?? 0.5;
				if (usage?.percent != null && usage.percent / 100 > watermark) {
					await this.applyEvent({ type: "HANDOFF_REQUEST", at: Date.now(), reason: `context-watermark ${usage.percent}%` }, ctx);
				}
			}
		}
	}

	/** 机械升档(升档自动,降档手动)。返回 true 表示已升档 —— 调用方到此为止 */
	private async maybePromote(ctx: any): Promise<boolean> {
		const a = this.active!;
		const promo = evaluatePromotion({
			tier: a.state.tier,
			currentTask: a.state.currentTask ? (a.state.tasks[a.state.currentTask] ?? null) : null,
			touchedFiles: a.state.metrics.touchedFiles.length,
			touchedPublicApi: a.state.metrics.touchedPublicApi,
			escalations: a.state.escalation.history.length,
		});
		if (!promo) return false;
		await this.applyEvent({ type: "PROMOTE_TIER", at: Date.now(), to: promo.to, reason: promo.reason }, ctx);
		return true;
	}

	// ─────────────────────────── tool_result:指标 + 编辑级反馈 ───────────────────────────

	async onToolResult(
		event: { toolName: string; input: Record<string, unknown>; isError: boolean },
		ctx: any,
	): Promise<void> {
		const a = this.active;
		if (!a) return;
		if ((event.toolName === "edit" || event.toolName === "write") && !event.isError) {
			const p = String(event.input.path ?? "");
			if (p && !a.state.metrics.touchedFiles.includes(p)) {
				await this.applyEvent(
					{
						type: "RECORD_TOUCHED_FILE",
						at: Date.now(),
						path: p,
						publicApi: (this.config.publicApiGlobs ?? []).some((g) => matchGlob(p, g)),
					},
					ctx,
				);
			}
			if (a.state.phase === "do" && this.config.incrementalCheck) {
				if (!this.diagnostics) {
					this.diagnostics = new IncrementalDiagnostics(this.exec, this.cwd, this.config.incrementalCheck, (text) =>
						this.pi.sendMessage(
							{ customType: "missions-diagnostic", content: text, display: true },
							{ deliverAs: "steer" },
						),
					);
				}
				this.diagnostics.poke();
			}
		}
	}

	/** message_end:按角色分账(成本是调模型策略的唯一依据)。
	 * 美元与 token 分开记:自建网关常不报价(cost.total = 0),token 才是真实消耗。 */
	async onMessageEnd(message: any, ctx: any): Promise<void> {
		const a = this.active;
		if (!a || message?.role !== "assistant") return;
		const role = ROLE_OF[a.state.phase];
		if (!role) return;
		const u = message?.usage;
		const total = typeof u?.cost?.total === "number" ? u.cost.total : 0;
		const tk = {
			input: u?.input ?? 0,
			output: u?.output ?? 0,
			cacheRead: u?.cacheRead ?? 0,
			cacheWrite: u?.cacheWrite ?? 0,
		};
		if (tk.input + tk.output + tk.cacheRead + tk.cacheWrite > 0) {
			await this.applyEvent({ type: "RECORD_ROLE_COST", at: Date.now(), role, amount: total, tokens: tk }, ctx);
		} else if (total > 0) {
			await this.applyEvent({ type: "RECORD_ROLE_COST", at: Date.now(), role, amount: total }, ctx);
		}
	}

	// ─────────────────────────── 探针(spike) ───────────────────────────

	/** 当前任务是 spike 时返回它的结论文件路径;否则 null */
	currentSpikeReport(): { abs: string; rel: string } | null {
		const a = this.active;
		if (!a?.state.currentTask) return null;
		const task = findTask(a.plan, a.state.currentTask);
		if (task?.kind !== "spike") return null;
		const abs = spikeReport(this.layout, a.state.missionId, task.id);
		return { abs, rel: path.relative(this.cwd, abs).replace(/\\/g, "/") };
	}

	// ─────────────────────────── 闸门 ───────────────────────────

	gate(toolName: string, input: Record<string, unknown>): string | null {
		const a = this.active;
		if (!a) return null;
		return gateCheck({
			phase: a.state.phase,
			tier: a.state.tier,
			pendingHandoff: a.state.pendingHandoff,
			toolName,
			input,
			missionsDirName: this.config.missionsDir,
			spikeReportPath: this.currentSpikeReport()?.rel ?? null,
		});
	}

	// ─────────────────────────── 换脑(/mission next) ───────────────────────────

	async handoff(ctx: any): Promise<{ ok: true } | { error: string }> {
		const a = this.active;
		if (!a) return { error: "无活动 mission" };
		if (!a.state.pendingHandoff) {
			// 人工主动换脑:先落 pending(抑制自触发,避免命令套娃)
			this.suppressHandoffFollowUp = true;
			try {
				const requested = await this.applyEvent(
					{ type: "HANDOFF_REQUEST", at: Date.now(), reason: "人工主动换脑" },
					ctx,
				);
				if (requested.error) return { error: requested.error };
			} finally {
				this.suppressHandoffFollowUp = false;
			}
		}
		// record 丢了不是死路:token 只用于新会话落地时的一次握手校验,
		// 它不需要跨会话保持不变,重新签一张即可。丢失的正常途径就有好几条 ——
		// pi 重启/reload 重建扩展实例、旧版本写下的 handoff=null 快照。
		// 在这里报"状态损坏"等于把人钉死在一个只能 abort 的 mission 上(真实事故)。
		if (!a.handoff) {
			a.handoff = {
				token: crypto.randomUUID(),
				parentSession: safeSessionFile(ctx),
				requestedRevision: a.revision + 1,
				reason: a.state.pendingHandoff ?? "人工主动换脑",
			};
			const persistError = await this.persist();
			if (persistError) return { error: `重签 handoff token 失败:${persistError}` };
			if (!a.inMemory) {
				appendLog(statePaths(this.layout, a.state.missionId).logMd, "HANDOFF token 缺失,已重签");
			}
		}
		const record = a.handoff;
		const brief = renderHandoffBrief(
			a.plan,
			{ ...a.state, pendingHandoff: null },
			this.config.missionsDir,
			a.generation,
			a.quickCriterion,
			a.inMemory,
		);
		const phase = a.state.phase;
		let result: { cancelled?: boolean };
		try {
			result = await ctx.newSession({
				parentSession: record.parentSession,
				setup: async (sm: any) => {
					sm.appendCustomEntry("pi-missions-handoff", {
						missionId: a.state.missionId,
						token: record.token,
						revision: record.requestedRevision,
					});
					sm.appendMessage({ role: "user", content: [{ type: "text", text: brief }], timestamp: Date.now() });
				},
				withSession: async (ctx2: any) => {
					// ⚠️ 只能用 ctx2:外层捕获的 pi/ctx 在会话替换后已失效
					await ctx2.sendUserMessage(HANDOFF_NUDGE[phase] ?? "继续当前相位的工作");
				},
			});
		} catch (error) {
			return { error: `创建换脑会话失败:${error instanceof Error ? error.message : String(error)}` };
		}
		if (result.cancelled) {
			const cancelled = await this.applyEvent(
				{ type: "HANDOFF_CANCELLED", at: Date.now(), reason: "newSession 被取消" },
				ctx,
			);
			if (cancelled.error) return { error: cancelled.error };
		}
		return { ok: true };
	}

	// ─────────────────────────── DEFINE(mission_ask / mission_define) ───────────────────────────

	/**
	 * DEFINE 提问。闸门判定在 core(evaluateAsk):每个问题必须带推荐答案,
	 * 一轮最多 3 个,轮次上限由档位定,第二轮起要求上一轮真的落定了决策。
	 *
	 * 交互式问答页(openAskReview)阻塞到人答完:答案直接成为工具结果的一部分
	 * (不再靠模型转抄),同时经 DEFINE_ANSWERED 落进 state —— 换脑后照 state 抄
	 * mission_define.resolved,提问额度不再白烧。Esc = 人中断:轮次照样烧掉,
	 * 否则模型可以反复问反复中断原地打转。没有 UI 的宿主(RPC/ACP)直接拒绝 ——
	 * 模型收到信封后应改为在聊天里提问。
	 */
	async ask(
		ctx: any,
		questions: AskQuestion[],
		settled: string[],
	): Promise<
		| { ok: true; questions: AskQuestion[]; round: number; envelope: string }
		| { error: string }
	> {
		const a = this.active;
		if (!a) return { error: "无活动 mission" };
		if (a.state.phase !== "define") return { error: `当前相位是 ${a.state.phase},只有 define 相位可以提问` };
		if (!ctx.hasUI) {
			return {
				error:
					"当前环境没有交互界面,问答页无法打开 —— 用户看不到这些问题。" +
					"改为在回复里用普通文字提问,把回答记进 mission_define 的 resolved。",
			};
		}

		const verdict = evaluateAsk({
			tier: a.state.tier,
			askedRounds: a.state.defineAsks,
			settled,
			prevSettled: a.state.defineSettled,
			questions,
		});
		if (!verdict.ok) return { error: verdict.reason };

		const r = await this.applyEvent({ type: "DEFINE_ASKED", at: Date.now(), settled }, ctx);
		if (r.error) return { error: r.error };

		const round = this.active!.state.defineAsks;
		const cap = roundCapFor(a.state.tier);
		if (!a.inMemory) {
			appendLog(
				statePaths(this.layout, a.state.missionId).logMd,
				`DEFINE 第 ${round} 轮提问:` +
					verdict.questions.map((q) => `${q.text.replace(/\s+/g, " ")}(推荐:${q.recommend})`).join(" / "),
			);
		}

		const result = await openAskReview(ctx, verdict.questions);
		if (result.status === "cancelled") {
			const envelope =
				`人中断了问答(第 ${round} 轮)。轮次额度已消耗,不要原样重问 —— ` +
				"用现有信息推进 mission_define;确实缺关键决策就说明缺什么,由人重新描述需求。";
			return { ok: true, questions: verdict.questions, round, envelope };
		}

		const records = normalizeAskAnswers(verdict.questions, result.answers);
		const ar = await this.applyEvent(
			{
				type: "DEFINE_ANSWERED",
				at: Date.now(),
				answers: records.map(({ q, a: ans }) => ({ q, a: ans })),
			},
			ctx,
		);
		if (ar.error) return { error: ar.error };

		// 信封:问答记录按题目顺序展开,模型照抄即可,无需转抄
		const body = records.map((rec) => `"${rec.q}"="${rec.a}"${rec.fallback ? "(人未作答,采用推荐)" : ""}`).join(" ");
		const envelope = `人对第 ${round} 轮提问的回答:${body} —— 调用 mission_define 时把这份问答原样带进 resolved。`;
		return { ok: true, questions: verdict.questions, round, envelope };
	}

	// ─────────────────────────── PLAN 侦查扇出(scout) ───────────────────────────

	/**
	 * 扇出一轮只读侦查。判据在 core/scout.ts,子 agent 在 roles/scout.ts,
	 * 这里只做管道:校验 → 消耗额度 → 并行跑 → 记账 → 落盘结论 → 拼信封。
	 *
	 * 与 ask() 同一个骨架,包括最容易被"优化"掉的那一条:**额度先消耗再执行**。
	 * 先跑后记账的话,一轮扇出失败就能无限重来,额度形同不存在。
	 */
	async scout(
		ctx: any,
		questions: ScoutQuestion[],
		onProgress?: (text: string) => void,
	): Promise<{ ok: true; round: number; envelope: string } | { error: string }> {
		const a = this.active;
		if (!a) return { error: "无活动 mission" };
		if (a.state.phase !== "plan") {
			return { error: `当前相位是 ${a.state.phase},只有 plan 相位可以扇出侦查` };
		}

		const verdict = evaluateScout({
			tier: a.state.tier,
			askedRounds: a.state.scoutRounds ?? 0,
			asked: a.state.scoutAsked ?? [],
			questions,
		});
		if (!verdict.ok) return { error: verdict.reason };

		// 模型解析。与 verifier 的同形,但**降级方向相反**:
		// verifier 配了模型解析不到就降级 hard-only(它的独立性是正确性项,不能偷偷换人);
		// scout 只是查资料,换个模型不影响判定,所以回退会话模型继续跑 —— 但必须告警:
		// 会话模型通常是最贵的那个,而扇出是 N 路,静默回退等于悄悄把账翻 N 倍。
		const cfg = this.modelsConfig().scout;
		const hasConfigured = !!(cfg?.provider && cfg?.model);
		const configured = hasConfigured ? ctx.modelRegistry?.find?.(cfg!.provider!, cfg!.model!) : null;
		if (hasConfigured && !configured) {
			this.warn(
				ctx,
				`配置的 scout 模型 ${cfg!.provider}/${cfg!.model} 不可用,本轮 ${verdict.questions.length} 路侦查改用会话模型 —— ` +
					"会话模型通常贵得多,而这是并行 N 路。建议在 /missions 的模型页把 scout 指到一个便宜的小模型。",
			);
		} else if (!hasConfigured) {
			this.warn(
				ctx,
				`scout 未配置模型,本轮 ${verdict.questions.length} 路侦查用会话模型跑 —— 并行 N 路都按它计价。` +
					"侦查是查证不是推理,在 /missions 的模型页指一个便宜的小模型即可,扇出才划算(I7)。",
			);
		}

		// 额度先消耗(与 DEFINE_ASKED 同):跑挂了也算用掉这一轮
		const dispatched = await this.applyEvent(
			{
				type: "SCOUT_DISPATCHED",
				at: Date.now(),
				questions: verdict.questions.map((q) => ({ id: q.id, text: q.text })),
			},
			ctx,
		);
		if (dispatched.error) return { error: dispatched.error };
		const round = this.active!.state.scoutRounds ?? 1;
		const sp = statePaths(this.layout, a.state.missionId);
		if (!a.inMemory) {
			appendLog(
				sp.logMd,
				`SCOUT 第 ${round} 轮扇出 ${verdict.questions.length} 路:` +
					verdict.questions.map((q) => `${q.id} ${q.text.replace(/\s+/g, " ")}`).join(" / "),
			);
		}

		const result = await runScouts({
			cwd: this.cwd,
			model: configured ?? ctx.model,
			thinkingLevel: cfg?.thinking ?? DEFAULT_THINKING.scout,
			timeoutMs: this.config.scoutTimeoutMs ?? 180_000,
			goal: a.plan.goal,
			questions: verdict.questions,
			onProgress: onProgress ? (p) => onProgress(renderScoutProgress(p)) : undefined,
		});

		// 无条件记账(同 verifier):网关不报价时 cost=0,但 token 必须落盘,
		// 否则扇出的消耗在账上隐形 —— 而"扇出到底值不值"只能看这笔账
		const u = result.usage;
		if (u.cost > 0 || u.input + u.output + u.cacheRead + u.cacheWrite > 0) {
			await this.applyEvent(
				{
					type: "RECORD_ROLE_COST",
					at: Date.now(),
					role: "scout",
					amount: u.cost,
					tokens: { input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite },
				},
				ctx,
			);
		}

		const stored = await this.applyEvent(
			{ type: "SCOUT_FINDINGS", at: Date.now(), findings: result.findings },
			ctx,
		);
		if (stored.error) return { error: stored.error };
		if (!a.inMemory) {
			for (const f of result.findings) {
				appendLog(
					sp.logMd,
					`SCOUT ${f.id} ${f.status === "answered" ? (f.surprised ? "与假设有出入" : "符合假设") : "未查明"}:` +
						`${f.answer.replace(/\s+/g, " ")}${f.citations.length ? `(出处:${f.citations.join(", ")})` : ""}`,
				);
			}
		}

		return { ok: true, round, envelope: renderScoutEnvelope(round, result.findings, result.failures) };
	}

	/**
	 * DEFINE 完成:目标 + 完成条件 + 边界写进 plan,进入 PLAN 相位。
	 *
	 * 两道守卫都在这里而不在 machine 里:一道是 core 的纯函数判定(问过就必须交回答),
	 * 一道是人工范围确认 —— 与 writePlan 的冻结确认同形状(确认在事件之前,
	 * 拒绝则相位不动),所以不走 CONFIRM effect,那条路是给机器主动发起的 L3 用的。
	 */
	async define(
		ctx: any,
		params: {
			goal: string;
			doneWhen: DoneWhen[];
			constraints: string[];
			nonGoals: string[];
			verifySeam?: string;
			resolved?: { q: string; a: string }[];
		},
	): Promise<{ ok: true } | { error: string }> {
		const a = this.active;
		if (!a) return { error: "无活动 mission" };
		if (a.state.phase !== "define") return { error: `当前相位是 ${a.state.phase},只有 define 相位可以定义问题` };
		const goal = params.goal?.trim();
		if (!goal) return { error: "goal 为空:DEFINE 的产出就是一句说得清的目标" };

		const doneWhen = (params.doneWhen ?? [])
			.map((d) => ({ id: (d.id ?? "").trim(), text: (d.text ?? "").trim() }))
			.filter((d) => d.id && d.text);
		if (doneWhen.length === 0) {
			return {
				error:
					"doneWhen 为空:完成条件清单是 DEFINE 唯一有机械后果的产出 —— " +
					"PLAN 的每条 AC 都要声明它覆盖哪几条。写不出\"满足什么就算做完了\",说明问题还没定义清楚。",
			};
		}
		const dupe = doneWhen.map((d) => d.id).find((id, i, arr) => arr.indexOf(id) !== i);
		if (dupe) return { error: `完成条件 id 重复:${dupe}` };

		// 问过就必须把回答交回来 —— 人的回答只活在上下文里,换脑即丢,而额度已经烧掉了
		const resolved = (params.resolved ?? []).filter((r) => r.q?.trim() && r.a?.trim());
		if (a.state.defineAsks > 0 && resolved.length === 0) {
			return {
				error:
					"调用过 mission_ask 却没有交 resolved(问答记录)。" +
					"人的回答只活在这一轮上下文里,换脑之后就没了,而提问额度已经用掉了 —— 把问和答一起落下来。",
			};
		}

		const definition: Definition = {
			constraints: params.constraints ?? [],
			nonGoals: params.nonGoals ?? [],
			doneWhen,
			verifySeam: params.verifySeam?.trim() || undefined,
			resolved,
			at: Date.now(),
		};

		// 范围确认:complex 恒确认,standard 只在真的有过歧义时确认(判定见 core/define.ts)
		if (ctx.hasUI && needsScopeConfirm(a.state.tier, a.state.defineAsks)) {
			const verdict = await openDefineReview(ctx, goal, definition);
			if (verdict.status === "rejected") {
				// 无意见拒绝(Esc):关页后补收一次 —— 只回一个 bit 的"不行"没法改
				let comment = verdict.comment ?? "";
				if (!comment && typeof ctx.ui?.editor === "function") {
					comment =
						(await ctx.ui.editor(
							"拒绝意见(planner 会读到,也会写进 LOG.md)",
							"# 哪里不对、期望改成什么。写具体一点 —— 这是 planner 唯一能拿到的反馈。\n",
						)) ?? "";
					comment = comment
						.split("\n")
						.filter((l: string) => !l.trimStart().startsWith("#"))
						.join("\n")
						.trim();
				}
				if (!comment) comment = "(人工拒绝,未写明原因)";
				if (!a.inMemory) {
					appendLog(statePaths(this.layout, a.state.missionId).logMd, `DEFINE 范围确认被拒:${comment.replace(/\s+/g, " ")}`);
				}
				return {
					error:
						`人工拒绝了这个范围定义:${comment}\n` +
						"据此改 goal / doneWhen / nonGoals 后重新调用 mission_define。注意:提问轮次不会返还。",
				};
			}
		}

		a.plan = { ...a.plan, goal, definition };
		const r = await this.applyEvent({ type: "DEFINE_DONE", at: Date.now() }, ctx);
		if (r.error) return { error: r.error };
		if (!a.inMemory) {
			const log = statePaths(this.layout, a.state.missionId).logMd;
			appendLog(log, `DEFINE 定义:${goal.replace(/\s+/g, " ")}`);
			appendLog(log, `完成条件:${doneWhen.map((d) => `${d.id} ${d.text.replace(/\s+/g, " ")}`).join(" / ")}`);
		}
		return { ok: true };
	}

	// ─────────────────────────── 提交计划(mission_write_plan) ───────────────────────────

	/**
	 * 人工打回:关页之后单独收意见(ui.custom 里嵌 ui.editor 会把 TUI 叠坏),
	 * 落 STATE + LOG,再由 machine 判断是让 planner 重交还是转 L3 回 DEFINE。
	 */
	private async rejectPlan(ctx: any): Promise<{ error: string }> {
		const a = this.active!;
		let comment = "";
		if (typeof ctx.ui?.editor === "function") {
			comment =
				(await ctx.ui.editor(
					"打回意见(planner 会读到,也会写进 LOG.md)",
					"# 哪里不对、期望改成什么。写具体一点 —— 这是 planner 唯一能拿到的反馈。\n",
				)) ?? "";
		}
		comment = comment
			.split("\n")
			.filter((l) => !l.trimStart().startsWith("#"))
			.join("\n")
			.trim();
		if (!comment) comment = "(人工打回,未写明原因)";

		const before = a.state.phase;
		const r = await this.applyEvent({ type: "PLAN_REJECTED", at: Date.now(), comment }, ctx);
		if (r.error) return { error: r.error };
		if (!a.inMemory) {
			appendLog(statePaths(this.layout, a.state.missionId).logMd, `人工打回:${comment.replace(/\s+/g, " ")}`);
		}

		const n = this.active!.state.planReview.rejections;
		// 打回到上限时 machine 已经把相位推回 DEFINE 并挂起换脑,这里只是把话说清楚
		if (before === "plan" && this.active?.state.phase === "define") {
			return {
				error:
					`计划已被连续打回 ${n} 次,不再重交:问题多半不在方案,而在问题定义。\n` +
					`最后一次的意见:${comment}\n` +
					"系统已转 L3 回到 DEFINE 并挂起换脑 —— 执行 /mission next 换脑后重新定义问题。",
			};
		}
		return {
			error:
				`人工打回(第 ${n} 次):${comment}\n` +
				"据此修改后重新调用 mission_write_plan。注意:再被打回若干次会直接转 L3 回 DEFINE 重新定义问题。",
		};
	}

	async writePlan(
		ctx: any,
		params: {
			goal: string;
			acceptanceCriteria: MissionPlan["acceptanceCriteria"];
			milestones: MissionPlan["milestones"];
			verifyScript: string;
		},
	): Promise<{ ok: true; taskOrder: string[] } | { error: string }> {
		const a = this.active;
		if (!a) return { error: "无活动 mission" };
		if (a.state.phase !== "plan") return { error: `当前相位是 ${a.state.phase},只能在 plan 相位写计划` };

		const plan: MissionPlan = { ...a.plan, ...params };
		const errors = validatePlan(plan);
		// 完成条件的覆盖:DEFINE 产出的清单必须被 AC 逐条翻译成退出码。
		// 独立成模块是因为它判的是两份产物之间的关系,不是计划自身的结构合法性。
		// quick 起源的 mission 没有 definition(它从未经过 DEFINE 相位),这里无话可说。
		if (plan.definition) {
			errors.push(...evaluateCoverage({ doneWhen: plan.definition.doneWhen, acs: plan.acceptanceCriteria }));
		}
		// 探针的额度是 mission 级的,validatePlan(纯函数、只看计划)判不了,放在这里
		errors.push(
			...validateSpikePlan({
				spikeTaskIds: spikeTaskIds(plan),
				alreadyRanSpike: a.state.spikesRun > 0,
			}),
		);
		if (errors.length > 0) return { error: `计划不合法:\n${errors.map((e) => `- ${e}`).join("\n")}` };

		// PLAN 冻结前人工确认 —— 最重要的一次介入(§7.4)。
		// 摊开整份计划(含 verify.sh 全文),打回时收一段意见回传给 planner:
		// 只回一个 bit 的"不行"会让他原地改个措辞再交一次。
		if (ctx.hasUI) {
			const verdict = await openPlanReview(ctx, () => ({ plan, state: this.active!.state }));
			if (verdict.status === "cancelled") return { error: "计划评审已取消,未冻结也未记作打回" };
			if (verdict.status === "rejected") return await this.rejectPlan(ctx);
		}

		// 候选计划先写入未发布 generation；基线只执行这份临时脚本。
		// 失败时丢弃临时目录，绝不覆盖当前 snapshot 所绑定的裁判。
		const staged = this.repository.stagePlan(a.state.missionId, a.revision, plan);
		if (shouldProbeBaseline(a.state.escalation.history.length)) {
			const probes = await this.runBaseline(plan, staged.verifySh);
			const baselineErrors = evaluateBaseline(probes);
			this.logBaseline(probes, baselineErrors);
			if (baselineErrors.length > 0) {
				this.repository.discardStaged(staged);
				ctx.ui.notify(`基线未通过,计划未冻结(${baselineErrors.length} 项)`, "error");
				return {
					error:
						`基线校验未通过(计划未冻结,仍在 PLAN 相位):\n${baselineErrors.map((e) => `- ${e}`).join("\n")}\n` +
						"修正 AC 或 verify.sh 后重新调用 mission_write_plan。",
				};
			}
			ctx.ui.notify(`基线通过:${probes.map((p) => `${p.acId}=${p.expected}`).join(" ")}`, "info");
		} else if (!a.inMemory) {
			appendLog(statePaths(this.layout, a.state.missionId).logMd, "baseline skipped (重规划:世界已被执行者改过)");
		}

		const previousPlan = a.plan;
		a.plan = plan;
		this.stagedPlan = staged;
		// 记录冻结时的 git HEAD —— verifier 的 diff 基准。
		// 从 baseCommit 到 HEAD 的 diff 才是本次 mission 的产出,
		// 从 HEAD 开始 diff 会把冻结前的工作混进 verdict 证据里。
		const baseCommitR = await this.exec("git", ["rev-parse", "HEAD"], { timeout: 5_000 });
		const baseCommit = baseCommitR.exitCode === 0 ? baseCommitR.stdout.trim() : null;
		const r = await this.applyEvent(
			{
				type: "PLAN_FROZEN",
				at: Date.now(),
				taskOrder: taskOrder(plan),
				spikes: spikeTaskIds(plan),
				baseCommit,
				sessionFile: safeSessionFile(ctx),
			},
			ctx,
		);
		if (r.error) {
			a.plan = previousPlan;
			if (this.stagedPlan) this.repository.discardStaged(this.stagedPlan);
			this.stagedPlan = null;
			return { error: r.error };
		}
		return { ok: true, taskOrder: taskOrder(plan) };
	}

	/** 逐条跑 AC 的 verify 分支,采集冻结时刻的基线退出码 */
	private async runBaseline(plan: MissionPlan, script: string): Promise<BaselineProbe[]> {
		const probes: BaselineProbe[] = [];
		for (const ac of plan.acceptanceCriteria) {
			const r = await this.exec("bash", [script, ac.verify], { timeout: BASELINE_TIMEOUT_MS });
			probes.push({ acId: ac.id, verify: ac.verify, expected: ac.baseline ?? "red", exitCode: r.code });
		}
		return probes;
	}

	private logBaseline(probes: BaselineProbe[], errors: string[]): void {
		const a = this.active;
		if (!a || a.inMemory) return;
		const line = probes.map((p) => `${p.acId}:${p.verify} exit=${p.exitCode} want=${p.expected}`).join(" · ");
		const md = statePaths(this.layout, a.state.missionId).logMd;
		appendLog(md, `baseline ${line}`);
		for (const e of errors) appendLog(md, `baseline REJECTED: ${e}`);
	}

	// ─────────────────────────── 杂项 ───────────────────────────

	modelsConfig(): ModelsConfig {
		return loadModelsConfig(modelsJson(this.layout));
	}

	/** 会话当前模型的可读名(角色未配置时实际会用它) */
	sessionModelLabel(ctx: any): string {
		const m = ctx?.model as { provider?: string; id?: string } | undefined;
		return m?.provider && m?.id ? `${m.provider}/${m.id}` : (m?.id ?? "当前会话模型");
	}

	/**
	 * 可选模型列表。优先用 ctx.scopedModels(pi 文档指定的 picker 数据源,
	 * 与内置选择器同一套),没有 scoping 时退回整个目录。
	 */
	availableModels(ctx: any): Array<{ provider: string; id: string; name?: string }> {
		const norm = (m: any) => ({ provider: String(m?.provider ?? ""), id: String(m?.id ?? ""), name: m?.name });
		try {
			const scoped = (ctx?.scopedModels ?? []) as Array<{ model: any }>;
			if (scoped.length > 0) return scoped.map((e) => norm(e.model)).filter((m) => m.provider && m.id);
			const all = (ctx?.modelRegistry?.getAvailable?.() ?? []) as any[];
			return all.map(norm).filter((m) => m.provider && m.id);
		} catch {
			return [];
		}
	}

	/**
	 * 改角色模型映射。写 missions/models.json(I6:配置进仓库)。
	 *
	 * 三件事必须一起做,少一件这个面板就不该存在:
	 *   1. 若改的正是当前相位的角色,立刻 applyRole —— 否则要等到下次相位切换才生效
	 *   2. 进行中的 mission 一律写 LOG.md —— 判定口径和成本口径变了,审计链要能解释
	 *   3. verifier 额外告警 —— 它是 I3 的独立判定者,中途换等于换裁判
	 */
	async setRoleModel(
		ctx: any,
		role: Role,
		selection: { provider: string; id: string } | null,
		thinking?: string,
	): Promise<void> {
		const cfg = this.modelsConfig();
		const prev = cfg[role];
		const next: RoleModelConfig = { ...prev };
		if (selection === null) {
			delete next.provider;
			delete next.model;
		} else {
			next.provider = selection.provider;
			next.model = selection.id;
		}
		if (thinking !== undefined) next.thinking = thinking;

		if (Object.keys(next).length === 0) delete cfg[role];
		else cfg[role] = next;
		saveModelsConfig(modelsJson(this.layout), cfg);

		const before = prev?.provider && prev?.model ? `${prev.provider}/${prev.model}` : "跟随会话";
		const after = next.provider && next.model ? `${next.provider}/${next.model}` : "跟随会话";
		const line =
			`MODEL ${role}: ${before} → ${after}` +
			(thinking !== undefined && thinking !== prev?.thinking ? ` · thinking ${prev?.thinking ?? "默认"} → ${thinking}` : "");

		const a = this.active;
		if (a && !a.inMemory) appendLog(statePaths(this.layout, a.state.missionId).logMd, line);
		if (a && role === "verifier" && a.state.phase !== "done" && a.state.phase !== "halted") {
			this.warn(
				ctx,
				"mission 进行中更换了 verifier 模型:此后的 semi 证据与之前不同源,判定口径已变(已记入 LOG.md)",
			);
		}
		// 改的正是当前相位的角色 → 立刻生效,不必等下次相位切换
		if (a && ROLE_OF[a.state.phase] === role) {
			await applyRole(this.pi, ctx, role, this.modelsConfig(), (m) => this.warn(ctx, m));
		}
	}

	/** 消费待选档位(返回后清除) */
	consumePendingTier(): Tier | null {
		const t = this.pendingTier;
		this.pendingTier = null;
		return t;
	}

	private busy(): boolean {
		return !!this.active && this.active.state.phase !== "done" && this.active.state.phase !== "halted";
	}

	/**
	 * 哪些运行态不进版本控制。**按属性划,不按目录划。**
	 *
	 * 排除侧的共同点是「高频重写 + 无合并语义 + 本机私有」:
	 * SNAPSHOT.json 是 CAS revision 保护的状态机快照,两个 clone 各自推进到同一个
	 * revision 号再合并,熔断计数就成了随机数 —— 它**不能**进版本控制,这是在保护
	 * 一条不变量,不是嫌它吵。CURRENT/CHECK/profile 同理(定位提示、瞬时运行态、本机现场)。
	 *
	 * 反过来,LOG.md 与 archive/ 曾经也在这张单子上,理由只是"它们躺在 state/ 目录下"——
	 * 那是目录布局的副产品,不是一个决定。两者都是 append-only / 写完不改,天生可合并,
	 * 而且是重规划真正要读的东西:plan.md 与换脑简报都写着"先读 LOG.md 失败记录",
	 * L3 的简报还要读 archive/ 里的旧 MISSION.md。把它们排掉,等于让接手的人
	 * (或换脑后的新会话)去读一份不存在的失败史。
	 *
	 * evidence/ 留在排除侧是量的考虑:每条证据带完整 stdout/stderr,不适合进历史。
	 *
	 * 注意:ensureInfoExclude 只追加。老仓库的 .git/info/exclude 里已经写下的
	 * LOG.md / archive 行不会被自动删除 —— 要让它们进版本控制得手工去掉那两行。
	 */
	private ensureStateExcludes(): void {
		const base = `${this.config.missionsDir}/state`;
		for (const pattern of [
			`${base}/CURRENT`,
			`${base}/*/SNAPSHOT.json`,
			`${base}/*/CHECK.json`,
			`${base}/*/profile.json`,
			`${base}/*/evidence/`,
		]) {
			ensureInfoExclude(this.cwd, pattern);
		}
	}

	private async persist(): Promise<string | null> {
		const a = this.active;
		if (!a || a.inMemory) return null;
		const content = { plan: a.plan, state: a.state, handoff: a.handoff };
		const result = this.stagedPlan
			? this.repository.commitStaged(this.stagedPlan, content)
			: this.repository.commit(a.state.missionId, a.revision, content);
		this.stagedPlan = null;
		if (!result.ok) return result.error;
		this.applySnapshotMetadata(result.snapshot);
		return null;
	}

	private activeFromSnapshot(snapshot: MissionSnapshotV2, git: boolean): ActiveMission {
		return {
			plan: snapshot.plan,
			state: snapshot.state,
			inMemory: false,
			git,
			revision: snapshot.revision,
			generation: snapshot.artifacts.generation,
			handoff: snapshot.handoff,
		};
	}

	private applySnapshotMetadata(snapshot: MissionSnapshotV2): void {
		const a = this.active;
		if (!a) return;
		a.plan = snapshot.plan;
		a.state = snapshot.state;
		a.revision = snapshot.revision;
		a.generation = snapshot.artifacts.generation;
		a.handoff = snapshot.handoff;
	}

	/** 用户现场(thinking/模型)随 mission 落盘,跨会话接力时 RESTORE 才能还原 */
	private persistProfile(): void {
		const a = this.active;
		if (!a || a.inMemory || !this.savedProfile) return;
		const file = path.join(statePaths(this.layout, a.state.missionId).dir, "profile.json");
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, `${JSON.stringify(profileToJson(this.savedProfile))}\n`, "utf8");
	}

	private loadProfile(): SavedProfile | null {
		const a = this.active;
		if (!a) return null;
		try {
			const file = path.join(statePaths(this.layout, a.state.missionId).dir, "profile.json");
			return profileFromJson(JSON.parse(fs.readFileSync(file, "utf8")));
		} catch {
			return null;
		}
	}

	/**
	 * 当前相位该活跃的工具集。
	 *
	 * done/halted 不是"一个什么都给的相位",是**没有相位** —— 该还给用户的是他开
	 * mission 之前的现场(profile.tools),里面包含第三方扩展注册的工具。
	 * 这里原来一律发 `[...BUILTIN_ALL, ...MISSION_TOOLS]`,于是 mission 一开始被
	 * setActiveTools 摘掉的第三方工具(subagent、todo、MCP 桥接……)结束后永远回不来,
	 * 要重开会话才有 —— 那是 bug,不是取舍。
	 *
	 * 只有**没记到**现场时(旧 profile.json、或替身 pi 没有 getActiveTools)才回落到
	 * 内置全集。空数组是记到了的合法现场(`--no-tools`),照原样还回去 ——
	 * 用 `??` 而不是判真假,就是为了把这两种情况分开。
	 */
	private toolsForActivePhase(): string[] {
		const a = this.active!;
		if (a.state.phase === "done" || a.state.phase === "halted") {
			return this.savedProfile?.tools ?? [...BUILTIN_ALL, ...MISSION_TOOLS];
		}
		return toolsForPhase(a.state.phase, a.state.tier);
	}

	warn(ctx: any, msg: string): void {
		ctx.ui.notify(msg, "warning");
		// quick 档无盘可落(Q18)。写了反而糟:建出一个只有 LOG.md 的目录,
		// 之后每次开 /missions 都被当成"损坏的 mission"报一次红字。
		const a = this.active;
		if (a && !a.inMemory) appendLog(statePaths(this.layout, a.state.missionId).logMd, `WARN ${msg}`);
	}

	refreshWidget(ctx: any): void {
		const a = this.active;
		if (!a || a.state.phase === "done" || a.state.phase === "halted") {
			ctx.ui.setWidget("missions", undefined);
			return;
		}
		const checkState =
			this.liveCheckState ?? (a.inMemory ? null : loadCheckState(statePaths(this.layout, a.state.missionId).checkJson));
		// 主题化状态卡片(颜色/对齐/右对齐时长成本);widget width 不可信,再按 120 封顶
		ctx.ui.setWidget("missions", (tui: any, theme: any) => {
			const ticking = checkState && checkState.stage !== "completed" && checkState.stage !== "error";
			const timer = ticking ? setInterval(() => tui.requestRender(), 500) : null;
			timer?.unref();
			return {
				render: (width: number) =>
					renderWidgetCard(theme, a.plan, a.state, Date.now(), Math.min(width, 120), checkState),
				invalidate: () => {},
				dispose: () => {
					if (timer) clearInterval(timer);
				},
			};
		});
	}

	checkStateFor(missionId: string): CheckState | null {
		if (this.active?.state.missionId === missionId && this.liveCheckState) {
			return this.liveCheckState;
		}
		return loadCheckState(statePaths(this.layout, missionId).checkJson);
	}
}

// ─────────────────────────── 渲染(纯函数,UI 层共用) ───────────────────────────

// renderStateCard / renderDoBrief / renderActBrief / renderHandoffBrief
// 已提取到 src/briefs.ts —— 纯函数,不依赖 Runtime 实例。

/**
 * 粘贴进来的图片会在目标里留下一条临时路径。
 *
 * pi 处理剪贴板图片的方式是先落一个临时文件,再把**绝对路径**当文本塞进消息头部,
 * 于是 `/mission quick` 收到的目标长这样:
 *   `/var/folders/…/T/pi-clipboard-<uuid>.png 如图 在 light 主题下,这个按钮有点扎眼`
 * 这条路径会一路复制进 mission id、milestone 标题、任务标题和换脑简报,而它指向的
 * 文件几小时后就被系统清掉了 —— 留下一个谁也看不懂的任务名(真实事故)。
 *
 * 只认 pi 自己的剪贴板文件名,不动用户真正提到的路径:换成 `[图片]` 而不是直接删,
 * 后面那句"如图"才有指代。
 */
// 文件名必须是 pi 生成的那种 `pi-clipboard-<uuid>.<图片扩展名>`。
// 只匹配 `pi-clipboard-*` 会误伤仓库里真实存在的 docs/pi-clipboard-guide.png。
const CLIPBOARD_IMAGE_PATH =
	/(?:^|(?<=\s))\S*[/\\]pi-clipboard-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:png|jpe?g|gif|webp|bmp)(?=\s|$)/gi;

export function sanitizeGoal(goal: string): string {
	return goal
		.replace(CLIPBOARD_IMAGE_PATH, "[图片]")
		.replace(/\s+/g, " ")
		.trim();
}

function slugify(goal: string): string {
	const ascii = goal
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40);
	return ascii || `mission-${Date.now().toString(36)}`;
}

function safeSessionFile(ctx: any): string {
	try {
		return ctx.sessionManager.getSessionFile() ?? "";
	} catch {
		return "";
	}
}

function readHandoffMarker(
	ctx: any,
): { missionId: string; token: string; revision: number } | null {
	try {
		const entries = ctx.sessionManager.getEntries() as Array<{
			type?: string;
			customType?: string;
			data?: unknown;
		}>;
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i];
			if (entry?.type !== "custom" || entry.customType !== "pi-missions-handoff") continue;
			const data = entry.data as { missionId?: unknown; token?: unknown; revision?: unknown } | undefined;
			if (
				typeof data?.missionId === "string" &&
				typeof data.token === "string" &&
				Number.isInteger(data.revision)
			) {
				return { missionId: data.missionId, token: data.token, revision: data.revision as number };
			}
		}
	} catch {
		/* 无 session 文件时不能完成磁盘握手 */
	}
	return null;
}

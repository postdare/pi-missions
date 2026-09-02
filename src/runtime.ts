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
import type { Effect, MissionEvent, MissionState, Phase, Role, Tier, TransitionResult, Evidence } from "./core/types.ts";
import { initialState, transition, ROLE_OF } from "./core/machine.ts";
import { judge } from "./core/verdict.ts";
import { evaluateCriterion } from "./core/criterion.ts";
import { evaluatePromotion } from "./core/tier.ts";
import { evaluateBaseline, shouldProbeBaseline, type BaselineProbe } from "./core/baseline.ts";
import { evaluateAsk, needsScopeConfirm, normalizeAskAnswers, roundCapFor, type AskQuestion } from "./core/define.ts";
import { evaluateCoverage } from "./core/coverage.ts";
import { openPlanReview } from "./ui/plan-review.ts";
import { openAskReview } from "./ui/ask-review.ts";
import { reportIsSubstantive, validateSpikePlan } from "./core/spike.ts";
import type { DoneWhen, Definition, MissionPlan } from "./store/mission.ts";
import {
	allTasks,
	findMilestoneOf,
	findTask,
	isLastTaskOfMilestone,
	spikeTaskIds,
	taskOrder,
	validatePlan,
} from "./store/mission.ts";
import { loadConfig, matchGlob, type MissionsConfig } from "./store/config.ts";
import { envFingerprintSh, layout, modelsJson, spikeReport, statePaths, type RepoLayout } from "./store/paths.ts";
import { ensureScaffold } from "./store/scaffold.ts";
import { appendLog } from "./store/log.ts";
import { computeEnvFingerprint, computeGitTreeFingerprint, ensureInfoExclude, isGitRepo } from "./store/git.ts";
import { saveEvidence } from "./store/evidence.ts";
import { loadCheckState, removeCheckState, saveCheckState, type CheckState } from "./store/check.ts";
import { renderWidgetCard } from "./ui/dashboard.ts";
import {
	applyRole,
	loadModelsConfig,
	saveModelsConfig,
	profileFromJson,
	profileToJson,
	restoreProfile,
	saveProfile,
	type ModelsConfig,
	type RoleModelConfig,
	type SavedProfile,
	DEFAULT_THINKING,
} from "./roles/models.ts";
import {
	renderSpikeVerifierBrief,
	renderVerifierBrief,
	runVerifier,
	type VerifierControl,
	type VerifierProgress,
} from "./roles/verifier.ts";
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

const EVIDENCE_TAIL = 4000;
/** 基线探针的单分支超时。与 CHECK 同量级:基线本来就该快速失败 */
const BASELINE_TIMEOUT_MS = 600_000;
const DIFF_TAIL = 12000;

export class Runtime {
	active: ActiveMission | null = null;
	/** 面板/命令选定的待用档位;下一次 /mission new 消费掉 */
	pendingTier: Tier | null = null;
	private savedProfile: SavedProfile | null = null;
	private diagnostics: IncrementalDiagnostics | null = null;
	private suppressHandoffFollowUp = false;
	private liveCheckState: CheckState | null = null;
	private checkPromises = new WeakMap<ActiveMission, Promise<void>>();
	private activeVerifierControl: VerifierControl | null = null;
	private stagedPlan: StagedPlan | null = null;

	private readonly pi: any;
	private readonly cwd: string;

	constructor(pi: any, cwd: string) {
		this.pi = pi;
		this.cwd = cwd;
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

	private get exec() {
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
		this.pi.setActiveTools(toolsForPhase(this.active.state.phase, this.active.state.tier));
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
			const treeFp = this.active.git ? await computeGitTreeFingerprint(this.exec, this.cwd) : null;
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
					this.pi.setActiveTools([...BUILTIN_ALL, ...MISSION_TOOLS]);
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
		appendLog(
			statePaths(this.layout, a.state.missionId).logMd,
			`env fingerprint=${a.state.envFingerprint} generation=${a.generation}`,
		);
	}

	/** 探针任务开始前先把结论目录建好,免得执行者第一次写文件就撞在 ENOENT 上 */
	private ensureSpikeDir(): void {
		const s = this.currentSpikeReport();
		if (s) fs.mkdirSync(path.dirname(s.abs), { recursive: true });
	}

	private async persistPlanFiles(): Promise<void> {
		const a = this.active!;
		ensureScaffold(this.layout);
		const snapshot = this.repository.create(a.plan, a.state);
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
		const text = message.trim();
		if (!text) return { error: "steer 内容为空" };
		if (!this.active || this.active.state.phase !== "check") {
			return { error: "当前不在 CHECK 相位" };
		}
		const control = this.activeVerifierControl;
		if (!control) return { error: "独立 Verifier 尚未启动或已经结束" };
		try {
			await control.steer(text);
			const verifier = this.liveCheckState?.verifier;
			if (verifier) {
				verifier.steerCount = (verifier.steerCount ?? 0) + 1;
				this.liveCheckState!.updatedAt = Date.now();
				if (!this.active.inMemory) {
					saveCheckState(statePaths(this.layout, this.active.state.missionId).checkJson, this.liveCheckState!);
					appendLog(
						statePaths(this.layout, this.active.state.missionId).logMd,
						`VERIFIER STEER ${text.replace(/\s+/g, " ").slice(0, 200)}`,
					);
				}
			}
			this.refreshWidget(ctx);
			return { ok: true };
		} catch (error) {
			return { error: error instanceof Error ? error.message : String(error) };
		}
	}

	private isCurrentCheck(active: ActiveMission, taskId: string, attempt: number): boolean {
		return (
			this.active === active &&
			active.state.phase === "check" &&
			active.state.currentTask === taskId &&
			(active.state.tasks[taskId]?.attempts ?? 1) === attempt
		);
	}

	async runCheck(ctx: any): Promise<void> {
		const a = this.active;
		if (!a || a.state.phase !== "check" || !a.state.currentTask) return;
		const taskId = a.state.currentTask;
		const task = findTask(a.plan, taskId);
		const attempt = a.state.tasks[taskId]?.attempts ?? 1;
		const isCurrent = () => this.isCurrentCheck(a, taskId, attempt);
		const l = this.layout;
		const sp = statePaths(l, a.state.missionId);
		const checkState: CheckState = {
			taskId,
			attempt,
			startedAt: Date.now(),
			updatedAt: Date.now(),
			stage: "preparing",
			completedBranches: [],
			verifier: { status: "pending" },
			summary: "准备环境...",
		};
		const persistCheck = (partial: Partial<CheckState> = {}) => {
			Object.assign(checkState, partial);
			checkState.updatedAt = Date.now();
			if (isCurrent()) this.liveCheckState = checkState;
			if (!a.inMemory && isCurrent()) saveCheckState(sp.checkJson, checkState);
		};
		const evidences: Evidence[] = [];
		let requiredAcIds: string[] = [];
		const hardResults: Array<{ acId: string; pass: boolean; outputTail: string }> = [];

		const runHard = async (
			acId: string,
			command: string,
			cmd: string,
			args: string[],
			timeout: number,
			envFingerprint: string,
		): Promise<void> => {
			const startedAt = Date.now();
			persistCheck({
				stage: "running_scripts",
				currentBranch: acId,
				summary: `正在执行 verify 分支: ${acId}`,
			});
			this.refreshWidget(ctx);
			const result = await this.exec(cmd, args, { timeout });
			const durationMs = Date.now() - startedAt;
			const raw = tail(`${result.stdout}\n${result.stderr}`, EVIDENCE_TAIL);
			const evidence: Evidence = {
				level: "hard",
				acId,
				result: result.code === 0 ? "pass" : "fail",
				raw,
				exitCode: result.code,
				envFingerprint,
				command,
				startedAt,
				durationMs,
				stdout: result.stdout,
				stderr: result.stderr,
			};
			evidences.push(evidence);
			hardResults.push({
				acId,
				pass: result.code === 0,
				outputTail: tail(raw, 800),
			});
			checkState.completedBranches.push({
				acId,
				status: evidence.result,
				exitCode: result.code,
				startedAt,
				durationMs,
				command,
			});
			persistCheck({ currentBranch: undefined });
		};

		const runIndependentVerifier = async (
			envFingerprint: string,
			renderBrief: () => Promise<string>,
		): Promise<void> => {
			if (!isCurrent()) return;
			if (!a.git) {
				persistCheck({
					verifier: { status: "skipped", message: "目标目录不是 git 仓库" },
				});
				return;
			}
			const startedAt = Date.now();
			const timeoutMs = this.config.verifierTimeoutMs ?? 300_000;
			persistCheck({
				stage: "running_verifier",
				verifier: { status: "running", startedAt, activity: "初始化独立 AgentSession", trace: [] },
				summary: "脚本已完成，独立验证者核验中...",
			});
			this.refreshWidget(ctx);
			const verifierConfig = this.modelsConfig().verifier;
			const hasConfiguredModel = !!(verifierConfig?.provider && verifierConfig?.model);
			const configuredModel = hasConfiguredModel
				? ctx.modelRegistry?.find?.(verifierConfig!.provider!, verifierConfig!.model!)
				: null;
			// 配了模型但解析不到 → 显式降级 hard-only,绝不静默退回会话模型(semi 证据的来源必须可审计)
			if (hasConfiguredModel && !configuredModel) {
				const message = `配置的 verifier 模型 ${verifierConfig!.provider}/${verifierConfig!.model} 不可用,降级为 hard-only`;
				if (!a.inMemory) appendLog(sp.logMd, message);
				persistCheck({
					verifier: { status: "degraded", startedAt, durationMs: Date.now() - startedAt, activity: "核验不可用", message },
				});
				return;
			}
			const model = configuredModel ?? ctx.model;
			let ownedControl: VerifierControl | null = null;
			const updateVerifierProgress = (progress: VerifierProgress) => {
				if (!isCurrent()) return;
				const steerCount = checkState.verifier?.steerCount ?? 0;
				persistCheck({
					verifier: {
						status: "running",
						startedAt,
						activity: progress.activity,
						trace: progress.trace,
						turns: progress.turns,
						toolCalls: progress.toolCalls,
						inputTokens: progress.input,
						outputTokens: progress.output,
						cacheReadTokens: progress.cacheRead,
						cacheWriteTokens: progress.cacheWrite,
						cost: progress.cost,
						steerCount,
					},
					summary: `独立核验: ${progress.activity}`,
				});
				this.refreshWidget(ctx);
			};
			const verifierResult = await runVerifier({
				cwd: this.cwd,
				model,
				thinkingLevel: verifierConfig?.thinking ?? DEFAULT_THINKING.verifier,
				timeoutMs,
				envFingerprint,
				expectedAcIds: requiredAcIds,
				brief: await renderBrief(),
				onProgress: updateVerifierProgress,
				onControl: (control) => {
					if (control) {
						ownedControl = control;
						if (isCurrent()) this.activeVerifierControl = control;
					} else if (this.activeVerifierControl === ownedControl) {
						this.activeVerifierControl = null;
					}
				},
			});
			const durationMs = Date.now() - startedAt;
			// 无条件记账:网关不报价时 cost=0,但 token 用量必须落盘,否则 verifier 的消耗在账上隐形
			const vu = verifierResult.usage;
			if (isCurrent() && (vu.cost > 0 || vu.input + vu.output + vu.cacheRead + vu.cacheWrite > 0)) {
				await this.applyEvent(
					{
						type: "RECORD_ROLE_COST",
						at: Date.now(),
						role: "verifier",
						amount: vu.cost,
						tokens: { input: vu.input, output: vu.output, cacheRead: vu.cacheRead, cacheWrite: vu.cacheWrite },
					},
					ctx,
				);
			}
			if (verifierResult.status === "completed") {
				evidences.push(
					...verifierResult.evidences.map((e) => ({
						...e,
						command: "in-process verifier AgentSession",
						startedAt,
						durationMs,
						stdout: `${verifierResult.trace.join("\n")}\n\n${e.raw}`,
						stderr: "",
					})),
				);
				persistCheck({
					verifier: {
						...checkState.verifier,
						status: "completed",
						startedAt,
						durationMs,
						activity: "核验完成",
						trace: verifierResult.trace,
						inputTokens: vu.input,
						outputTokens: vu.output,
						cacheReadTokens: vu.cacheRead,
						cacheWriteTokens: vu.cacheWrite,
						cost: vu.cost,
					},
				});
				return;
			}
			// 原因必须进 LOG,不能只进 CHECK.json。真实事故:简报与校验的 id 命名空间
			// 不一致,每一轮都抛"提交了未知 AC",LOG 里却只有一句"unavailable" ——
			// 整个 mission 的 semi 层从未生效,而看 LOG 的人完全看不出这是个 bug
			// 而不是模型不可用。降级本身是设计(模型策略是优化项),降级的**原因**不是。
			const degradeWhy = (verifierResult.status === "timeout" ? "超时" : verifierResult.message)
				.replace(/\s+/g, " ")
				.slice(0, 200);
			if (!a.inMemory) {
				appendLog(sp.logMd, `verifier 降级 hard-only:${degradeWhy}`);
			}
			this.warn(ctx, `独立核验降级为 hard-only:${degradeWhy}`);
			persistCheck({
				verifier: {
					...checkState.verifier,
					status: verifierResult.status === "timeout" ? "timeout" : "degraded",
					startedAt,
					durationMs,
					activity: verifierResult.status === "timeout" ? "核验超时" : "核验不可用",
					trace: verifierResult.trace,
					inputTokens: vu.input,
					outputTokens: vu.output,
					cacheReadTokens: vu.cacheRead,
					cacheWriteTokens: vu.cacheWrite,
					cost: vu.cost,
					message:
						verifierResult.status === "timeout"
							? `独立验证者超时,降级为 hard-only:${verifierResult.message}`
							: `独立验证者不可用,降级为 hard-only:${verifierResult.message}`,
				},
			});
		};

		persistCheck();
		this.refreshWidget(ctx);

		try {
			const fp = await computeEnvFingerprint(this.exec, this.cwd, envFingerprintSh(l));
			if (!isCurrent()) return;
			const spike = this.currentSpikeReport();
			if (spike) {
				const startedAt = Date.now();
				persistCheck({
					stage: "running_scripts",
					currentBranch: "spike",
					summary: "正在检查探针结论文件...",
				});
				const report = fs.existsSync(spike.abs) ? fs.readFileSync(spike.abs, "utf8") : null;
				const substantive = reportIsSubstantive(report);
				const durationMs = Date.now() - startedAt;
				const raw = substantive
					? `结论文件 ${spike.rel}(${report!.trim().length} 字)`
					: `结论文件 ${spike.rel} 缺失或过短 —— 探针的产出就是这份结论`;
				requiredAcIds = ["spike"];
				evidences.push({
					level: "hard",
					acId: "spike",
					result: substantive ? "pass" : "fail",
					raw,
					exitCode: substantive ? 0 : 1,
					envFingerprint: fp,
					command: `check ${spike.rel}`,
					startedAt,
					durationMs,
					stdout: substantive ? report! : "",
					stderr: substantive ? "" : raw,
				});
				checkState.completedBranches.push({
					acId: "spike",
					status: substantive ? "pass" : "fail",
					exitCode: substantive ? 0 : 1,
					startedAt,
					durationMs,
					command: `check ${spike.rel}`,
				});
				persistCheck({ currentBranch: undefined });
				if (substantive) {
					if (!isCurrent()) return;
					await runIndependentVerifier(fp, async () =>
						renderSpikeVerifierBrief({
							goal: a.plan.goal,
							taskId: task?.id ?? "",
							question: task?.question ?? "",
							report: tail(report!, EVIDENCE_TAIL),
							diff: await this.gitDiff(),
						}),
					);
				} else {
					persistCheck({
						verifier: { status: "skipped", message: "探针结论未通过机械检查" },
					});
				}
			} else if (a.state.tier === "quick") {
				// 判据一条,裁判按冻结时选的那种。三种裁判产出的证据级别不同
				// (hard / semi / human),但都在执行者之外 —— I3 的要求是这个,
				// 不是"判定必须可执行"。
				const criterion = a.quickCriterion;
				requiredAcIds = criterion ? ["quick"] : [];
				if (criterion?.judge === "command") {
					const command = criterion.command;
					await runHard("quick", command, "bash", ["-c", command], 300_000, fp);
					if (!isCurrent()) return;
					persistCheck({
						verifier: { status: "skipped", message: "quick 命令判据:hard 证据已足够" },
					});
				} else if (criterion?.judge === "ai") {
					await runIndependentVerifier(fp, async () =>
						renderVerifierBrief({
							goal: a.plan.goal,
							taskId: task?.id ?? "",
							taskTitle: a.plan.goal,
							acceptanceCriteria: [{ id: "quick", text: criterion.text, verify: "quick" }],
							expectedAcIds: requiredAcIds,
							hardResults,
							diff: await this.gitDiff(),
						}),
					);
				} else if (criterion?.judge === "human") {
					await this.collectHumanVerdict(ctx, criterion.text, evidences, fp, persistCheck);
					if (!isCurrent()) return;
				} else {
					persistCheck({
						verifier: { status: "skipped", message: "quick 档无判据(不应发生:准入已守)" },
					});
				}
			} else {
				const script = this.repository.verifyScriptPath(a.state.missionId, a.generation);
				let verifyNames = task?.verify ?? [];
				if (a.state.tier === "complex" && task && isLastTaskOfMilestone(a.plan, task.id)) {
					const milestone = findMilestoneOf(a.plan, task.id);
					verifyNames = [...new Set(milestone!.tasks.flatMap((t) => t.verify))];
				}
				requiredAcIds = verifyNames;
				for (const name of verifyNames) {
					await runHard(
						name,
						`bash ${script} ${name}`,
						"bash",
						[script, name],
						600_000,
						fp,
					);
					if (!isCurrent()) return;
				}
				await runIndependentVerifier(fp, async () =>
					renderVerifierBrief({
						goal: a.plan.goal,
						taskId: task?.id ?? "",
						taskTitle: task?.title ?? "",
						acceptanceCriteria: a.plan.acceptanceCriteria,
						// 与 runVerifier 的 expectedAcIds 同一个数组:简报和校验必须同源,
						// 各自取数就会漂,而漂了是静默降级 hard-only(见 renderVerifierBrief)
						expectedAcIds: requiredAcIds,
						hardResults,
						diff: await this.gitDiff(),
					}),
				);
			}

			if (!isCurrent()) return;
			persistCheck({ stage: "judging", summary: "正在生成最终判定..." });
			const verdict = judge(evidences, {
				expectedFingerprint: a.state.envFingerprint,
				requiredAcIds,
			});
			if (!a.inMemory) saveEvidence(sp.evidenceDir, taskId, attempt, evidences);
			persistCheck({
				stage: "completed",
				outcome: verdict.outcome,
				summary: `判定完成: ${verdict.outcome.toUpperCase()}`,
			});
			if (!isCurrent()) return;
			this.pi.appendEntry("missions-verdict", {
				missionId: a.state.missionId,
				taskId,
				attempt,
				verdict,
				evidences: evidences.map((e) => ({
					level: e.level,
					acId: e.acId,
					result: e.result,
					exitCode: e.exitCode,
					durationMs: e.durationMs,
					rawTail: e.result === "fail" ? tail(e.raw, 600) : undefined,
				})),
			});
			const result = await this.applyEvent({ type: "VERDICT", at: Date.now(), verdict }, ctx);
			if (result.error) return;

			const state = this.active!.state;
			if (state.pendingHandoff) return;
			if (state.phase === "act") {
				this.pi.sendUserMessage(renderActBrief(a.plan, state), { deliverAs: "followUp" });
			} else if (state.phase === "do") {
				this.pi.sendUserMessage(renderDoBrief(a.plan, state, this.currentSpikeReport()?.rel), {
					deliverAs: "followUp",
				});
			}
		} catch (error) {
			if (!isCurrent()) return;
			const message = error instanceof Error ? error.message : String(error);
			if (!a.inMemory) appendLog(sp.logMd, `CHECK ERROR ${message}`);
			ctx.ui.notify(`CHECK 执行异常:${message}`, "error");
			if (isCurrent()) {
				persistCheck({ stage: "error", error: message, summary: `判定异常: ${message}` });
				const errorEvidence: Evidence = {
					level: "hard",
					acId: "check-runtime",
					result: "inconclusive",
					raw: message,
					envFingerprint: a.state.envFingerprint ?? undefined,
					command: checkState.currentBranch,
					startedAt: Date.now(),
					durationMs: 0,
					stdout: "",
					stderr: message,
				};
				evidences.push(errorEvidence);
				try {
					if (!a.inMemory) saveEvidence(sp.evidenceDir, taskId, attempt, evidences);
				} catch {
					/* CHECK.json 与 LOG.md 已保留异常,归档失败不阻断状态恢复 */
				}
				const verdict = judge(evidences, {
					expectedFingerprint: a.state.envFingerprint,
					requiredAcIds,
				});
				const result = await this.applyEvent({ type: "VERDICT", at: Date.now(), verdict }, ctx);
				if (!result.error && result.state.phase === "do") {
					this.pi.sendUserMessage(renderDoBrief(a.plan, result.state, this.currentSpikeReport()?.rel), {
						deliverAs: "followUp",
					});
				}
			}
		} finally {
			this.refreshWidget(ctx);
		}
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
		const record = a.handoff;
		if (!record) return { error: "换脑状态损坏:缺少 handoff token" };
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
			const body = [
				`目标:${goal}`,
				"",
				"完成条件(PLAN 会把每条翻译成一个 verify 分支):",
				...doneWhen.map((d) => `  ${d.id}: ${d.text}`),
				...(definition.nonGoals.length ? ["", "明确不做:", ...definition.nonGoals.map((n) => `  - ${n}`)] : []),
				...(definition.constraints.length ? ["", "已确认的约束:", ...definition.constraints.map((c) => `  - ${c}`)] : []),
				...(definition.verifySeam ? ["", `验证接缝:${definition.verifySeam}`] : []),
				"",
				"确认这个范围?",
			].join("\n");
			const confirmed = await ctx.ui.confirm("pi-missions · 确认范围", body);
			if (!confirmed) {
				if (!a.inMemory) {
					appendLog(statePaths(this.layout, a.state.missionId).logMd, "DEFINE 范围确认被拒,停留在 DEFINE");
				}
				return {
					error:
						"人工拒绝了这个范围定义。根据他们的说明改 goal / doneWhen / nonGoals 后重新调用 mission_define。" +
						"注意:提问轮次不会返还。",
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
		const envFingerprint = await computeEnvFingerprint(this.exec, this.cwd, envFingerprintSh(this.layout));
		const r = await this.applyEvent(
			{
				type: "PLAN_FROZEN",
				at: Date.now(),
				taskOrder: taskOrder(plan),
				spikes: spikeTaskIds(plan),
				envFingerprint,
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

	private ensureStateExcludes(): void {
		const base = `${this.config.missionsDir}/state`;
		for (const pattern of [
			`${base}/CURRENT`,
			`${base}/*/SNAPSHOT.json`,
			`${base}/*/CHECK.json`,
			`${base}/*/LOG.md`,
			`${base}/*/profile.json`,
			`${base}/*/evidence/`,
			`${base}/*/archive/`,
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

	private async gitDiff(): Promise<string> {
		const r = await this.exec("git", ["-c", "core.pager=cat", "diff", "HEAD", "--stat"], { timeout: 30_000 });
		const d = await this.exec("git", ["-c", "core.pager=cat", "diff", "HEAD"], { timeout: 30_000 });
		return tail(`${r.stdout}\n\n${d.stdout}`, DIFF_TAIL);
	}

	private warn(ctx: any, msg: string): void {
		ctx.ui.notify(msg, "warning");
		if (this.active) appendLog(statePaths(this.layout, this.active.state.missionId).logMd, `WARN ${msg}`);
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

	/**
	 * 人工终审。三条纪律,少一条 human 证据就退化成 soft(执行者自述)的变体:
	 *
	 *  1. **没有默认值**。做成"回车即过"的话,人没看,只是按了键 —— 那不是 I3
	 *     意义上的外部判定。取消/超时一律不产出证据,由 judge() 的规则 4 判
	 *     inconclusive,而不是判 pass。
	 *  2. **fail 必须给理由**,理由进 LOG。签名不用这句话算(措辞每次都变),
	 *     用固定串,见 breaker.ts 的 canonicalOf。
	 *  3. **记账为不可重放**。写进证据的 command 字段,面板与 LOG 都能看到
	 *     这条判据没有留下能重跑的东西。
	 */
	private async collectHumanVerdict(
		ctx: any,
		criterionText: string,
		evidences: Evidence[],
		envFingerprint: string,
		persistCheck: (patch: any) => void,
	): Promise<void> {
		persistCheck({
			stage: "running_verifier",
			summary: "等待人工终审...",
			verifier: { status: "skipped", message: "人工终审(不可重放)" },
		});
		this.refreshWidget(ctx);
		const startedAt = Date.now();
		const PASS = "通过 —— 收工";
		const FAIL = "不通过 —— 我来说哪里不对";
		let choice: string | undefined;
		if (ctx.hasUI) {
			choice = await ctx.ui.select(`人工终审:${criterionText}`, [PASS, FAIL]);
		} else {
			ctx.ui.notify("当前环境无法弹出人工终审(非 TUI),本轮判为无结论", "warning");
		}
		// 没做选择 ≠ 通过。不产出证据,让 judge() 判 inconclusive
		if (choice !== PASS && choice !== FAIL) return;

		const passed = choice === PASS;
		let reason = "人工终审通过";
		if (!passed) {
			const said = ctx.hasUI ? await ctx.ui.input("哪里不对?", "一句话说明,会写进 LOG") : undefined;
			reason = said?.trim() || "人工终审未通过(未说明原因)";
		}
		evidences.push({
			level: "human",
			acId: "quick",
			result: passed ? "pass" : "fail",
			raw: reason,
			envFingerprint,
			command: "人工终审(不可重放)",
			startedAt,
			durationMs: Date.now() - startedAt,
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

const QUICK_JUDGE_LABEL: Record<QuickCriterion["judge"], string> = {
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

function renderActBrief(plan: MissionPlan, state: MissionState): string {
	const t = state.currentTask ? state.tasks[state.currentTask] : undefined;
	return [
		`[pi-missions] 进入 ACT:${state.currentTask} 第 ${t?.attempts ?? "?"} 次尝试验证失败。`,
		`失败:${t?.lastFailureReason ?? "见 LOG.md"}`,
		"分析失败性质并给出下一轮的修法(实现问题),或调用 mission_escalate 升级(方案/问题定义问题)。你只有这一轮,不能写代码。",
	].join("\n");
}

function renderHandoffBrief(
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

function slugify(goal: string): string {
	const ascii = goal
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40);
	return ascii || `mission-${Date.now().toString(36)}`;
}

function tail(s: string, n: number): string {
	return s.length > n ? s.slice(-n) : s;
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

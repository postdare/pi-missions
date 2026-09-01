/**
 * pi-missions · runtime
 *
 * core(裁判)与 pi(执行面)之间的哑管道:
 *   采集证据 → judge → 发事件给 machine → 把产出的 Effect 翻译成 pi API 调用。
 * 不做任何判定 —— 所有"对不对/升不升/停不停"的决定都在 core 里。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { Effect, MissionEvent, MissionState, Phase, Role, Tier, TransitionResult, Evidence } from "./core/types.ts";
import { initialState, transition, ROLE_OF } from "./core/machine.ts";
import { judge } from "./core/verdict.ts";
import { evaluateAdmission, evaluatePromotion } from "./core/tier.ts";
import { evaluateBaseline, shouldProbeBaseline, type BaselineProbe } from "./core/baseline.ts";
import { evaluateAsk } from "./core/frame.ts";
import { reportIsSubstantive, validateSpikePlan } from "./core/spike.ts";
import type { MissionPlan } from "./store/mission.ts";
import {
	allTasks,
	findMilestoneOf,
	findTask,
	isLastTaskOfMilestone,
	parseMissionMd,
	renderMilestoneMd,
	renderMissionMd,
	spikeTaskIds,
	taskOrder,
	validatePlan,
} from "./store/mission.ts";
import { loadConfig, matchGlob, type MissionsConfig } from "./store/config.ts";
import {
	currentPointer,
	envFingerprintSh,
	layout,
	modelsJson,
	planPaths,
	spikeReport,
	statePaths,
	verifySh,
	verifierToolsTs,
	type RepoLayout,
} from "./store/paths.ts";
import { ensureScaffold } from "./store/scaffold.ts";
import { loadStateFile, readCurrentPointer, saveStateFile, writeCurrentPointer } from "./store/state.ts";
import { appendLog } from "./store/log.ts";
import { computeEnvFingerprint, ensureInfoExclude, isGitRepo } from "./store/git.ts";
import { saveEvidence } from "./store/evidence.ts";
import { renderWidgetCard } from "./ui/dashboard.ts";
import {
	applyRole,
	loadModelsConfig,
	profileFromJson,
	profileToJson,
	restoreProfile,
	saveProfile,
	type ModelsConfig,
	type SavedProfile,
} from "./roles/models.ts";
import { renderSpikeVerifierBrief, renderVerifierBrief, runVerifier } from "./roles/verifier.ts";
import { BUILTIN_ALL, gateCheck, MISSION_TOOLS, toolsForPhase } from "./hooks/gate.ts";
import { IncrementalDiagnostics } from "./hooks/diagnostics.ts";

export interface ActiveMission {
	plan: MissionPlan;
	state: MissionState;
	/** quick 档升 standard 前:计划与状态只在内存(Q18) */
	inMemory: boolean;
	/** 目标目录是 git 仓库(降级模式=false 时 AC 冻结有 git 审计链) */
	git: boolean;
	/** quick 档判定的唯一依据。必须在进 DO 前定下(--verify),不接受事后补 */
	quickVerifyCommand?: string;
}

/** 换脑后给新会话的第一句推动语。按落点相位分流 —— 换脑不只发生在 DO */
const HANDOFF_NUDGE: Record<string, string> = {
	frame: "开始重新定义问题",
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
	private metricsDirty = 0;

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
		if (git) ensureInfoExclude(this.cwd, `${this.config.missionsDir}/state/`);

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
		this.active = { plan, state: initialState({ missionId: id, tier, taskOrder: [] }), inMemory: false, git };
		await this.persist();
		writeCurrentPointer(currentPointer(l), id);
		this.savedProfile = saveProfile(this.pi, ctx);
		this.persistProfile();
		const phase = this.active.state.phase; // standard/complex 起于 FRAME(见 core/machine START_PHASE)
		this.pi.setActiveTools(toolsForPhase(phase));
		const role = ROLE_OF[phase];
		if (role) await applyRole(this.pi, ctx, role, this.modelsConfig(), (m) => this.warn(ctx, m));
		this.refreshWidget(ctx);
		return { id, phase };
	}

	/**
	 * /mission quick:单任务,不落盘,直接进 DO(Q18)。
	 *
	 * 准入由 core 判定(evaluateAdmission):没有验证命令就没有裁判,
	 * 这种输入不进快车道,自动升 standard 去 PLAN 相位把标准写清楚。
	 */
	async startQuick(
		ctx: any,
		task: string,
		verifyCommand?: string,
	): Promise<{ id: string; tier: Tier } | { error: string }> {
		if (this.busy()) return { error: "已有进行中的 mission,先 /mission abort" };

		const cmd = verifyCommand?.trim();
		const admission = evaluateAdmission({ tier: "quick", hasVerifyCommand: !!cmd });
		if (!admission.ok) {
			const promoted = admission.promoteTo === "complex" ? "complex" : "standard";
			const r = await this.startNew(ctx, task, promoted);
			if ("error" in r) return r;
			ctx.ui.notify(admission.reason, "warning");
			return { id: r.id, tier: promoted };
		}

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
			quickVerifyCommand: cmd,
		};
		this.savedProfile = saveProfile(this.pi, ctx);
		const r = await this.applyEvent({ type: "PLAN_FROZEN", at: Date.now(), taskOrder: ["T1"] }, ctx);
		if (r.error) return { error: r.error };
		return { id, tier: "quick" };
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
		const l = this.layout;
		const pp = planPaths(l, missionId);
		const sp = statePaths(l, missionId);
		const md = fs.existsSync(pp.missionMd) ? fs.readFileSync(pp.missionMd, "utf8") : null;
		const plan = md ? parseMissionMd(md) : null;
		if (!plan) return { error: `找不到 ${missionId} 的 MISSION.md(或 fence 损坏)。quick 档不落盘,无法恢复。` };
		const state = loadStateFile(sp.stateJson);
		if (!state) return { error: `找不到 ${missionId} 的 STATE.json` };

		// check 是 L0 瞬时相位,act 依赖上一轮对话 —— 恢复时统一落回 do(attempts 不变)
		if (state.phase === "check" || state.phase === "act") state.phase = "do";
		if (opts.clearPendingHandoff) state.pendingHandoff = null;

		ensureScaffold(l);
		this.active = { plan, state, inMemory: false, git: await isGitRepo(this.exec, this.cwd) };
		writeCurrentPointer(currentPointer(l), missionId);
		// 用户现场(thinking/模型)随 mission 持久化;已有则以磁盘为准(跨会话接力)
		this.savedProfile = this.loadProfile() ?? saveProfile(this.pi, ctx);
		this.persistProfile();
		this.pi.setActiveTools(toolsForPhase(state.phase));
		const role = ROLE_OF[state.phase];
		if (role) await applyRole(this.pi, ctx, role, this.modelsConfig(), (m) => this.warn(ctx, m));
		this.refreshWidget(ctx);
		return { ok: true };
	}

	/** 驱动类命令入口:内存丢了就从磁盘悄悄接上(CURRENT 指针)。 */
	async ensureAttached(ctx: any): Promise<boolean> {
		if (this.active) return true;
		const id = readCurrentPointer(currentPointer(this.layout));
		if (!id) return false;
		const r = await this.attach(ctx, id, { clearPendingHandoff: false });
		return "ok" in r;
	}

	/** session_start:换脑接力(磁盘 handshake)或提示恢复 */
	async onSessionStart(ctx: any): Promise<void> {
		if (this.active?.state.pendingHandoff) {
			// 同进程接力(若 runner 未重建)
			await this.applyEvent(
				{ type: "HANDOFF_DONE", at: Date.now(), sessionFile: safeSessionFile(ctx) },
				ctx,
			);
			this.pi.setActiveTools(toolsForPhase(this.active.state.phase));
			const role = ROLE_OF[this.active.state.phase];
			if (role) await applyRole(this.pi, ctx, role, this.modelsConfig(), (m) => this.warn(ctx, m));
			this.refreshWidget(ctx);
			return;
		}
		if (this.active) {
			// 同进程会话切换:重挂闸门即可
			this.pi.setActiveTools(toolsForPhase(this.active.state.phase));
			this.refreshWidget(ctx);
			return;
		}
		// 全新实例:newSession 会重建扩展 runner,内存态必丢 —— 从磁盘恢复
		const id = readCurrentPointer(currentPointer(this.layout));
		if (!id) return;
		const sp = statePaths(this.layout, id);
		const s = loadStateFile(sp.stateJson);
		if (!s || s.phase === "done" || s.phase === "halted") return;
		if (s.pendingHandoff) {
			// 这个全新会话就是换脑要的干净上下文:接上并完成握手
			const r = await this.attach(ctx, id, { clearPendingHandoff: false });
			if ("error" in r) return;
			await this.applyEvent(
				{ type: "HANDOFF_DONE", at: Date.now(), sessionFile: safeSessionFile(ctx) },
				ctx,
			);
			this.refreshWidget(ctx);
			return;
		}
		// 进程重启且不在换脑途中:不自动接管,避免劫持不相干的会话
		ctx.ui.notify(`检测到未完成的 mission "${id}"(${s.phase}),/mission resume ${id} 恢复`, "info");
	}

	// ─────────────────────────── 事件应用与效果翻译 ───────────────────────────

	async applyEvent(ev: MissionEvent, ctx: any): Promise<TransitionResult> {
		if (!this.active) return { state: null as never, effects: [], error: "无活动 mission" };
		const r = transition(this.active.state, ev);
		if (r.error) {
			if (!this.active.inMemory) {
				appendLog(statePaths(this.layout, this.active.state.missionId).logMd, `EVENT ${ev.type} rejected: ${r.error}`);
			}
			return r;
		}
		this.active.state = r.state;
		await this.persist();
		await this.translateEffects(r.effects, ctx);
		this.refreshWidget(ctx);
		return r;
	}

	private async translateEffects(effects: Effect[], ctx: any): Promise<void> {
		for (const e of effects) {
			switch (e.type) {
				case "SET_TOOLS":
					this.pi.setActiveTools(toolsForPhase(e.phase));
					break;
				case "SET_ROLE":
					await applyRole(this.pi, ctx, e.role, this.modelsConfig(), (m) => this.warn(ctx, m));
					break;
				case "HANDOFF":
					ctx.ui.notify(`需要换脑(${e.reason}):正在自触发 /mission next;若未生效请手动执行`, "warning");
					if (!this.suppressHandoffFollowUp) {
						this.pi.sendUserMessage("/mission next", { deliverAs: "followUp" });
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
		const l = this.layout;
		const sp = statePaths(l, a.state.missionId);
		a.state.envFingerprint = await computeEnvFingerprint(this.exec, this.cwd, envFingerprintSh(l));
		a.state.sessionMap[a.state.currentTask ?? ""] = safeSessionFile(ctx);
		await this.persist();
		if (a.git) {
			ctx.ui.notify(`AC 已冻结。建议提交:${this.config.missionsDir}/plans/${a.state.missionId}/ 与 verify.sh`, "info");
		} else {
			ctx.ui.notify("非 git 仓库:AC 冻结仅靠 L0 闸门,无 git 审计链(降级模式)", "warning");
		}
		appendLog(sp.logMd, `env fingerprint=${a.state.envFingerprint}`);
	}

	/** 探针任务开始前先把结论目录建好,免得执行者第一次写文件就撞在 ENOENT 上 */
	private ensureSpikeDir(): void {
		const s = this.currentSpikeReport();
		if (s) fs.mkdirSync(path.dirname(s.abs), { recursive: true });
	}

	private async persistPlanFiles(): Promise<void> {
		const a = this.active!;
		const l = this.layout;
		ensureScaffold(l);
		const pp = planPaths(l, a.plan.missionId);
		fs.mkdirSync(pp.dir, { recursive: true });
		fs.writeFileSync(pp.missionMd, renderMissionMd(a.plan), "utf8");
		if (a.plan.tier === "complex") {
			for (const ms of a.plan.milestones) {
				fs.writeFileSync(pp.milestoneFile(ms.id), renderMilestoneMd(a.plan, ms), "utf8");
			}
		}
		this.writeVerifyScript(a.plan);
		a.inMemory = false;
		writeCurrentPointer(currentPointer(l), a.plan.missionId);
		if (a.git) ensureInfoExclude(this.cwd, `${this.config.missionsDir}/state/`);
		await this.persist();
	}

	private archivePlan(reason: string): void {
		const a = this.active!;
		const l = this.layout;
		const pp = planPaths(l, a.plan.missionId);
		const sp = statePaths(l, a.plan.missionId);
		if (!fs.existsSync(pp.missionMd)) return;
		fs.mkdirSync(sp.archiveDir, { recursive: true });
		const dest = path.join(sp.archiveDir, `MISSION-${Date.now()}.md`);
		fs.copyFileSync(pp.missionMd, dest);
		appendLog(sp.logMd, `plan archived → ${path.relative(this.cwd, dest)} (${reason})`);
	}

	// ─────────────────────────── CHECK:L0 亲自判定(Q9) ───────────────────────────

	async runCheck(ctx: any): Promise<void> {
		const a = this.active;
		if (!a || a.state.phase !== "check" || !a.state.currentTask) return;
		const task = findTask(a.plan, a.state.currentTask);
		const l = this.layout;
		const evidences: Evidence[] = [];
		const fp = await computeEnvFingerprint(this.exec, this.cwd, envFingerprintSh(l));

		let requiredAcIds: string[] = [];
		let hardResults: Array<{ acId: string; pass: boolean; outputTail: string }> = [];

		const spike = this.currentSpikeReport();
		if (spike) {
			// 探针的判定:hard = 结论文件够不够实(机械、零模型成本);
			// semi = 独立验证者核对它有没有真的回答那个问题。
			const report = fs.existsSync(spike.abs) ? fs.readFileSync(spike.abs, "utf8") : null;
			const substantive = reportIsSubstantive(report);
			requiredAcIds = ["spike"];
			evidences.push({
				level: "hard",
				acId: "spike",
				result: substantive ? "pass" : "fail",
				raw: substantive
					? `结论文件 ${spike.rel}(${report!.trim().length} 字)`
					: `结论文件 ${spike.rel} 缺失或过短 —— 探针的产出就是这份结论`,
				exitCode: substantive ? 0 : 1,
				envFingerprint: fp,
			});

			if (substantive && a.git && fs.existsSync(verifierToolsTs(l))) {
				const semi = await runVerifier(this.exec, {
					cwd: this.cwd,
					toolsPath: verifierToolsTs(l),
					provider: this.modelsConfig().verifier?.provider,
					model: this.modelsConfig().verifier?.model,
					timeoutMs: this.config.verifierTimeoutMs ?? 300_000,
					envFingerprint: fp,
					brief: renderSpikeVerifierBrief({
						goal: a.plan.goal,
						taskId: task?.id ?? "",
						question: task?.question ?? "",
						report: tail(report!, EVIDENCE_TAIL),
						diff: await this.gitDiff(),
					}),
				});
				if (semi) evidences.push(...semi);
			}
		} else if (a.state.tier === "quick") {
			// quick 档:验证命令在 startQuick 时就已冻结(无命令的输入会被升档挡在 DO 之外)
			const cmd = a.quickVerifyCommand;
			if (cmd) {
				requiredAcIds = ["quick"];
				const r = await this.exec("bash", ["-c", cmd], { timeout: 300_000 });
				evidences.push({
					level: "hard",
					acId: "quick",
					result: r.code === 0 ? "pass" : "fail",
					raw: tail(`${r.stdout}\n${r.stderr}`, EVIDENCE_TAIL),
					exitCode: r.code,
					envFingerprint: fp,
				});
				hardResults = [{ acId: "quick", pass: r.code === 0, outputTail: tail(`${r.stdout}\n${r.stderr}`, 800) }];
			}
		} else {
			// standard/complex:L0 直接执行 verify.sh 分支
			let verifyNames = task?.verify ?? [];
			// complex 档里程碑回归:里程碑最后一个任务要重跑整个里程碑的分支
			if (a.state.tier === "complex" && task && isLastTaskOfMilestone(a.plan, task.id)) {
				const ms = findMilestoneOf(a.plan, task.id);
				verifyNames = [...new Set(ms!.tasks.flatMap((t) => t.verify))];
			}
			requiredAcIds = verifyNames;
			for (const name of verifyNames) {
				const r = await this.exec("bash", [verifySh(l), name], { timeout: 600_000 });
				const output = tail(`${r.stdout}\n${r.stderr}`, EVIDENCE_TAIL);
				evidences.push({
					level: "hard",
					acId: name,
					result: r.code === 0 ? "pass" : "fail",
					raw: output,
					exitCode: r.code,
					envFingerprint: fp,
				});
				hardResults.push({ acId: name, pass: r.code === 0, outputTail: tail(output, 800) });
			}

			// semi 证据:独立 Verifier 子进程(需要 git diff;降级模式跳过)
			if (a.git && fs.existsSync(verifierToolsTs(l))) {
				const diff = await this.gitDiff();
				const semi = await runVerifier(this.exec, {
					cwd: this.cwd,
					toolsPath: verifierToolsTs(l),
					provider: this.modelsConfig().verifier?.provider,
					model: this.modelsConfig().verifier?.model,
					timeoutMs: this.config.verifierTimeoutMs ?? 300_000,
					envFingerprint: fp,
					brief: renderVerifierBrief({
						goal: a.plan.goal,
						taskId: task?.id ?? "",
						taskTitle: task?.title ?? "",
						acceptanceCriteria: a.plan.acceptanceCriteria,
						hardResults,
						diff,
					}),
				});
				if (semi) evidences.push(...semi);
				else if (!a.inMemory)
					appendLog(
						statePaths(l, a.state.missionId).logMd,
						"verifier subprocess unavailable → hard-only verdict",
					);
			}
		}

		const verdict = judge(evidences, { expectedFingerprint: a.state.envFingerprint, requiredAcIds });
		const sp = statePaths(l, a.state.missionId);
		const taskState = a.state.tasks[a.state.currentTask];
		if (!a.inMemory) {
			saveEvidence(sp.evidenceDir, a.state.currentTask, taskState?.attempts ?? 1, evidences);
		}
		this.pi.appendEntry("missions-verdict", {
			missionId: a.state.missionId,
			taskId: a.state.currentTask,
			attempt: taskState?.attempts ?? 1,
			verdict,
			evidences: evidences.map((e) => ({
				level: e.level,
				acId: e.acId,
				result: e.result,
				exitCode: e.exitCode,
				// 失败证据附带原始输出尾部:卡片不进 LLM 上下文,可以详细
				rawTail: e.result === "fail" ? tail(e.raw, 600) : undefined,
			})),
		});

		const r = await this.applyEvent({ type: "VERDICT", at: Date.now(), verdict }, ctx);
		if (r.error) return;

		// 推进对话:让循环继续转起来
		const s = this.active!.state;
		if (s.pendingHandoff) return; // HANDOFF 效果已自触发 /mission next
		if (s.phase === "act") {
			this.pi.sendUserMessage(renderActBrief(a.plan, s), { deliverAs: "followUp" });
		} else if (s.phase === "do") {
			this.pi.sendUserMessage(renderDoBrief(a.plan, s, this.currentSpikeReport()?.rel), { deliverAs: "followUp" });
		}
	}

	// ─────────────────────────── tick(agent_settled 内层循环) ───────────────────────────

	async onAgentSettled(ctx: any): Promise<void> {
		const a = this.active;
		if (!a) return;
		const phase = a.state.phase;

		if (phase === "check") {
			await this.runCheck(ctx);
			return;
		}

		if (phase === "act") {
			// ACT = 一轮诊断对话,结束后自动回 DO(L1 改实现)
			const r = await this.applyEvent({ type: "ADJUST_DONE", at: Date.now() }, ctx);
			if (!r.error && !a.state.pendingHandoff) {
				this.pi.sendUserMessage(renderDoBrief(a.plan, a.state, this.currentSpikeReport()?.rel), { deliverAs: "followUp" });
			}
			return;
		}

		if (phase === "do" || phase === "plan" || phase === "frame") {
			// 机械升档(升档自动,降档手动)
			const promo = evaluatePromotion({
				tier: a.state.tier,
				currentTask: a.state.currentTask ? (a.state.tasks[a.state.currentTask] ?? null) : null,
				touchedFiles: a.state.metrics.touchedFiles.length,
				touchedPublicApi: a.state.metrics.touchedPublicApi,
				escalations: a.state.escalation.history.length,
			});
			if (promo) {
				await this.applyEvent({ type: "PROMOTE_TIER", at: Date.now(), to: promo.to, reason: promo.reason }, ctx);
				return;
			}
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

	// ─────────────────────────── tool_result:指标 + 编辑级反馈 ───────────────────────────

	onToolResult(event: { toolName: string; input: Record<string, unknown>; isError: boolean }, ctx: any): void {
		const a = this.active;
		if (!a) return;
		if ((event.toolName === "edit" || event.toolName === "write") && !event.isError) {
			const p = String(event.input.path ?? "");
			if (p && !a.state.metrics.touchedFiles.includes(p)) {
				a.state.metrics.touchedFiles.push(p);
				if ((this.config.publicApiGlobs ?? []).some((g) => matchGlob(p, g))) {
					a.state.metrics.touchedPublicApi = true;
				}
				if (++this.metricsDirty >= 5) {
					this.metricsDirty = 0;
					void this.persist();
				}
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

	/** message_end:按角色分账(成本是调模型策略的唯一依据) */
	onMessageEnd(message: any): void {
		const a = this.active;
		if (!a || message?.role !== "assistant") return;
		const total = message?.usage?.cost?.total;
		if (typeof total !== "number" || total <= 0) return;
		const role = ROLE_OF[a.state.phase];
		if (!role) return;
		a.state.cost[role] = (a.state.cost[role] ?? 0) + total;
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
				await this.applyEvent({ type: "HANDOFF_REQUEST", at: Date.now(), reason: "人工主动换脑" }, ctx);
			} finally {
				this.suppressHandoffFollowUp = false;
			}
		}
		const brief = renderHandoffBrief(
			a.plan,
			{ ...a.state, pendingHandoff: null },
			this.config.missionsDir,
		);
		const parentSession = safeSessionFile(ctx);
		await ctx.newSession({
			parentSession,
			setup: async (sm: any) => {
				sm.appendMessage({ role: "user", content: [{ type: "text", text: brief }], timestamp: Date.now() });
			},
			withSession: async (ctx2: any) => {
				// ⚠️ 只能用 ctx2:外层捕获的 pi/ctx 在会话替换后已失效
				await ctx2.sendUserMessage(HANDOFF_NUDGE[a.state.phase] ?? "继续当前相位的工作");
			},
		});
		return { ok: true };
	}

	// ─────────────────────────── FRAME(mission_ask / mission_frame) ───────────────────────────

	/**
	 * FRAME 提问。预算判定在 core(evaluateAsk):一个 mission 只许问一轮、最多 3 个。
	 * 问题以卡片呈现给人,本轮到此为止 —— 回答由人以普通消息给出。
	 */
	async ask(ctx: any, questions: string[]): Promise<{ ok: true; questions: string[] } | { error: string }> {
		const a = this.active;
		if (!a) return { error: "无活动 mission" };
		if (a.state.phase !== "frame") return { error: `当前相位是 ${a.state.phase},只有 frame 相位可以提问` };

		const verdict = evaluateAsk({ askedRounds: a.state.frameAsks ?? 0, questions });
		if (!verdict.ok) return { error: verdict.reason };

		const r = await this.applyEvent({ type: "FRAME_ASKED", at: Date.now() }, ctx);
		if (r.error) return { error: r.error };

		this.pi.appendEntry("missions-card", {
			title: `${a.state.missionId} · 需要你回答(${verdict.questions.length} 个)`,
			body: verdict.questions.map((q, i) => `${i + 1}. ${q}`).join("\n"),
		});
		if (!a.inMemory) {
			appendLog(
				statePaths(this.layout, a.state.missionId).logMd,
				`FRAME 提问:${verdict.questions.map((q) => q.replace(/\s+/g, " ")).join(" / ")}`,
			);
		}
		return { ok: true, questions: verdict.questions };
	}

	/** FRAME 完成:锐化目标 + 边界写进 plan,进入 PLAN 相位 */
	async frame(
		ctx: any,
		params: { goal: string; constraints: string[]; nonGoals: string[] },
	): Promise<{ ok: true } | { error: string }> {
		const a = this.active;
		if (!a) return { error: "无活动 mission" };
		if (a.state.phase !== "frame") return { error: `当前相位是 ${a.state.phase},只有 frame 相位可以定义问题` };
		const goal = params.goal?.trim();
		if (!goal) return { error: "goal 为空:FRAME 的产出就是一句说得清的目标" };

		a.plan = {
			...a.plan,
			goal,
			framing: { constraints: params.constraints ?? [], nonGoals: params.nonGoals ?? [], at: Date.now() },
		};
		const r = await this.applyEvent({ type: "FRAME_DONE", at: Date.now() }, ctx);
		if (r.error) return { error: r.error };
		if (!a.inMemory) {
			appendLog(statePaths(this.layout, a.state.missionId).logMd, `FRAME 定义:${goal.replace(/\s+/g, " ")}`);
		}
		return { ok: true };
	}

	// ─────────────────────────── 提交计划(mission_write_plan) ───────────────────────────

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
		// 探针的额度是 mission 级的,validatePlan(纯函数、只看计划)判不了,放在这里
		errors.push(
			...validateSpikePlan({
				spikeTaskIds: spikeTaskIds(plan),
				alreadyRanSpike: (a.state.spikesRun ?? 0) > 0,
			}),
		);
		if (errors.length > 0) return { error: `计划不合法:\n${errors.map((e) => `- ${e}`).join("\n")}` };

		// PLAN 冻结前人工确认 —— 最重要的一次介入(§7.4)
		if (ctx.hasUI) {
			const acLines = plan.acceptanceCriteria.map((c) => `  ${c.id} (verify: ${c.verify}): ${c.text}`).join("\n");
			const confirmed = await ctx.ui.confirm(
				"pi-missions · 冻结验收标准",
				`目标:${plan.goal}\n\n验收标准(冻结后只读):\n${acLines}\n\n任务数:${taskOrder(plan).length} · 档位:${plan.tier}\n\n确认冻结?`,
			);
			if (!confirmed) return { error: "人工拒绝了计划。请根据反馈修改后重新调用 mission_write_plan。" };
		}

		// 基线跑:AC 指向的分支存在还不够,它现在必须是红的(空壳分支在这里被打回)。
		// 放在人工确认之后 —— PLAN 相位不执行任何东西,这一跑属于进入 DO 的过渡动作,
		// 且跑的是人刚刚批准的那份脚本。
		this.writeVerifyScript(plan);
		if (shouldProbeBaseline(a.state.escalation.history.length)) {
			const probes = await this.runBaseline(plan);
			const baselineErrors = evaluateBaseline(probes);
			this.logBaseline(probes, baselineErrors);
			if (baselineErrors.length > 0) {
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

		// 通过之后才认这份计划:被拒的 AC 不能留在 a.plan 里,
		// 否则下一轮 State Card 会把它当成"已冻结"喂给 planner
		a.plan = plan;
		await this.persistPlanFiles();
		const r = await this.applyEvent(
			{ type: "PLAN_FROZEN", at: Date.now(), taskOrder: taskOrder(plan), spikes: spikeTaskIds(plan) },
			ctx,
		);
		if (r.error) return { error: r.error };
		return { ok: true, taskOrder: taskOrder(plan) };
	}

	/** 逐条跑 AC 的 verify 分支,采集冻结时刻的基线退出码 */
	private async runBaseline(plan: MissionPlan): Promise<BaselineProbe[]> {
		const script = verifySh(this.layout);
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

	/** 单独落 verify.sh(基线跑要在冻结之前拿到脚本;persistPlanFiles 会再写一次,幂等) */
	private writeVerifyScript(plan: MissionPlan): void {
		if (!plan.verifyScript.trim()) return;
		const l = this.layout;
		ensureScaffold(l);
		fs.writeFileSync(verifySh(l), plan.verifyScript, "utf8");
		fs.chmodSync(verifySh(l), 0o755);
	}

	// ─────────────────────────── 杂项 ───────────────────────────

	modelsConfig(): ModelsConfig {
		return loadModelsConfig(modelsJson(this.layout));
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

	private async persist(): Promise<void> {
		const a = this.active;
		if (!a || a.inMemory) return;
		await saveStateFile(statePaths(this.layout, a.state.missionId).stateJson, a.state);
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
		// 主题化状态卡片(颜色/对齐/右对齐时长成本);widget width 不可信,再按 120 封顶
		ctx.ui.setWidget("missions", (_tui: any, theme: any) => ({
			render: (width: number) => renderWidgetCard(theme, a.plan, a.state, Date.now(), Math.min(width, 120)),
			invalidate: () => {},
		}));
	}
}

// ─────────────────────────── 渲染(纯函数,UI 层共用) ───────────────────────────

export function renderStateCard(plan: MissionPlan, state: MissionState, dirName = "missions"): string {
	const task = state.currentTask ? findTask(plan, state.currentTask) : undefined;
	const t = state.currentTask ? state.tasks[state.currentTask] : undefined;
	const acs =
		plan.acceptanceCriteria.length > 0
			? plan.acceptanceCriteria.map((c) => `  - ${c.id}: ./${dirName}/scripts/verify.sh ${c.verify} 退出码 0 —— ${c.text}`).join("\n")
			: plan.tier === "quick"
				? "  (quick 档:判定依据是 --verify 冻结的那条命令,提交时不可更改)"
				: "  (尚未冻结:本相位的产出就是可执行的 AC,由 mission_write_plan 提交)";
	const lines = [
		`[MISSION] ${state.missionId} · ${state.tier} · phase=${state.phase}` +
			(state.currentTask ? ` · task=${state.currentTask} · attempt=${t?.attempts ?? 0}` : ""),
		`GOAL: ${plan.goal}`,
		`AC(冻结,不可修改):`,
		acs,
	];
	if (plan.framing) {
		const f = plan.framing;
		if (f.constraints.length) lines.push(`约束(FRAME 已确认):${f.constraints.join(" · ")}`);
		if (f.nonGoals.length) lines.push(`不做:${f.nonGoals.join(" · ")}`);
	}
	if (task?.kind === "spike") {
		lines.push(
			`CURRENT TASK: ${task.id} ${task.title} —— 探针(spike),产出是书面结论,不是代码`,
			`  要回答:${task.question ?? ""}`,
			`  结论写到:./${dirName}/spikes/${state.missionId}/${task.id}.md(闸门只放行这一个文件)`,
			"  一次机会,不重试;提交后系统会带着结论回到 PLAN 重新规划。",
		);
	} else if (task) {
		lines.push(`CURRENT TASK: ${task.id} ${task.title}(verify: ${task.verify.join(", ") || "submit 时提供"})`);
	}
	if (t?.lastFailureReason) lines.push(`PREV FAILURE: ${t.lastFailureReason}`);
	if (state.pendingHandoff) lines.push(`⏸ 换脑挂起中:${state.pendingHandoff}。请执行 /mission next。`);
	if (state.phase === "frame") {
		lines.push(
			(state.frameAsks ?? 0) > 0
				? "提问机会已用完:根据已有回答调用 mission_frame;仍不足以定义就说明缺什么,由人重新描述。"
				: "先定义问题:读代码,必要时 mission_ask 问一轮(最多 3 个),然后 mission_frame。不要写代码或设计方案。",
		);
	}
	if (state.phase === "do" && task && task.kind !== "spike") {
		lines.push(`你只需完成 ${task.id}。完成后调用 mission_submit,不要自行判定通过。`);
	}
	return lines.join("\n");
}

function renderDoBrief(plan: MissionPlan, state: MissionState, spikeReportRel?: string | null): string {
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

function renderHandoffBrief(plan: MissionPlan, state: MissionState, dirName = "missions"): string {
	return [
		renderStateCard(plan, state, dirName),
		"",
		`工作流规则见 ${dirName}/README.md;当前相位规则见 ${dirName}/phases/${state.phase}.md。`,
		state.phase === "plan" ? `重规划:先读 ${dirName}/state 下该 mission 的 LOG.md 失败记录,再调用 mission_write_plan。` : "",
		state.phase === "frame"
			? `重新定义问题(L3):先读 ${dirName}/state 下该 mission 的 LOG.md 与 archive/ 里的旧 MISSION.md,` +
				"弄清原来的问题定义错在哪。提问预算已重置,可以再问一轮,然后调用 mission_frame。"
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

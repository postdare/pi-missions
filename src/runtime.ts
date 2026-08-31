/**
 * pi-missions · runtime
 *
 * core(裁判)与 pi(执行面)之间的哑管道:
 *   采集证据 → judge → 发事件给 machine → 把产出的 Effect 翻译成 pi API 调用。
 * 不做任何判定 —— 所有"对不对/升不升/停不停"的决定都在 core 里。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { Effect, MissionEvent, MissionState, Phase, Role, TransitionResult, Evidence } from "./core/types.ts";
import { initialState, transition, ROLE_OF } from "./core/machine.ts";
import { judge } from "./core/verdict.ts";
import { thresholdFor } from "./core/breaker.ts";
import { evaluatePromotion } from "./core/tier.ts";
import type { MissionPlan } from "./store/mission.ts";
import {
	allTasks,
	findMilestoneOf,
	findTask,
	isLastTaskOfMilestone,
	parseMissionMd,
	renderMilestoneMd,
	renderMissionMd,
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
import { applyRole, loadModelsConfig, restoreProfile, saveProfile, type ModelsConfig, type SavedProfile } from "./roles/models.ts";
import { renderVerifierBrief, runVerifier } from "./roles/verifier.ts";
import { BUILTIN_ALL, gateCheck, MISSION_TOOLS, toolsForPhase } from "./hooks/gate.ts";
import { IncrementalDiagnostics } from "./hooks/diagnostics.ts";

export interface ActiveMission {
	plan: MissionPlan;
	state: MissionState;
	/** quick 档升 standard 前:计划与状态只在内存(Q18) */
	inMemory: boolean;
	/** 目标目录是 git 仓库(降级模式=false 时 AC 冻结有 git 审计链) */
	git: boolean;
	/** quick 档:/mission quick --verify 给的默认验证命令 */
	quickVerifyCommand?: string;
}

const EVIDENCE_TAIL = 4000;
const DIFF_TAIL = 12000;

export class Runtime {
	active: ActiveMission | null = null;
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
	async startNew(ctx: any, goal: string, tier: "standard" | "complex"): Promise<{ id: string } | { error: string }> {
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
		this.pi.setActiveTools(toolsForPhase("plan"));
		await applyRole(this.pi, ctx, "planner", this.modelsConfig(), (m) => this.warn(ctx, m));
		this.refreshWidget(ctx);
		return { id };
	}

	/** /mission quick:单任务,不落盘,直接进 DO(Q18) */
	async startQuick(ctx: any, task: string, verifyCommand?: string): Promise<{ id: string } | { error: string }> {
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
			quickVerifyCommand: verifyCommand,
		};
		this.savedProfile = saveProfile(this.pi, ctx);
		const r = await this.applyEvent({ type: "PLAN_FROZEN", at: Date.now(), taskOrder: ["T1"] }, ctx);
		if (r.error) return { error: r.error };
		return { id };
	}

	/** /mission resume:从仓库重附着到当前会话(Q15) */
	async resume(ctx: any, missionId: string): Promise<{ ok: true } | { error: string }> {
		if (this.busy()) return { error: "已有进行中的 mission,先 /mission abort" };
		const l = this.layout;
		const pp = planPaths(l, missionId);
		const sp = statePaths(l, missionId);
		const md = fs.existsSync(pp.missionMd) ? fs.readFileSync(pp.missionMd, "utf8") : null;
		const plan = md ? parseMissionMd(md) : null;
		if (!plan) return { error: `找不到 ${missionId} 的 MISSION.md(或 fence 损坏)。quick 档不落盘,无法恢复。` };
		const state = loadStateFile(sp.stateJson);
		if (!state) return { error: `找不到 ${missionId} 的 STATE.json` };
		if (state.phase === "done") return { error: "该 mission 已完成" };

		// check 是 L0 瞬时相位,act 依赖上一轮对话 —— 恢复时统一落回 do(attempts 不变)
		if (state.phase === "check" || state.phase === "act") state.phase = "do";
		// 崩溃时可能停在换脑半途:进程重启本身就是干净上下文,换脑视为已完成
		state.pendingHandoff = null;

		ensureScaffold(l);
		this.active = { plan, state, inMemory: false, git: await isGitRepo(this.exec, this.cwd) };
		writeCurrentPointer(currentPointer(l), missionId);
		this.savedProfile = saveProfile(this.pi, ctx);
		this.pi.setActiveTools(toolsForPhase(state.phase));
		const role = ROLE_OF[state.phase];
		if (role) await applyRole(this.pi, ctx, role, this.modelsConfig(), (m) => this.warn(ctx, m));
		this.refreshWidget(ctx);
		return { ok: true };
	}

	/** session_start:有挂起的换脑 → 换脑完成;否则按 CURRENT 指针重建(同进程换脑场景) */
	async onSessionStart(ctx: any): Promise<void> {
		if (this.active?.state.pendingHandoff) {
			const r = await this.applyEvent(
				{ type: "HANDOFF_DONE", at: Date.now(), sessionFile: safeSessionFile(ctx) },
				ctx,
			);
			if (!r.error) {
				this.pi.setActiveTools(toolsForPhase(this.active.state.phase));
				const role = ROLE_OF[this.active.state.phase];
				if (role) await applyRole(this.pi, ctx, role, this.modelsConfig(), (m) => this.warn(ctx, m));
			}
			this.refreshWidget(ctx);
			return;
		}
		if (this.active) {
			// 同进程会话切换(switchSession/newSession 非换脑场景):重挂闸门即可
			this.pi.setActiveTools(toolsForPhase(this.active.state.phase));
			this.refreshWidget(ctx);
			return;
		}
		// 进程重启:不自动接管 —— 显式 /mission resume,避免用户打开别的活儿却被 mission 闸门拦住
		const id = readCurrentPointer(currentPointer(this.layout));
		if (id) {
			const sp = statePaths(this.layout, id);
			const s = loadStateFile(sp.stateJson);
			if (s && s.phase !== "done" && s.phase !== "halted") {
				ctx.ui.notify(`检测到未完成的 mission "${id}"(${s.phase}),/mission resume ${id} 恢复`, "info");
			}
		}
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
					break; // State Card 与 widget 已反映
				case "FREEZE_AC":
					await this.onFreezeAc(ctx);
					break;
				case "PERSIST_PLAN":
					await this.persistPlanFiles();
					break;
				case "ARCHIVE_PLAN":
					this.archivePlan(e.reason);
					break;
				case "RESTORE":
					this.pi.setActiveTools([...BUILTIN_ALL, ...MISSION_TOOLS]);
					await restoreProfile(this.pi, this.savedProfile);
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
		if (a.plan.verifyScript.trim()) {
			fs.writeFileSync(verifySh(l), a.plan.verifyScript, "utf8");
			fs.chmodSync(verifySh(l), 0o755);
		}
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

		if (a.state.tier === "quick") {
			// quick 档:验证命令来自 --verify 或 mission_submit 的参数(见 README 设计决议)
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
			evidences: evidences.map((e) => ({ level: e.level, acId: e.acId, result: e.result, exitCode: e.exitCode })),
		});

		const r = await this.applyEvent({ type: "VERDICT", at: Date.now(), verdict }, ctx);
		if (r.error) return;

		// 推进对话:让循环继续转起来
		const s = this.active!.state;
		if (s.pendingHandoff) return; // HANDOFF 效果已自触发 /mission next
		if (s.phase === "act") {
			this.pi.sendUserMessage(renderActBrief(a.plan, s), { deliverAs: "followUp" });
		} else if (s.phase === "do") {
			this.pi.sendUserMessage(renderDoBrief(a.plan, s), { deliverAs: "followUp" });
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
				this.pi.sendUserMessage(renderDoBrief(a.plan, a.state), { deliverAs: "followUp" });
			}
			return;
		}

		if (phase === "do" || phase === "plan") {
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
		const brief = renderHandoffBrief(a.plan, a.state, this.config.missionsDir);
		const parentSession = safeSessionFile(ctx);
		await ctx.newSession({
			parentSession,
			setup: async (sm: any) => {
				sm.appendMessage({ role: "user", content: [{ type: "text", text: brief }], timestamp: Date.now() });
			},
			withSession: async (ctx2: any) => {
				// ⚠️ 只能用 ctx2:外层捕获的 pi/ctx 在会话替换后已失效
				await ctx2.sendUserMessage("开始执行当前任务");
			},
		});
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

		a.plan = plan;
		await this.persistPlanFiles();
		const r = await this.applyEvent({ type: "PLAN_FROZEN", at: Date.now(), taskOrder: taskOrder(plan) }, ctx);
		if (r.error) return { error: r.error };
		return { ok: true, taskOrder: taskOrder(plan) };
	}

	// ─────────────────────────── 杂项 ───────────────────────────

	modelsConfig(): ModelsConfig {
		return loadModelsConfig(modelsJson(this.layout));
	}

	private busy(): boolean {
		return !!this.active && this.active.state.phase !== "done" && this.active.state.phase !== "halted";
	}

	private async persist(): Promise<void> {
		const a = this.active;
		if (!a || a.inMemory) return;
		await saveStateFile(statePaths(this.layout, a.state.missionId).stateJson, a.state);
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
		ctx.ui.setWidget("missions", [renderStatusLine(a.plan, a.state)]);
	}
}

// ─────────────────────────── 渲染(纯函数,UI 层共用) ───────────────────────────

export function renderStatusLine(plan: MissionPlan, state: MissionState): string {
	const task = state.currentTask ? findTask(plan, state.currentTask) : undefined;
	const t = state.currentTask ? state.tasks[state.currentTask] : undefined;
	const role = ROLE_OF[state.phase];
	const threshold = thresholdFor(state.tier);
	const parts = [
		`◆ ${state.missionId}`,
		state.tier,
		state.currentTask ? `${state.currentTask}${task ? ` ${task.title}` : ""}` : "-",
		`phase=${state.phase}`,
		t && (state.phase === "do" || state.phase === "check" || state.phase === "act")
			? `attempt ${t.attempts}(阈值 ${threshold})`
			: null,
		role ?? null,
	];
	let line = parts.filter(Boolean).join(" · ");
	// 熔断临界可视化(I4):烧断之前就要看见
	if (t && t.sameSignatureCount >= threshold - 1 && t.sameSignatureCount > 0) {
		line += ` ⚠ 同一失败签名 ×${t.sameSignatureCount},再失败一次将升级`;
	}
	if (state.pendingHandoff) line += ` ⏸ 等待换脑(/mission next)`;
	return line;
}

export function renderStateCard(plan: MissionPlan, state: MissionState, dirName = "missions"): string {
	const task = state.currentTask ? findTask(plan, state.currentTask) : undefined;
	const t = state.currentTask ? state.tasks[state.currentTask] : undefined;
	const acs =
		plan.acceptanceCriteria.length > 0
			? plan.acceptanceCriteria.map((c) => `  - ${c.id}: ./${dirName}/scripts/verify.sh ${c.verify} 退出码 0 —— ${c.text}`).join("\n")
			: "  (quick 档:验证命令随 mission_submit 提交)";
	const lines = [
		`[MISSION] ${state.missionId} · ${state.tier} · phase=${state.phase}` +
			(state.currentTask ? ` · task=${state.currentTask} · attempt=${t?.attempts ?? 0}` : ""),
		`GOAL: ${plan.goal}`,
		`AC(冻结,不可修改):`,
		acs,
	];
	if (task) lines.push(`CURRENT TASK: ${task.id} ${task.title}(verify: ${task.verify.join(", ") || "submit 时提供"})`);
	if (t?.lastFailureReason) lines.push(`PREV FAILURE: ${t.lastFailureReason}`);
	if (state.pendingHandoff) lines.push(`⏸ 换脑挂起中:${state.pendingHandoff}。请执行 /mission next。`);
	if (state.phase === "do" && task) {
		lines.push(`你只需完成 ${task.id}。完成后调用 mission_submit,不要自行判定通过。`);
	}
	return lines.join("\n");
}

function renderDoBrief(plan: MissionPlan, state: MissionState): string {
	const task = state.currentTask ? findTask(plan, state.currentTask) : undefined;
	const t = state.currentTask ? state.tasks[state.currentTask] : undefined;
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

/**
 * pi-missions · check-runner
 *
 * CHECK 相位的编排器,从 runtime.ts 提取。
 *
 * 与 Runtime 的分工:这里管"怎么跑完一次 CHECK" ——
 * 跑 verify.sh 分支拿 hard 证据、起进程内 Verifier 拿 semi 证据、
 * 收人工终审(human)、调 judge() 出判定、发 VERDICT 事件、归档证据。
 * Runtime 管会话生命周期、事件应用与效果翻译。
 *
 * 本文件**不做任何判定**:pass/fail/inconclusive 归 core/verdict.ts 的 judge(),
 * retry/escalate/halt 归 core/machine.ts 的 VERDICT handler。这里只是采集与编排。
 *
 * 依赖经构造函数注入 Runtime 实例(this.rt.*),因此 Runtime 有若干成员
 * 以 internal 名义开放给本类(见 runtime.ts 字段区的标注)。
 */

import * as fs from "node:fs";
import type { Evidence } from "./core/types.ts";
import { judge } from "./core/verdict.ts";
import { reportIsSubstantive } from "./core/spike.ts";
import { findMilestoneOf, findTask, isLastTaskOfMilestone } from "./store/mission.ts";
import { envFingerprintSh, statePaths } from "./store/paths.ts";
import { appendLog } from "./store/log.ts";
import { computeEnvFingerprint } from "./store/git.ts";
import { saveEvidence } from "./store/evidence.ts";
import { saveCheckState, type CheckState } from "./store/check.ts";
import { DEFAULT_THINKING } from "./roles/models.ts";
import {
	renderSpikeVerifierBrief,
	renderVerifierBrief,
	runVerifier,
	type VerifierControl,
	type VerifierProgress,
} from "./roles/verifier.ts";
import { renderActBrief, renderDoBrief } from "./briefs.ts";
import type { ActiveMission, Runtime } from "./runtime.ts";

const EVIDENCE_TAIL = 4000;
const DIFF_TAIL = 12000;

function tail(s: string, n: number): string {
	return s.length > n ? s.slice(-n) : s;
}

export class CheckRunner {
	private readonly rt: Runtime;

	// 不用参数属性(node --test 的 type stripping 不支持,冒烟测试会加载失败)
	constructor(rt: Runtime) {
		this.rt = rt;
	}

	/**
	 * 核验进行中的人工 steer(补充检查指令)。
	 * 只补检查重点,改不了冻结 AC;每次 steer 都写 CHECK.json 与 LOG.md 审计链。
	 */
	async steer(ctx: any, message: string): Promise<{ ok: true } | { error: string }> {
		const text = message.trim();
		if (!text) return { error: "steer 内容为空" };
		const a = this.rt.active;
		if (!a || a.state.phase !== "check") {
			return { error: "当前不在 CHECK 相位" };
		}
		const control = this.rt.activeVerifierControl;
		if (!control) return { error: "独立 Verifier 尚未启动或已经结束" };
		try {
			await control.steer(text);
			const verifier = this.rt.liveCheckState?.verifier;
			if (verifier) {
				verifier.steerCount = (verifier.steerCount ?? 0) + 1;
				this.rt.liveCheckState!.updatedAt = Date.now();
				if (!a.inMemory) {
					saveCheckState(statePaths(this.rt.layout, a.state.missionId).checkJson, this.rt.liveCheckState!);
					appendLog(
						statePaths(this.rt.layout, a.state.missionId).logMd,
						`VERIFIER STEER ${text.replace(/\s+/g, " ").slice(0, 200)}`,
					);
				}
			}
			this.rt.refreshWidget(ctx);
			return { ok: true };
		} catch (error) {
			return { error: error instanceof Error ? error.message : String(error) };
		}
	}

	async run(ctx: any): Promise<void> {
		const rt = this.rt;
		const a = rt.active;
		if (!a || a.state.phase !== "check" || !a.state.currentTask) return;
		const taskId = a.state.currentTask;
		const task = findTask(a.plan, taskId);
		const attempt = a.state.tasks[taskId]?.attempts ?? 1;
		const isCurrent = () => this.isCurrent(a, taskId, attempt);
		const l = rt.layout;
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
			if (isCurrent()) rt.liveCheckState = checkState;
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
			rt.refreshWidget(ctx);
			const result = await rt.exec(cmd, args, { timeout });
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
			const timeoutMs = rt.config.verifierTimeoutMs ?? 300_000;
			persistCheck({
				stage: "running_verifier",
				verifier: { status: "running", startedAt, activity: "初始化独立 AgentSession", trace: [] },
				summary: "脚本已完成，独立验证者核验中...",
			});
			rt.refreshWidget(ctx);
			const verifierConfig = rt.modelsConfig().verifier;
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
			// 未配置 verifier 模型时静默回退会话模型 —— 会话模型正是 executor 用的那个,
			// 同源核验系统性偏向 pass(I3 独立性受损)。配了但不可用的降级走上面那条路(有告警),
			// 这里补的是"根本没配"的默认路径。warn() 写 LOG.md,同一 mission 只弹一次 UI。
			if (!hasConfiguredModel) {
				rt.warn(
					ctx,
					"verifier 未配置模型,正在使用会话模型执行 semi 核验。同源模型的核验存在系统性偏向 pass 的风险" +
						"(I3 独立性受损)。建议在 /missions 的模型页为 verifier 配置不同家族的模型。",
				);
			}
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
				rt.refreshWidget(ctx);
			};
			const verifierResult = await runVerifier({
				cwd: rt.cwd,
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
						if (isCurrent()) rt.activeVerifierControl = control;
					} else if (rt.activeVerifierControl === ownedControl) {
						rt.activeVerifierControl = null;
					}
				},
			});
			const durationMs = Date.now() - startedAt;
			// 无条件记账:网关不报价时 cost=0,但 token 用量必须落盘,否则 verifier 的消耗在账上隐形
			const vu = verifierResult.usage;
			if (isCurrent() && (vu.cost > 0 || vu.input + vu.output + vu.cacheRead + vu.cacheWrite > 0)) {
				await rt.applyEvent(
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
			rt.warn(ctx, `独立核验降级为 hard-only:${degradeWhy}`);
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
		rt.refreshWidget(ctx);

		try {
			const fp = await computeEnvFingerprint(rt.exec, rt.cwd, envFingerprintSh(l));
			if (!isCurrent()) return;
			const spike = rt.currentSpikeReport();
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
				const script = rt.repository.verifyScriptPath(a.state.missionId, a.generation);
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
			rt.pi.appendEntry("missions-verdict", {
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
			const result = await rt.applyEvent({ type: "VERDICT", at: Date.now(), verdict }, ctx);
			if (result.error) return;

			const state = rt.active!.state;
			if (state.pendingHandoff) return;
			if (state.phase === "act") {
				rt.pi.sendUserMessage(renderActBrief(a.plan, state), { deliverAs: "followUp" });
			} else if (state.phase === "do") {
				rt.pi.sendUserMessage(renderDoBrief(a.plan, state, rt.currentSpikeReport()?.rel), {
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
				const result = await rt.applyEvent({ type: "VERDICT", at: Date.now(), verdict }, ctx);
				if (!result.error && result.state.phase === "do") {
					rt.pi.sendUserMessage(renderDoBrief(a.plan, result.state, rt.currentSpikeReport()?.rel), {
						deliverAs: "followUp",
					});
				}
			}
		} finally {
			rt.refreshWidget(ctx);
		}
	}

	/** 当前 CHECK 是否仍属于发起时的那个 mission 附着实例(同任务同 attempt) */
	private isCurrent(active: ActiveMission, taskId: string, attempt: number): boolean {
		return (
			this.rt.active === active &&
			active.state.phase === "check" &&
			active.state.currentTask === taskId &&
			(active.state.tasks[taskId]?.attempts ?? 1) === attempt
		);
	}

	private async gitDiff(): Promise<string> {
		// 用冻结时的 baseCommit 做 diff 基准(如果有的话),
		// 否则退化为 HEAD —— 后者会把冻结前的工作也混进 verdict 证据。
		const base = this.rt.active?.state.baseCommit ?? "HEAD";
		const r = await this.rt.exec("git", ["-c", "core.pager=cat", "diff", base, "--stat"], { timeout: 30_000 });
		const d = await this.rt.exec("git", ["-c", "core.pager=cat", "diff", base], { timeout: 30_000 });
		return tail(`${r.stdout}\n\n${d.stdout}`, DIFF_TAIL);
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
		this.rt.refreshWidget(ctx);
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
}

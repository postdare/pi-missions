/**
 * pi-missions · 命令面
 *
 * /missions(复数)= 面板;/mission(单数)= 动作。
 * /mission next /mission escalate 主要由 L0 经 followUp 内部调用,人也可以手动敲。
 */

import * as fs from "node:fs";
import type { QuickCriterion, Runtime } from "./runtime.ts";
import { allTasks, type MissionPlan } from "./store/mission.ts";
import { statePaths, spikeReport } from "./store/paths.ts";
import { readLog } from "./store/log.ts";
import { latestEvidenceResults, readTaskEvidenceHistory, type TaskEvidenceAttempt } from "./store/evidence.ts";
import { openStatusView, statusFallbackText, type StatusViewData } from "./ui/status-view.ts";
import { applyTierSelection, clearTierIndicator, modelSummary } from "./ui/tier-indicator.ts";
import { openMissionsPanel } from "./ui/panel.ts";
import {
	acReviewLines,
	approachLines,
	openPlanReview,
	scopeLines,
	taskReviewLines,
} from "./ui/plan-review.ts";
import { STATE_ICON } from "./ui/models-page.ts";
import { formatTokens } from "./ui/dashboard.ts";
import { ROLE_ORDER, resolveRoleView, type RoleModelView } from "./roles/models.ts";
import { ROLE_OF } from "./core/machine.ts";
import type { MissionState } from "./core/types.ts";

type Ctx = any;
type GetRuntime = (ctx: Ctx) => Runtime;

export function registerCommands(pi: any, getRuntime: GetRuntime): void {
	pi.registerCommand("missions", {
		description: "Mission 主面板:顶部新建,下方历史列表",
		handler: async (_args: string, ctx: Ctx) => {
			const rt0 = getRuntime(ctx);
			await openMissionsPanel(ctx, rt0.layout, {
				onLoadError: (error) => ctx.ui.notify(`Mission 列表跳过损坏项:${error.code}: ${error.message}`, "error"),
				onSelectTier: (tier) => {
					const rt = getRuntime(ctx);
					rt.pendingTier = tier;
					applyTierSelection(
						ctx,
						tier,
						() => {
							getRuntime(ctx).pendingTier = null;
						},
						roleModelSummary(rt, ctx),
					);
				},
				onDetail: async (id) => {
					const d = statusDataFor(rt0, id);
					if (!d) {
						ctx.ui.notify(missionLoadError(rt0, id), "error");
						return;
					}
					await openStatusView(ctx, () => statusDataFor(rt0, id), statusViewOpts(pi, ctx, rt0, id));
				},
				onResume: (id) => {
					pi.sendUserMessage(`/mission resume ${id}`, { deliverAs: "followUp", expandPromptTemplates: true });
				},
				onAbort: (_id) => {
					pi.sendUserMessage(`/mission abort`, { deliverAs: "followUp", expandPromptTemplates: true });
				},
				isAttached: (id) => rt0.active?.state.missionId === id,
				models: {
					getData: () => {
						const rt = getRuntime(ctx);
						const a = rt.active;
						return {
							config: rt.modelsConfig(),
							models: rt.availableModels(ctx),
							sessionLabel: rt.sessionModelLabel(ctx),
							cost: a?.state.cost ?? {},
							tokens: a?.state.tokens ?? {},
							activeRole: a ? ROLE_OF[a.state.phase] : null,
							dirName: rt.config.missionsDir,
						};
					},
					// 面板是同步回调,写盘/applyRole 是异步:失败只提示,不阻塞 UI
					setModel: (role, selection) => {
						void getRuntime(ctx)
							.setRoleModel(ctx, role, selection)
							.catch((e: unknown) => ctx.ui.notify(`模型设置失败:${String(e)}`, "error"));
					},
					setThinking: (role, thinking) => {
						const rt = getRuntime(ctx);
						const cur = rt.modelsConfig()[role];
						const sel = cur?.provider && cur?.model ? { provider: cur.provider, id: cur.model } : null;
						void rt
							.setRoleModel(ctx, role, sel, thinking)
							.catch((e: unknown) => ctx.ui.notify(`thinking 设置失败:${String(e)}`, "error"));
					},
				},
			});
		},
	});

	pi.registerCommand("mission", {
		description: "Mission 操作:new/quick/status/next/verify/escalate/plan/resume/abort/models · 详情:/missions",
		handler: async (args: string, ctx: Ctx) => {
			const rt = getRuntime(ctx);
			const { sub, rest, flags } = parseArgs(args);

			// mission 循环靠 followUp 多轮驱动 + newSession 换脑,print/json 一次性模式承载不了
			const DRIVING = new Set(["new", "quick", "next", "verify", "escalate", "resume"]);
			if (DRIVING.has(sub) && ctx.mode !== "tui" && ctx.mode !== "rpc") {
				return notifyUsage(ctx, `mission 循环需要交互会话(TUI 或 RPC),当前是 ${ctx.mode} 模式`);
			}

			// pi 重建扩展实例后内存态丢失(newSession/reload/重启)——先从磁盘接上再干活(I1)
			const ATTACH_FIRST = new Set(["next", "verify", "escalate", "plan", "abort", "models"]);
			if (ATTACH_FIRST.has(sub)) await rt.ensureAttached(ctx);

			switch (sub) {
				case "tier": {
					// 手动设定档位指示(不经面板);取消按 Esc,不再提供 off 子命令
					const t = rest.trim();
					if (t !== "quick" && t !== "standard" && t !== "complex") {
						return notifyUsage(ctx, "用法:/mission tier quick|standard|complex(取消:按 Esc)");
					}
					rt.pendingTier = t;
					applyTierSelection(
						ctx,
						t,
						() => {
							getRuntime(ctx).pendingTier = null;
						},
						roleModelSummary(rt, ctx),
					);
					return;
				}

				case "new": {
					const tier = flags.tier ?? rt.consumePendingTier() ?? "standard";
					if (tier !== "standard" && tier !== "complex") {
						ctx.ui.notify(`未知档位 --tier=${tier}(可选 standard|complex;单任务请用 /mission quick)`, "error");
						return;
					}
					if (!rest) return notifyUsage(ctx, "用法:/mission new <目标> [--tier=standard|complex]");
					const r = await rt.startNew(ctx, rest, tier);
					if ("error" in r) return notifyUsage(ctx, r.error);
					clearTierIndicator(ctx); // 档位已被消费,状态条接管
					pi.sendUserMessage(kickoff(rt.config.missionsDir, r.id, tier, rest, r.phase), { deliverAs: "followUp" });
					return;
				}

				case "quick": {
					if (!rest) return notifyUsage(ctx, "用法:/mission quick <任务>");
					// --verify 是加速路径:给了就直接冻结成命令判据,跳过 PLAN 相位的自定判据
					const cmd = flags.verify?.trim();
					const picked: QuickCriterion | null = cmd
						? { judge: "command", text: cmd, command: cmd }
						: null;
					const r = await rt.startQuick(ctx, rest, picked);
					if ("error" in r) return notifyUsage(ctx, r.error);
					rt.pendingTier = null; // quick 不消费待选档位,直接清掉
					clearTierIndicator(ctx);
					// 无 --verify 时 startQuick 会升档 standard(判定依据必须先于执行冻结),此处按落点分流
					pi.sendUserMessage(
						r.tier === "quick"
							? quickKickoff(r.id, rest, picked)
							: kickoff(rt.config.missionsDir, r.id, r.tier, rest, rt.active?.state.phase ?? "define"),
						{ deliverAs: "followUp" },
					);
					return;
				}

				case "status": {
					// 无 id = 当前活动 mission;带 id = 查看任意 mission(不接管会话)
					const id = rest.trim() || rt.active?.state.missionId || null;
					if (!id) return notifyUsage(ctx, "无活动 mission。/missions 查看历史,/mission resume <id> 恢复");
					const d = statusDataFor(rt, id);
					if (!d) return notifyUsage(ctx, missionLoadError(rt, id));
					if (ctx.hasUI) {
						await openStatusView(ctx, () => statusDataFor(rt, id), statusViewOpts(pi, ctx, rt, id));
					} else {
						pi.appendEntry("missions-card", {
							title: `${d.state.missionId} · ${d.state.tier} · ${d.state.phase}`,
							body: statusFallbackText(d),
						});
					}
					return;
				}

				case "next": {
					const r = await rt.handoff(ctx);
					if ("error" in r) return notifyUsage(ctx, r.error);
					return; // 换脑视为该 handler 终点
				}

				case "verify": {
					const a = rt.active;
					if (!a) return notifyUsage(ctx, "无活动 mission");
					if (a.state.phase !== "do") return notifyUsage(ctx, `当前相位是 ${a.state.phase},/mission verify 只能在 do 相位`);
					const r = await rt.applyEvent({ type: "SUBMIT", at: Date.now() }, ctx);
					if (r.error) return notifyUsage(ctx, r.error);
					void rt.startCheck(ctx);
					return;
				}

				case "escalate": {
					const level = Number(flags.level ?? "2");
					if (level !== 2 && level !== 3) return notifyUsage(ctx, "用法:/mission escalate --level=2|3");
					const r = await rt.applyEvent(
						{ type: "ESCALATE", at: Date.now(), to: level, reason: rest || "人工升级" },
						ctx,
					);
					if (r.error) return notifyUsage(ctx, r.error);
					return;
				}

				case "plan": {
					// 任何相位都能只读查看:MISSION.md 从 define 起就落盘(goal/definition 是
					// 换脑后的恢复锚点),冻结之后只是内容变全 —— 这个命令不再有可用窗口问题。
					const id = rest.trim() || rt.active?.state.missionId || null;
					if (!id) return notifyUsage(ctx, "无活动 mission。/missions 查看历史");
					const d = statusDataFor(rt, id);
					if (!d) return notifyUsage(ctx, missionLoadError(rt, id));
					if (!ctx.hasUI) {
						pi.appendEntry("missions-card", {
							title: `${d.state.missionId} · 计划`,
							body: planFallbackText(d),
						});
						return;
					}
					if (flags.edit) {
						return notifyUsage(ctx, "v2 的 MISSION.md 是只读投影，不支持手工编辑；请让 planner 调用 mission_write_plan");
					}
					await openPlanReview(ctx, () => ({ plan: d.plan, state: d.state }), { readOnly: true });
					return;
				}

				case "resume": {
					if (!rest) return notifyUsage(ctx, "用法:/mission resume <id>(/missions 查看历史)");
					const r = await rt.resume(ctx, rest.trim());
					if ("error" in r) return notifyUsage(ctx, r.error);
					ctx.ui.notify(`已恢复 mission "${rest.trim()}",按当前相位继续`, "info");
					return;
				}

				case "abort": {
					const a = rt.active;
					if (!a) return notifyUsage(ctx, "无活动 mission");
					const r = await rt.applyEvent({ type: "ABORT", at: Date.now(), reason: rest || "人工中止" }, ctx);
					if (r.error) return notifyUsage(ctx, r.error);
					rt.refreshWidget(ctx);
					return;
				}

				case "models": {
					// 显示**实际生效**的值:配了但不可用的模型会被静默回退到会话模型
					const a = rt.active;
					const views = roleModelViews(rt, ctx);
					const rows = views.map((v) => {
						const role = v.role;
						const spent = a?.state.cost[role];
						const tk = a?.state.tokens?.[role];
						const tkSum = tk ? tk.input + tk.output + tk.cacheRead + tk.cacheWrite : 0;
						const mark = STATE_ICON[v.state] ?? "?";
						return `  ${mark} ${role.padEnd(10)} ${v.label}  · thinking=${v.thinking}${v.thinkingIsDefault ? "(默认)" : ""}${spent ? `  $${spent.toFixed(4)}` : ""}${tkSum > 0 ? `  ${formatTokens(tkSum)} tok` : ""}`;
					}).join("\n");
					pi.appendEntry("missions-card", {
						title: `角色模型映射(${rt.config.missionsDir}/models.json)`,
						body: `${rows}\n\n${STATE_ICON.configured} 已配置  ${STATE_ICON.unavailable} 配了但不可用(实际跟随会话)  ${STATE_ICON.inherit} 未配置\n/missions 面板 → ←→ 切到「模型」页可直接修改。`,
					});
					return;
				}

				default:
					return notifyUsage(
						ctx,
						"用法:/mission new|quick|status|next|verify|escalate|plan|resume|abort|models · 面板与详情:/missions",
					);
			}
		},
	});
}

/**
 * quick 的开场白。两条路:
 *   带 --verify —— 判据已冻结,直接开写。
 *   不带      —— 先在 PLAN 相位定判据(只读工具 + mission_criterion),**不问人**。
 *                开工前多一次交互,小任务就不值得开 mission 了。
 *
 * 判据由谁核对写在开场白里 —— 执行者必须知道自己会被谁按什么标准判。
 */
function quickKickoff(id: string, goal: string, criterion: QuickCriterion | null): string {
	if (criterion?.judge === "command") {
		return (
			`[pi-missions] quick 任务(${id}):${goal}\n` +
			`判定依据已冻结:命令 \`${criterion.command}\` 的退出码。\n` +
			"现在可以改代码,改完调用 mission_submit。"
		);
	}
	return (
		`[pi-missions] quick 任务(${id}):${goal}\n` +
		"当前在 PLAN 相位,只有只读工具。第一步:用 read/grep 看几眼相关代码," +
		"然后调用 mission_criterion 冻结一条判据(「做完之后能观察到什么」,不是「要做什么」)。\n" +
		"判据冻结后自动进入 DO,写工具才会解锁 —— 这是设计,不是故障。"
	);
}

/**
 * 四个角色**实际生效**的模型视图。档位指示条与 /mission models 必须走同一条
 * 规则 —— 两处各算一遍可用性,迟早会出现"卡片说不可用、指示条说可用"。
 */
function roleModelViews(rt: Runtime, ctx: Ctx): RoleModelView[] {
	const cfg = rt.modelsConfig();
	const avail = new Set(rt.availableModels(ctx).map((m) => `${m.provider}/${m.id}`));
	const isAvailable = (p: string, m: string) => avail.size === 0 || avail.has(`${p}/${m}`);
	const session = rt.sessionModelLabel(ctx);
	return ROLE_ORDER.map((role) => resolveRoleView(cfg, role, isAvailable, session));
}

/** 档位指示条上那一段模型摘要;拿不到会话模型时返回空串(指示条自动省略) */
function roleModelSummary(rt: Runtime, ctx: Ctx): string {
	try {
		return modelSummary(roleModelViews(rt, ctx), rt.sessionModelLabel(ctx));
	} catch {
		return ""; // 模型信息是附加项,取不到不该拖垮档位选择
	}
}

/** 新 Mission 的开场白。按起始相位分流(standard/complex 起于 DEFINE) */
/**
 * 读某个 mission 的展示数据:优先取内存(活动 mission 的实时态),
 * 否则从磁盘读(只看不接管 —— 不改 CURRENT 指针、不切工具集)。
 */
/** 非 TUI 环境下 /mission plan 的退化形态:同一批行构造器,不上色 */
function planFallbackText(d: StatusViewData): string {
	const t = { fg: (_c: string, x: string) => x, bold: (x: string) => x };
	const W = 88;
	return [
		"目标与边界",
		...scopeLines(d.plan, t, W),
		"",
		"方案",
		...approachLines(d.plan, t, W),
		"",
		"验收标准",
		...acReviewLines(d.plan, t, W),
		"",
		"任务",
		...taskReviewLines(d.plan, d.state, t, W),
		"",
		`verify.sh 见 ${d.verifyScriptPath}(${(d.plan.verifyScript ?? "").split("\n").length} 行)`,
	].join("\n");
}

function statusDataFor(rt: Runtime, missionId: string): StatusViewData | null {
	const dirName = rt.config.missionsDir;
	const cur = rt.active?.state.missionId === missionId ? rt.active : null;
	const sp = statePaths(rt.layout, missionId);
	let plan: MissionPlan | null = null;
	let state: MissionState | null = null;
	let logLines: string[] = [];
	let generation = 0;

	if (cur) {
		plan = cur.plan;
		state = cur.state;
		generation = cur.generation;
		logLines = cur.inMemory ? [] : readLog(sp.logMd).trim().split("\n").filter(Boolean);
	} else {
		const loaded = rt.repository.load(missionId);
		if (!loaded.ok) return null;
		plan = loaded.snapshot.plan;
		state = loaded.snapshot.state;
		generation = loaded.snapshot.artifacts.generation;
		logLines = readLog(sp.logMd).trim().split("\n").filter(Boolean);
	}
	if (!plan || !state) return null;

	const taskEvidence: Record<string, TaskEvidenceAttempt[]> = {};
	const spikeReports: Record<string, string> = {};
	for (const t of allTasks(plan)) {
		taskEvidence[t.id] = cur?.inMemory ? [] : readTaskEvidenceHistory(sp.evidenceDir, t.id);
		if (t.kind === "spike") {
			try {
				const spPath = spikeReport(rt.layout, missionId, t.id);
				if (fs.existsSync(spPath)) {
					spikeReports[t.id] = fs.readFileSync(spPath, "utf8");
				}
			} catch {
				/* 忽略读取错误 */
			}
		}
	}

	return {
		plan,
		state,
		evidence: { latest: latestEvidenceResults(sp.evidenceDir) },
		taskEvidence,
		spikeReports,
		checkState: rt.checkStateFor(missionId),
		logLines,
		dirName,
		verifyScriptPath: `./${dirName}/state/${missionId}/generations/${generation}/verify.sh`,
	};
}

function missionLoadError(rt: Runtime, missionId: string): string {
	const loaded = rt.repository.load(missionId);
	return loaded.ok ? `mission "${missionId}" 暂时无法展示` : `mission "${missionId}" ${loaded.code}: ${loaded.error}`;
}

function kickoff(dirName: string, id: string, tier: string, goal: string, phase: string): string {
	const head = `[pi-missions] 新 Mission 已创建(${id},${tier} 档),进入 ${phase.toUpperCase()} 相位。`;
	if (phase === "define") {
		return (
			`${head}阅读 ${dirName}/README.md 与 ${dirName}/phases/define.md。` +
			"先读代码,能从仓库里读到的别去问人;仍有影响完成条件的模糊就调用 mission_ask 提问" +
			"(一轮最多 3 个,每个必须带推荐答案;standard 2 轮、complex 3 轮)并停下等回答," +
			"清楚了就调用 mission_define 交出目标、完成条件(doneWhen)与边界。" +
			`原始需求:${goal}`
		);
	}
	return (
		`${head}阅读 ${dirName}/README.md 与 ${dirName}/phases/plan.md,` +
		`分析代码库,设计可执行的验收标准与任务分解,然后调用 mission_write_plan 原子提交。目标:${goal}`
	);
}

function notifyUsage(ctx: Ctx, msg: string): void {
	ctx.ui.notify(msg, "warning");
}

/**
 * 状态视图的统一接线:恢复/中止/补充核验指令。
 * 恢复只对「被 halt、换脑挂起、或未附着(中断/别的会话)」的 mission 开放;
 * 正在本会话跑着的 mission 没有恢复入口,中止也只对它有意义(/mission abort 作用于活动 mission)。
 */
export function statusViewOpts(pi: any, ctx: Ctx, rt: Runtime, id: string) {
	return {
		getCheckState: () => rt.checkStateFor(id),
		onResume: (mid: string) => pi.sendUserMessage(`/mission resume ${mid}`, { deliverAs: "followUp", expandPromptTemplates: true }),
		canResume: (d: StatusViewData) =>
			d.state.phase !== "done" &&
			(d.state.phase === "halted" || !!d.state.pendingHandoff || rt.active?.state.missionId !== d.state.missionId),
		onAbort: () => pi.sendUserMessage(`/mission abort`, { deliverAs: "followUp", expandPromptTemplates: true }),
		canAbort: (d: StatusViewData) =>
			d.state.phase !== "done" &&
			d.state.phase !== "halted" &&
			rt.active?.state.missionId === d.state.missionId,
		onSteer: (_mid: string, text: string) => {
			void rt.steerVerifier(ctx, text).then((r) => {
				if ("error" in r) ctx.ui.notify(`补充指令未送达:${r.error}`, "warning");
			});
		},
	};
}

const BOOL_FLAGS = new Set(["edit"]);

function parseArgs(args: string): { sub: string; rest: string; flags: Record<string, string> } {
	const flags: Record<string, string> = {};
	// --key=value 与 --key value / --key "quoted value"
	let rest = args.replace(/--([\w-]+)=("[^"]*"|'[^']*'|\S+)/g, (_m, k, v) => {
		flags[k] = String(v).replace(/^["']|["']$/g, "");
		return "";
	});
	rest = rest.replace(/--([\w-]+)\s+("[^"]*"|'[^']*')/g, (_m, k, v) => {
		flags[k] = String(v).replace(/^["']|["']$/g, "");
		return "";
	});
	// 无值开关。走白名单而不是"凡 --xxx 都算":目标文本里出现 --xxx 的时候
	// 不该被悄悄吃掉(/mission new "重构 --legacy 模块")
	rest = rest.replace(/--([\w-]+)/g, (m, k) => {
		if (!BOOL_FLAGS.has(String(k))) return m;
		flags[k] = "true";
		return "";
	});
	const parts = rest.trim().split(/\s+/).filter(Boolean);
	const sub = parts.shift() ?? "";
	return { sub, rest: parts.join(" "), flags };
}

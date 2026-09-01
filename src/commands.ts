/**
 * pi-missions · 命令面
 *
 * /missions(复数)= 面板;/mission(单数)= 动作。
 * /mission next /mission escalate 主要由 L0 经 followUp 内部调用,人也可以手动敲。
 */

import * as fs from "node:fs";
import type { Runtime } from "./runtime.ts";
import { parseMissionMd } from "./store/mission.ts";
import { planPaths, statePaths } from "./store/paths.ts";
import { readLog } from "./store/log.ts";
import { latestEvidenceResults } from "./store/evidence.ts";
import { openStatusView, statusFallbackText, type StatusViewData } from "./ui/status-view.ts";
import { applyTierSelection, clearTierIndicator } from "./ui/tier-indicator.ts";
import { openMissionsPanel } from "./ui/panel.ts";
import { STATE_ICON } from "./ui/models-page.ts";
import { ROLE_ORDER, resolveRoleView } from "./roles/models.ts";
import { ROLE_OF } from "./core/machine.ts";

type Ctx = any;
type GetRuntime = (ctx: Ctx) => Runtime;

export function registerCommands(pi: any, getRuntime: GetRuntime): void {
	pi.registerCommand("missions", {
		description: "Mission 主面板:顶部新建,下方历史列表",
		handler: async (_args: string, ctx: Ctx) => {
			const rt0 = getRuntime(ctx);
			await openMissionsPanel(ctx, rt0.layout, {
				onResume: (id) => pi.sendUserMessage(`/mission resume ${id}`, { deliverAs: "followUp" }),
				onSelectTier: (tier) => {
					const rt = getRuntime(ctx);
					rt.pendingTier = tier;
					applyTierSelection(ctx, tier);
				},
				models: {
					getData: () => {
						const rt = getRuntime(ctx);
						const a = rt.active;
						return {
							config: rt.modelsConfig(),
							models: rt.availableModels(ctx),
							sessionLabel: rt.sessionModelLabel(ctx),
							cost: a?.state.cost ?? {},
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
		description: "Mission 操作:new/quick/status/next/verify/escalate/plan/log/resume/abort/models",
		handler: async (args: string, ctx: Ctx) => {
			const rt = getRuntime(ctx);
			const { sub, rest, flags } = parseArgs(args);

			// mission 循环靠 followUp 多轮驱动 + newSession 换脑,print/json 一次性模式承载不了
			const DRIVING = new Set(["new", "quick", "next", "verify", "escalate", "resume"]);
			if (DRIVING.has(sub) && ctx.mode !== "tui" && ctx.mode !== "rpc") {
				return notifyUsage(ctx, `mission 循环需要交互会话(TUI 或 RPC),当前是 ${ctx.mode} 模式`);
			}

			// pi 重建扩展实例后内存态丢失(newSession/reload/重启)——先从磁盘接上再干活(I1)
			const ATTACH_FIRST = new Set(["status", "next", "verify", "escalate", "plan", "log", "abort", "models"]);
			if (ATTACH_FIRST.has(sub)) await rt.ensureAttached(ctx);

			switch (sub) {
				case "tier": {
					// 手动设定/清除档位指示(不经面板)
					const t = rest.trim();
					if (t === "off" || t === "clear" || t === "") {
						rt.pendingTier = null;
						clearTierIndicator(ctx);
						ctx.ui.notify("已清除档位选择", "info");
						return;
					}
					if (t !== "quick" && t !== "standard" && t !== "complex") {
						return notifyUsage(ctx, "用法:/mission tier quick|standard|complex|off");
					}
					rt.pendingTier = t;
					applyTierSelection(ctx, t);
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
					if (!rest) return notifyUsage(ctx, "用法:/mission quick <任务> --verify \"<验证命令>\"");
					const r = await rt.startQuick(ctx, rest, flags.verify);
					if ("error" in r) return notifyUsage(ctx, r.error);
					rt.pendingTier = null; // quick 不消费待选档位,直接清掉
					clearTierIndicator(ctx);
					// 无 --verify 时 startQuick 会升档 standard(判定依据必须先于执行冻结),此处按落点分流
					pi.sendUserMessage(
						r.tier === "quick"
							? `[pi-missions] quick 任务(${r.id}):${rest}\n验证命令:${flags.verify}。完成后调用 mission_submit。`
							: kickoff(rt.config.missionsDir, r.id, r.tier, rest, rt.active?.state.phase ?? "frame"),
						{ deliverAs: "followUp" },
					);
					return;
				}

				case "status": {
					const a = rt.active;
					if (!a) return notifyUsage(ctx, "无活动 mission。/missions 查看历史,/mission resume <id> 恢复");
					const dirName = rt.config.missionsDir;
					const getData = (): StatusViewData | null => {
						const cur = rt.active;
						if (!cur) return null;
						const sp = statePaths(rt.layout, cur.state.missionId);
						return {
							plan: cur.plan,
							state: cur.state,
							evidence: { latest: latestEvidenceResults(sp.evidenceDir) },
							logLines: cur.inMemory
								? []
								: readLog(sp.logMd).trim().split("\n").filter(Boolean),
							dirName,
						};
					};
					if (ctx.hasUI) {
						await openStatusView(ctx, getData);
					} else {
						const d = getData();
						if (d) {
							pi.appendEntry("missions-card", {
								title: `${d.state.missionId} · ${d.state.tier} · ${d.state.phase}`,
								body: statusFallbackText(d),
							});
						}
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
					await rt.runCheck(ctx);
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
					const a = rt.active;
					if (!a) return notifyUsage(ctx, "无活动 mission");
					if (a.state.phase !== "plan") return notifyUsage(ctx, "只有 PLAN 相位可以编辑计划(AC 已冻结)");
					const pp = planPaths(rt.layout, a.state.missionId);
					const current = fs.existsSync(pp.missionMd) ? fs.readFileSync(pp.missionMd, "utf8") : "";
					if (!ctx.hasUI) return notifyUsage(ctx, `非交互环境,直接编辑 ${pp.missionMd}`);
					const edited = await ctx.ui.editor("MISSION.md(冻结前可编辑)", current);
					if (edited == null) return;
					if (!parseMissionMd(edited)) {
						return notifyUsage(ctx, "未写入:缺少合法的 ```mission fence(它是机器的 source of truth,请保留)");
					}
					fs.mkdirSync(pp.dir, { recursive: true });
					fs.writeFileSync(pp.missionMd, edited, "utf8");
					ctx.ui.notify("已写入。注意:冻结以 mission_write_plan 的参数为准,手写修改请让 planner 并入其提交。", "warning");
					return;
				}

				case "log": {
					const a = rt.active;
					if (!a) return notifyUsage(ctx, "无活动 mission");
					const sp = statePaths(rt.layout, a.state.missionId);
					pi.appendEntry("missions-card", {
						title: `LOG · ${a.state.missionId}${flags.task ? ` · ${flags.task}` : ""}`,
						body: readLog(sp.logMd, flags.task).trim() || "(暂无日志)",
					});
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
					const cfg = rt.modelsConfig();
					const a = rt.active;
					const avail = new Set(rt.availableModels(ctx).map((m) => `${m.provider}/${m.id}`));
					const isAvailable = (p: string, m: string) => avail.size === 0 || avail.has(`${p}/${m}`);
					const session = rt.sessionModelLabel(ctx);
					const rows = ROLE_ORDER.map((role) => {
						const v = resolveRoleView(cfg, role, isAvailable, session);
						const spent = a?.state.cost[role];
						const mark = STATE_ICON[v.state] ?? "?";
						return `  ${mark} ${role.padEnd(10)} ${v.label}  · thinking=${v.thinking}${v.thinkingIsDefault ? "(默认)" : ""}${spent ? `  $${spent.toFixed(4)}` : ""}`;
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
						"用法:/mission new|quick|status|next|verify|escalate|plan|log|resume|abort|models · 面板:/missions",
					);
			}
		},
	});
}

/** 新 Mission 的开场白。按起始相位分流(standard/complex 起于 FRAME) */
function kickoff(dirName: string, id: string, tier: string, goal: string, phase: string): string {
	const head = `[pi-missions] 新 Mission 已创建(${id},${tier} 档),进入 ${phase.toUpperCase()} 相位。`;
	if (phase === "frame") {
		return (
			`${head}阅读 ${dirName}/README.md 与 ${dirName}/phases/frame.md。` +
			"先读代码,能从仓库里读到的别去问人;仍有影响验收标准的模糊就调用 mission_ask 问一轮" +
			"(整个 mission 只许一轮、最多 3 个问题)并停下等回答,清楚了就调用 mission_frame。" +
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
	const parts = rest.trim().split(/\s+/).filter(Boolean);
	const sub = parts.shift() ?? "";
	return { sub, rest: parts.join(" "), flags };
}

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
import { openMissionsPanel } from "./ui/panel.ts";

type Ctx = any;
type GetRuntime = (ctx: Ctx) => Runtime;

export function registerCommands(pi: any, getRuntime: GetRuntime): void {
	pi.registerCommand("missions", {
		description: "Mission 主面板:顶部新建,下方历史列表",
		handler: async (_args: string, ctx: Ctx) => {
			await openMissionsPanel(ctx, getRuntime(ctx).layout, {
				onResume: (id) => pi.sendUserMessage(`/mission resume ${id}`, { deliverAs: "followUp" }),
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

			switch (sub) {
				case "new": {
					const tier = flags.tier ?? "standard";
					if (tier !== "standard" && tier !== "complex") {
						ctx.ui.notify(`未知档位 --tier=${tier}(可选 standard|complex;单任务请用 /mission quick)`, "error");
						return;
					}
					if (!rest) return notifyUsage(ctx, "用法:/mission new <目标> [--tier=standard|complex]");
					const r = await rt.startNew(ctx, rest, tier);
					if ("error" in r) return notifyUsage(ctx, r.error);
					pi.sendUserMessage(
						`[pi-missions] 新 Mission 已创建(${r.id},${tier} 档),进入 PLAN 相位。` +
							`阅读 ${rt.config.missionsDir}/README.md 与 ${rt.config.missionsDir}/phases/plan.md,` +
							"分析代码库,设计可执行的验收标准与任务分解,然后调用 mission_write_plan 原子提交。目标:" + rest,
						{ deliverAs: "followUp" },
					);
					return;
				}

				case "quick": {
					if (!rest) return notifyUsage(ctx, "用法:/mission quick <任务> [--verify \"<验证命令>\"]");
					const r = await rt.startQuick(ctx, rest, flags.verify);
					if ("error" in r) return notifyUsage(ctx, r.error);
					pi.sendUserMessage(
						`[pi-missions] quick 任务(${r.id}):${rest}\n` +
							(flags.verify
								? `验证命令:${flags.verify}。完成后调用 mission_submit。`
								: "完成后调用 mission_submit 并提供 verifyCommand(判定依据)。"),
						{ deliverAs: "followUp" },
					);
					return;
				}

				case "status": {
					const a = rt.active;
					if (!a) return notifyUsage(ctx, "无活动 mission。/missions 查看历史,/mission resume <id> 恢复");
					const s = a.state;
					const cost = Object.entries(s.cost)
						.map(([role, v]) => `${role}=$${(v ?? 0).toFixed(3)}`)
						.join(" ");
					pi.appendEntry("missions-card", {
						title: `${s.missionId} · ${s.tier} · ${s.phase}`,
						body: [
							`goal: ${a.plan.goal}`,
							`task: ${s.currentTask ?? "-"}  order: ${s.taskOrder.join(" → ") || "-"}`,
							`escalation: L${s.escalation.level}(${s.escalation.history.length} 次)`,
							`env: ${s.envFingerprint ?? "未冻结"}`,
							s.pendingHandoff ? `⏸ 等待换脑:${s.pendingHandoff}` : null,
							cost ? `cost: ${cost}` : "cost: -",
						]
							.filter(Boolean)
							.join("\n"),
					});
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
					const cfg = rt.modelsConfig();
					const a = rt.active;
					const cost = a
						? Object.entries(a.state.cost)
								.map(([role, v]) => `  ${role}: $${(v ?? 0).toFixed(4)}`)
								.join("\n")
						: "  (无活动 mission)";
					pi.appendEntry("missions-card", {
						title: "角色模型映射(missions/models.json)",
						body:
							`  planner:   ${fmtRole(cfg.planner)}\n  executor:  ${fmtRole(cfg.executor)}\n` +
							`  verifier:  ${fmtRole(cfg.verifier)}\n  escalator: ${fmtRole(cfg.escalator)}\n\n本次花费(按角色):\n${cost}`,
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

function fmtRole(c?: { provider?: string; model?: string; thinking?: string }): string {
	if (!c) return "(默认:跟随会话模型)";
	return `${c.provider ? `${c.provider}/` : ""}${c.model ?? "?"}${c.thinking ? ` thinking=${c.thinking}` : ""}`;
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

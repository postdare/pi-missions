/**
 * pi-missions —— 双层循环工作流引擎
 *
 * 外层 PDCA 管任务分解与进度追踪,内层操控循环管执行中的质量控制与自我修正。
 * L0(本扩展进程内的纯代码)是唯一的裁判;状态在仓库里(missions/),不在会话里。
 *
 * 装配:命令 + 三个 LLM 工具 + 事件钩子。
 * 判定逻辑全部在 src/core/(纯函数,有单测);这里只做翻译。
 */

import { Runtime } from "./runtime.ts";
import { renderStateCard } from "./briefs.ts";
import { registerMissionTools } from "./tools.ts";
import { registerCommands } from "./commands.ts";
import { TextCard, renderLogCard, renderVerdictCard, type VerdictCardData } from "./ui/renderer.ts";
import { phasePromptFor } from "./phase-prompts.ts";

export default function (pi: any) {
	let rt: Runtime | null = null;

	const runtime = (cwd: string): Runtime => {
		if (!rt) rt = new Runtime(pi, cwd);
		return rt;
	};
	const getRuntime = (ctx: any): Runtime => runtime(ctx.cwd);

	// verdict / 状态 / 日志卡片(TUI 可见,不进 LLM 上下文)
	pi.registerEntryRenderer("missions-verdict", (entry: any, _opts: any, theme: any) => {
		return new TextCard((t) => renderVerdictCard(t, entry.data as VerdictCardData), theme);
	});
	pi.registerEntryRenderer("missions-card", (entry: any, _opts: any, theme: any) => {
		const d = (entry.data ?? {}) as { title?: string; body?: string };
		return new TextCard((t) => renderLogCard(t, d.title ?? "mission", d.body ?? ""), theme);
	});

	pi.on("session_start", async (event: any, ctx: any) => {
		await runtime(ctx.cwd).onSessionStart(event, ctx);
	});

	// 注入 State Card + 相位提示词(I8:走到哪一步读哪一层)
	pi.on("before_agent_start", async (event: any, ctx: any) => {
		const r = runtime(ctx.cwd);
		const a = r.active;
		if (!a || a.state.phase === "done" || a.state.phase === "halted") return;
		// 按**判定装置**选,不按相位一刀切:quick 读到 standard 的 plan.md/do.md,
		// 会被指去调用闸门里没有的工具、跑不存在的 verify.sh(见 phase-prompts.ts)
		const phasePrompt = phasePromptFor({
			phasesDir: r.layout.phases,
			phase: a.state.phase,
			tier: a.state.tier,
			frozenAcCount: a.plan.acceptanceCriteria.length,
		});
		return {
			message: {
				customType: "missions-state",
				content: renderStateCard(a.plan, a.state, r.config.missionsDir, a.generation, a.quickCriterion),
				display: true,
			},
			systemPrompt: `${event.systemPrompt}\n\n${phasePrompt}`,
		};
	});

	// 闸门(相位能力矩阵 + 冻结件/状态件写保护 + 换脑硬阻断)
	pi.on("tool_call", async (event: any, ctx: any) => {
		const reason = runtime(ctx.cwd).gate(event.toolName, event.input ?? {});
		if (reason) return { block: true, reason };
	});

	// 证据采集辅助 + 升档指标 + 编辑级反馈
	pi.on("tool_result", async (event: any, ctx: any) => {
		await runtime(ctx.cwd).onToolResult(event, ctx);
	});

	// 内层 tick —— 唯一安全的判定点
	pi.on("agent_settled", async (_e: any, ctx: any) => {
		await runtime(ctx.cwd).onAgentSettled(ctx);
	});

	// 成本分账(顺带刷新状态条上的成本/时长;空闲时无需心跳——成本只在 LLM 活动时变化)
	pi.on("message_end", async (event: any, ctx: any) => {
		const r = runtime(ctx.cwd);
		await r.onMessageEnd(event.message, ctx);
		if (r.active) r.refreshWidget(ctx);
	});

	registerMissionTools(pi, getRuntime);
	registerCommands(pi, getRuntime);
}

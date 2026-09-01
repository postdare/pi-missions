/**
 * pi-missions —— 双层循环工作流引擎
 *
 * 外层 PDCA 管任务分解与进度追踪,内层操控循环管执行中的质量控制与自我修正。
 * L0(本扩展进程内的纯代码)是唯一的裁判;状态在仓库里(missions/),不在会话里。
 *
 * 装配:命令 + 三个 LLM 工具 + 事件钩子。
 * 判定逻辑全部在 src/core/(纯函数,有单测);这里只做翻译。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { Runtime, renderStateCard } from "./runtime.ts";
import { registerMissionTools } from "./tools.ts";
import { registerCommands } from "./commands.ts";
import { TextCard, renderLogCard, renderVerdictCard, type VerdictCardData } from "./ui/renderer.ts";

/** 相位提示词的兜底(仓库里的 missions/phases/*.md 被删时用) */
const FALLBACK_PHASE_RULES: Record<string, string> = {
	plan: "你在 PLAN 相位:只读分析 + 调用 mission_write_plan 提交计划。不写实现代码。每条 AC 冻结时会被跑一遍核对基线(默认必须是红的,回归项显式声明 baseline: \"green\")。",
	do: "你在 DO 相位:只完成 State Card 里的当前任务,完成后调用 mission_submit,不要自行判定通过。",
	check: "你在 CHECK 相位:判定由系统执行,你不需要做任何事。",
	act: "你在 ACT 相位:分析上一轮失败,给出修法或调用 mission_escalate。只有一轮,不能写代码。",
};

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

	pi.on("session_start", async (_e: any, ctx: any) => {
		// 子进程 Verifier 守卫:verifier-tools.ts 以 --no-extensions 启动,正常不会走到这;
		// 若用户手动把本扩展和 verifier 混用,跳过一切 mission 行为
		if (process.env.PI_MISSIONS_VERIFIER === "1") return;
		await runtime(ctx.cwd).onSessionStart(ctx);
	});

	// 注入 State Card + 相位提示词(I8:走到哪一步读哪一层)
	pi.on("before_agent_start", async (event: any, ctx: any) => {
		const r = runtime(ctx.cwd);
		const a = r.active;
		if (!a || a.state.phase === "done" || a.state.phase === "halted") return;
		const phasePrompt = readPhasePrompt(r, a.state.phase);
		return {
			message: {
				customType: "missions-state",
				content: renderStateCard(a.plan, a.state, r.config.missionsDir),
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
		runtime(ctx.cwd).onToolResult(event, ctx);
	});

	// 内层 tick —— 唯一安全的判定点
	pi.on("agent_settled", async (_e: any, ctx: any) => {
		await runtime(ctx.cwd).onAgentSettled(ctx);
	});

	// 成本分账(顺带刷新状态条上的成本/时长;空闲时无需心跳——成本只在 LLM 活动时变化)
	pi.on("message_end", async (event: any, ctx: any) => {
		const r = runtime(ctx.cwd);
		r.onMessageEnd(event.message);
		if (r.active) r.refreshWidget(ctx);
	});

	registerMissionTools(pi, getRuntime);
	registerCommands(pi, getRuntime);
}

function readPhasePrompt(rt: Runtime, phase: string): string {
	try {
		const file = path.join(rt.layout.phases, `${phase}.md`);
		if (fs.existsSync(file)) return fs.readFileSync(file, "utf8");
	} catch {
		/* fall through */
	}
	return FALLBACK_PHASE_RULES[phase] ?? "";
}

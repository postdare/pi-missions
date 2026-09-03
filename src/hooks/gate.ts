/**
 * pi-missions · hooks/gate
 *
 * 相位 → 能力矩阵的物理实现。两层:
 *   setActiveTools(粗粒度,LLM 看不到的工具不会调)
 *   tool_call 闸门(细粒度,防 shell 绕过、防写冻结件)
 *
 * 闸门只依赖 STATE,不依赖"上一个工具的结果"(并行工具执行时序不保证)。
 */

import type { Phase, Tier } from "../core/types.ts";

/**
 * pi 的内置工具全集(与 pi 的 ToolName 一一对应,八个)。
 *
 * powershell 与 bash 同一份 schema、同一种能力,是 Windows 上 bash 的替身
 * (pi 的 defaultTools 设置里两者并列)。漏掉它有两个后果,都不是掉个工具而已:
 * Windows 用户一开 mission 就没了 shell,而且下面那道 shell 粗检也管不到它 ——
 * 少一个名字就等于给冻结件写保护开了一条旁路。
 *
 * 名字不存在时 pi 的 setActiveTools 会忽略,所以在非 Windows 上写着它是安全的。
 */
export const BUILTIN_ALL = ["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"];

export const MISSION_TOOLS = ["mission_ask", "mission_define", "mission_write_plan", "mission_submit", "mission_escalate"];

const READONLY = new Set(["read", "grep", "find", "ls"]);

/** 能执行任意命令的工具。两者的 input 都是 { command }(pi 的 bashSchema 是共用的) */
const SHELL = new Set(["bash", "powershell"]);

/** 相位 → 工具集(§3 能力矩阵) */
export function toolsForPhase(phase: Phase, tier: Tier = "standard"): string[] {
	switch (phase) {
		case "define":
			// 只读 + 问一轮 + 交定义。写工具与 mission_write_plan 都不给:
			// 问题还没定义清楚就动手,正是 DEFINE 要拦住的事。
			return [...READONLY, "mission_ask", "mission_define"];
		case "plan":
			// quick 在这个相位只做一件事:看几眼代码,给出一条判据(见 core/criterion.ts)。
			// 给的是只读工具 —— 判据必须先于写代码冻结,这道闸门就是 I2 的物理实现。
			return tier === "quick" ? [...READONLY, "mission_criterion"] : [...READONLY, "mission_write_plan"];
		case "do":
			return [...BUILTIN_ALL, "mission_submit"];
		case "check":
			// CHECK 由 L0 执行(verify.sh + 进程内 Verifier AgentSession),LLM 无回合
			return [...READONLY];
		case "act":
			// quick 不给 mission_escalate:它的 L2/L3 落点是空的。没有"方案"可改,
			// 回 PLAN 唯一能动的就是那条判据本身 —— 而那是执行者看过判定失败之后
			// 再改判定标准(I2/I3 的反面,CLAUDE.md 硬约束第 6 条)。
			// quick 的出口是**自动升档**(evaluatePromotion / breaker 的 promote 分支),
			// 不是手动升级。这里只是粗粒度,machine 的 ESCALATE handler 是最后一道。
			return tier === "quick" ? [...READONLY] : [...READONLY, "mission_escalate"];
		case "done":
		case "halted":
			return [...BUILTIN_ALL, ...MISSION_TOOLS];
	}
}

export interface GateInput {
	phase: Phase;
	tier: Tier;
	/** 换脑挂起原因;非 null 时硬阻断一切写操作(Q10,唯一出口是 /mission next) */
	pendingHandoff: string | null;
	toolName: string;
	input: Record<string, unknown>;
	/** missions 目录名(相对仓库根),用于 shell 命令字符串粗检 */
	missionsDirName: string;
	/**
	 * 当前任务是 spike 时:它唯一被允许写的结论文件(相对仓库根)。
	 * 非 spike 任务为 null。这是"结论不允许直接合进实现"的机械实现 ——
	 * 没有它,agent 会一边调研一边顺手改代码,而那些改动没有任何 AC 管着。
	 */
	spikeReportPath?: string | null;
}

function norm(p: string): string {
	return p.replace(/\\/g, "/");
}

/** 返回拒绝原因;null = 放行 */
export function gateCheck(g: GateInput): string | null {
	// 换脑硬阻断:只读工具放行,其余一律拦住
	if (g.pendingHandoff && !READONLY.has(g.toolName)) {
		return `换脑挂起中(${g.pendingHandoff}):当前会话上下文已被判定为污染/超载,` +
			`唯一出口是执行 /mission next 换脑。写操作与 mission 工具均被冻结。`;
	}

	// 探针任务:只放行写那一个结论文件。
	// 命中也不早退 —— 继续走下面的冻结件保护,免得这条放行变成绕过闸门的通道。
	if (g.spikeReportPath && (g.toolName === "edit" || g.toolName === "write")) {
		const p = norm(String(g.input.path ?? ""));
		const rel = norm(g.spikeReportPath);
		const isReport = !p.includes("..") && (p === rel || p.endsWith(`/${rel}`));
		if (!isReport) {
			return (
				`探针任务(spike)只能写结论文件 ${g.spikeReportPath},不能改实现。\n` +
				"探针的产出是一份书面结论;需要动代码就先把结论交出来,由重写后的计划来做。"
			);
		}
	}

	// 探针任务:shell 只放行只读调查(grep/编译/profile),挡住一切写操作
	if (g.spikeReportPath && SHELL.has(g.toolName)) {
		const cmd = String(g.input.command ?? "");
		if (/(>>?[^&]|sed\s+-i|\btee\b|\brm\b|\bmv\b|\bcp\b|\bpatch\b|git\s+(checkout|apply|restore|stash))/.test(cmd)) {
			return (
				"探针任务(spike)不能用 shell 改动工作区:调查用只读命令(grep/find/编译/profile)," +
				`结论用写工具落到 ${g.spikeReportPath}。`
			);
		}
	}

	// 冻结件与状态件的写保护(任何相位;shell 见下)
	if (g.toolName === "edit" || g.toolName === "write") {
		const p = String(g.input.path ?? "").replace(/\\/g, "/");
		if (p.includes(`${g.missionsDirName}/state/`)) {
			return "missions/state/ 保存 v2 snapshot 与不可变 generation,只能由 L0 Repository 写入(I2/I3)";
		}
	}

	// shell 粗检:防绕开 edit/write 闸门直接改冻结件(尽力而为,社会约束之外的机械兜底)
	if (SHELL.has(g.toolName) && g.phase !== "plan") {
		const cmd = String(g.input.command ?? "");
		const touchesProtected = cmd.includes(`${g.missionsDirName}/state/`);
		const writeish = /(>>?|sed\s+-i|tee\b|\brm\b|\bmv\b|\bcp\b|chmod|git\s+add.*missions)/.test(cmd);
		if (touchesProtected && writeish) {
			return `命令疑似修改 missions/state/ 下的 snapshot 或 generation,已拦截(I2/I3)`;
		}
	}

	return null;
}

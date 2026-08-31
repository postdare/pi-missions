/**
 * pi-missions · hooks/gate
 *
 * 相位 → 能力矩阵的物理实现。两层:
 *   setActiveTools(粗粒度,LLM 看不到的工具不会调)
 *   tool_call 闸门(细粒度,防 bash 绕过、防写冻结件)
 *
 * 闸门只依赖 STATE,不依赖"上一个工具的结果"(并行工具执行时序不保证)。
 */

import type { Phase, Tier } from "../core/types.ts";

export const BUILTIN_ALL = ["read", "bash", "edit", "write", "grep", "find", "ls"];

export const MISSION_TOOLS = ["mission_write_plan", "mission_submit", "mission_escalate"];

const READONLY = new Set(["read", "grep", "find", "ls"]);

/** 相位 → 工具集(§3 能力矩阵) */
export function toolsForPhase(phase: Phase): string[] {
	switch (phase) {
		case "plan":
			return [...READONLY, "mission_write_plan"];
		case "do":
			return [...BUILTIN_ALL, "mission_submit"];
		case "check":
			// CHECK 由 L0 执行(verify.sh + 子进程 Verifier),LLM 无回合
			return [...READONLY];
		case "act":
			return [...READONLY, "mission_escalate"];
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
	/** missions 目录名(相对仓库根),用于 bash 命令字符串粗检 */
	missionsDirName: string;
}

/** 返回拒绝原因;null = 放行 */
export function gateCheck(g: GateInput): string | null {
	// 换脑硬阻断:只读工具放行,其余一律拦住
	if (g.pendingHandoff && !READONLY.has(g.toolName)) {
		return `换脑挂起中(${g.pendingHandoff}):当前会话上下文已被判定为污染/超载,` +
			`唯一出口是执行 /mission next 换脑。写操作与 mission 工具均被冻结。`;
	}

	// 冻结件与状态件的写保护(任何相位;bash 见下)
	if (g.toolName === "edit" || g.toolName === "write") {
		const p = String(g.input.path ?? "").replace(/\\/g, "/");
		if (p.includes(`${g.missionsDirName}/state/`)) {
			return "missions/state/ 由 L0 裁判管理,执行者不可写(I3)";
		}
		if (p.includes(`${g.missionsDirName}/plans/`)) {
			return "MISSION.md 已冻结:AC 只能经 L3 升级修改,计划只能由 mission_write_plan 写入(I2)";
		}
		if (p.includes(`${g.missionsDirName}/scripts/verify.sh`) && g.phase !== "plan") {
			return "verify.sh 已随 AC 冻结;修改验收的执行入口等于篡改裁判(I2/I3)";
		}
	}

	// bash 粗检:防绕开 edit/write 闸门直接改冻结件(尽力而为,社会约束之外的机械兜底)
	if (g.toolName === "bash" && g.phase !== "plan") {
		const cmd = String(g.input.command ?? "");
		const touchesProtected =
			cmd.includes(`${g.missionsDirName}/state/`) || cmd.includes(`${g.missionsDirName}/plans/`) || cmd.includes(`${g.missionsDirName}/scripts/verify.sh`);
		const writeish = /(>>?|sed\s+-i|tee\b|\brm\b|\bmv\b|\bcp\b|chmod|git\s+add.*missions)/.test(cmd);
		if (touchesProtected && writeish) {
			return `命令疑似修改 missions/ 受保护文件(plans/state/verify.sh),已拦截(I2/I3)`;
		}
	}

	return null;
}

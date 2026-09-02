/**
 * pi-missions · store/check
 *
 * CHECK 相位运行态 (missions/state/<id>/CHECK.json)。
 * 由 L0 独占写入,记录验证执行过程中的实时子阶段、耗时、正在执行与已完成分支,
 * 供 /mission status 2秒轮询展示,不修改 MissionState 与 core 判定模型。
 */

import * as fs from "node:fs";
import type { EvidenceResult, VerdictOutcome } from "../core/types.ts";
import { atomicWriteJson } from "./io.ts";

export type CheckStage =
	| "preparing" // 准备环境 (计算指纹等)
	| "running_scripts" // 执行脚本 (跑 verify.sh 分支或 --verify 命令)
	| "running_verifier" // 独立核验 (Verifier AgentSession)
	| "judging" // 生成判定 (汇总证据调用 judge)
	| "completed" // 完成
	| "error"; // 异常

export interface CheckBranchProgress {
	acId: string;
	status: EvidenceResult;
	exitCode?: number;
	startedAt?: number;
	durationMs?: number;
	command?: string;
}

export type VerifierStatus = "pending" | "running" | "completed" | "skipped" | "timeout" | "degraded" | "failed";

export interface CheckVerifierProgress {
	status: VerifierStatus;
	startedAt?: number;
	durationMs?: number;
	message?: string;
	/** Agent 当前动作,例如正在读取/搜索哪个目标 */
	activity?: string;
	/** 最近的 Agent 动作,完整轨迹随 evidence 归档 */
	trace?: string[];
	turns?: number;
	toolCalls?: number;
	inputTokens?: number;
	outputTokens?: number;
	cacheReadTokens?: number;
	cacheWriteTokens?: number;
	cost?: number;
	steerCount?: number;
}

export interface CheckState {
	taskId: string;
	attempt: number;
	startedAt: number;
	updatedAt: number;
	stage: CheckStage;
	/** 当前正在执行的 verify 分支名 */
	currentBranch?: string;
	/** 已完成的 verify 分支列表 */
	completedBranches: CheckBranchProgress[];
	/** 独立 Verifier 状态 */
	verifier?: CheckVerifierProgress;
	/** 最终判定结果 (pass / fail / inconclusive) */
	outcome?: VerdictOutcome;
	/** 异常信息 (若有) */
	error?: string;
	/** 人类可读阶段摘要 */
	summary?: string;
}

/** 保存 CHECK 运行态到 missions/state/<id>/CHECK.json */
export function saveCheckState(checkJsonFile: string, state: CheckState): void {
	try {
		atomicWriteJson(checkJsonFile, state);
	} catch {
		/* 写盘失败不阻塞执行 */
	}
}

/** 读取 CHECK 运行态,文件缺失或损坏时返回 null */
export function loadCheckState(checkJsonFile: string): CheckState | null {
	try {
		const raw = fs.readFileSync(checkJsonFile, "utf8");
		const value: unknown = JSON.parse(raw);
		return isCheckState(value) ? value : null;
	} catch {
		return null;
	}
}

/** 清理或重置 CHECK 运行态 */
export function removeCheckState(checkJsonFile: string): void {
	try {
		fs.unlinkSync(checkJsonFile);
	} catch {
		/* 忽略删除错误 */
	}
}

const CHECK_STAGES = new Set<CheckStage>([
	"preparing",
	"running_scripts",
	"running_verifier",
	"judging",
	"completed",
	"error",
]);
const EVIDENCE_RESULTS = new Set<EvidenceResult>(["pass", "fail", "inconclusive"]);
const VERIFIER_STATUSES = new Set<VerifierStatus>([
	"pending",
	"running",
	"completed",
	"skipped",
	"timeout",
	"degraded",
	"failed",
]);

function isCheckState(value: unknown): value is CheckState {
	if (!isRecord(value)) return false;
	if (
		typeof value.taskId !== "string" ||
		typeof value.attempt !== "number" ||
		typeof value.startedAt !== "number" ||
		typeof value.updatedAt !== "number" ||
		!CHECK_STAGES.has(value.stage as CheckStage) ||
		!Array.isArray(value.completedBranches)
	) {
		return false;
	}
	if (
		!value.completedBranches.every(
			(branch) =>
				isRecord(branch) &&
				typeof branch.acId === "string" &&
				EVIDENCE_RESULTS.has(branch.status as EvidenceResult),
		)
	) {
		return false;
	}
	if (
		value.verifier !== undefined &&
		(!isRecord(value.verifier) || !VERIFIER_STATUSES.has(value.verifier.status as VerifierStatus))
	) {
		return false;
	}
	return value.outcome === undefined || EVIDENCE_RESULTS.has(value.outcome as EvidenceResult);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

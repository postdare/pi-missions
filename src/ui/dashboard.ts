/**
 * pi-missions · ui/dashboard
 *
 * 状态信息的纯渲染函数(widget 多行 + /mission status 详情)。
 * 与 runtime 解耦,方便单测与复用。
 */

import type { MissionState } from "../core/types.ts";
import { ROLE_OF } from "../core/machine.ts";
import { thresholdFor } from "../core/breaker.ts";
import { allTasks, findTask, type MissionPlan } from "../store/mission.ts";

export interface EvidenceSummary {
	/** acId/verify 分支 → 最近一次判定 */
	latest: Record<string, { result: string; level: string; at: number }>;
}

const TASK_ICON: Record<string, string> = { done: "✓", running: "▶", pending: "○", blocked: "✗" };

function bar(done: number, total: number, width = 10): string {
	if (total <= 0) return "░".repeat(width);
	const filled = Math.round((done / total) * width);
	return "█".repeat(filled) + "░".repeat(Math.max(0, width - filled));
}

function costTotal(state: MissionState): number {
	return Object.values(state.cost).reduce((a, b) => a + (b ?? 0), 0);
}

function fmtDuration(fromMs: number, nowMs: number): string {
	const mins = Math.max(0, Math.round((nowMs - fromMs) / 60_000));
	if (mins < 60) return `${mins}min`;
	return `${Math.floor(mins / 60)}h${mins % 60}m`;
}

function truncate(s: string, n: number): string {
	return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

// ─────────────────────────── 常驻状态条(多行) ───────────────────────────

export function renderWidgetLines(plan: MissionPlan, state: MissionState, now = Date.now()): string[] {
	const task = state.currentTask ? findTask(plan, state.currentTask) : undefined;
	const t = state.currentTask ? state.tasks[state.currentTask] : undefined;
	const role = ROLE_OF[state.phase];
	const threshold = thresholdFor(state.tier);
	const done = Object.values(state.tasks).filter((x) => x.status === "done").length;
	const total = state.taskOrder.length;
	const cost = costTotal(state);

	// 第一行:身份 + 相位 + 角色 + 进度 + 环境一致性
	const head = [
		`◆ ${state.missionId}`,
		state.tier,
		`phase=${state.phase}`,
		role ?? null,
		total > 0 ? `${bar(done, total)} ${done}/${total}` : null,
	].filter(Boolean).join(" · ");

	// 第二行:当前任务 + 尝试计数 + 成本 + 时长
	const second = [
		task ? `▶ ${task.id} ${truncate(task.title, 32)}` : null,
		t && ["do", "check", "act"].includes(state.phase) ? `attempt ${t.attempts}/${threshold}` : null,
		cost > 0 ? `$${cost.toFixed(2)}` : null,
		plan.createdAt ? fmtDuration(plan.createdAt, now) : null,
	].filter(Boolean).join(" · ");

	const lines = [head, second ? `  ${second}` : null].filter((l): l is string => !!l);

	// 第三行(条件):熔断预警 / 换脑挂起 / 环境漂移
	if (t && t.sameSignatureCount >= threshold - 1 && t.sameSignatureCount > 0) {
		lines.push(`  ⚠ 同一失败签名 ×${t.sameSignatureCount},再失败一次将升级`);
	}
	if (t && t.inconclusiveStreak > 0) {
		lines.push(`  ⚠ 连续 ${t.inconclusiveStreak} 次无法判定(环境可能漂移)`);
	}
	if (state.pendingHandoff) {
		lines.push(`  ⏸ 等待换脑:${truncate(state.pendingHandoff, 40)} —— 执行 /mission next`);
	}
	return lines;
}

// ─────────────────────────── /mission status 详情面板 ───────────────────────────

export function renderStatusDashboard(
	plan: MissionPlan,
	state: MissionState,
	evidence: EvidenceSummary,
	logTail: string[],
	dirName: string,
	now = Date.now(),
): string {
	const lines: string[] = [];

	// 概览
	const done = Object.values(state.tasks).filter((x) => x.status === "done").length;
	lines.push(`目标: ${plan.goal}`);
	lines.push(
		`档位: ${state.tier} · 相位: ${state.phase}` +
			(ROLE_OF[state.phase] ? ` · 角色: ${ROLE_OF[state.phase]}` : "") +
			` · 进度: ${bar(done, state.taskOrder.length)} ${done}/${state.taskOrder.length}`,
	);
	lines.push(
		`环境: ${state.envFingerprint ?? "未冻结"}` +
			(plan.createdAt ? ` · 已运行 ${fmtDuration(plan.createdAt, now)}` : "") +
			(state.pendingHandoff ? ` · ⏸ 等待换脑(${state.pendingHandoff})` : ""),
	);

	// 升级
	const esc = state.escalation;
	lines.push(
		`升级阶梯: L${esc.level}` +
			(esc.history.length > 0 ? `(${esc.history.length} 次:${esc.history.map((h) => `L${h.from}→L${h.to}`).join(", ")})` : "(无)"),
	);

	// 任务清单
	if (state.taskOrder.length > 0) {
		lines.push("", "任务:");
		for (const id of state.taskOrder) {
			const t = state.tasks[id];
			const pt = findTask(plan, id);
			const icon = TASK_ICON[t?.status ?? "pending"] ?? "○";
			let line = `  ${icon} ${id} ${pt?.title ?? ""} (attempt ${t?.attempts ?? 0})`;
			if (t?.lastFailureReason && t.status !== "done") {
				line += `\n      上次失败: ${t.lastFailureReason}`;
			}
			lines.push(line);
		}
	}

	// 验收标准 + 最近一次判定
	if (plan.acceptanceCriteria.length > 0) {
		lines.push("", `验收标准(冻结 · 执行入口 ./${dirName}/scripts/verify.sh):`);
		for (const ac of plan.acceptanceCriteria) {
			const ev = evidence.latest[ac.verify];
			const mark = ev ? (ev.result === "pass" ? "✓" : ev.result === "fail" ? "✗" : "?") : "·";
			const suffix = ev ? ` [${ev.result}@${ev.level}]` : " [尚无证据]";
			lines.push(`  ${mark} ${ac.id} (\`${ac.verify}\`)${suffix} ${truncate(ac.text, 60)}`);
		}
	}

	// 成本分账
	const entries = Object.entries(state.cost).filter(([, v]) => (v ?? 0) > 0);
	if (entries.length > 0) {
		lines.push(
			"",
			`成本: ${entries.map(([r, v]) => `${r}=$${(v ?? 0).toFixed(3)}`).join(" ")} · 合计 $${costTotal(state).toFixed(3)}`,
		);
	}

	// 日志尾部
	if (logTail.length > 0) {
		lines.push("", "最近日志:");
		for (const l of logTail) lines.push(`  ${l}`);
	}

	return lines.join("\n");
}

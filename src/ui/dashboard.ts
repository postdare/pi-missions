/**
 * pi-missions · ui/dashboard
 *
 * 状态信息的纯渲染层。产出两种形态:
 *   - 按 tab 分组的行数组(概览/任务/验收/日志)→ status-view.ts 的页签浮层
 *   - renderStatusDashboard:拼接所有分组的扁平文本 → 非 TUI 环境的 entry 卡片
 * 与 runtime 解耦,纯函数,可单测。
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { MissionState } from "../core/types.ts";
import { ROLE_OF } from "../core/machine.ts";
import { thresholdFor } from "../core/breaker.ts";
import type { EvidenceRecord } from "../store/evidence.ts";
import { findTask, type MissionPlan } from "../store/mission.ts";

export interface EvidenceSummary {
	/** acId/verify 分支 → 最近一次判定 */
	latest: Record<string, EvidenceRecord>;
}

const TASK_ICON: Record<string, string> = { done: "✓", running: "▶", pending: "○", blocked: "✗" };
const EV_ICON: Record<string, string> = { pass: "✓", fail: "✗", inconclusive: "?" };

export function bar(done: number, total: number, width = 10): string {
	if (total <= 0) return "░".repeat(width);
	const filled = Math.round((done / total) * width);
	return "█".repeat(filled) + "░".repeat(Math.max(0, width - filled));
}

export function costTotal(state: MissionState): number {
	return Object.values(state.cost).reduce((a, b) => a + (b ?? 0), 0);
}

export function fmtDuration(fromMs: number, nowMs: number): string {
	const mins = Math.max(0, Math.round((nowMs - fromMs) / 60_000));
	if (mins < 60) return `${mins}min`;
	return `${Math.floor(mins / 60)}h${mins % 60}m`;
}

export function truncate(s: string, n: number): string {
	return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

// ─────────────────────────── 常驻状态条(主题化卡片) ───────────────────────────

export interface WidgetTheme {
	fg(color: string, s: string): string;
	bold(s: string): string;
}

const PHASE_COLOR: Record<string, string> = {
	frame: "accent",
	plan: "accent",
	do: "accent",
	check: "accent",
	act: "warning",
	done: "success",
	halted: "error",
};

/** 彩色进度条:已完成为 accent,未完成为 dim */
function coloredBar(theme: WidgetTheme, done: number, total: number, width = 8): string {
	if (total <= 0) return theme.fg("dim", "░".repeat(width));
	const filled = Math.round((done / total) * width);
	return (
		theme.fg("accent", "█".repeat(filled)) + theme.fg("dim", "░".repeat(Math.max(0, width - filled)))
	);
}

/**
 * 主题化状态卡片(输入框上方)。结构:
 *   行1: ◆ id(accent 粗体) · 档位(dim) · 相位(带色) · 角色(dim) …… 时长+成本(右对齐)
 *   行2: ▶ 任务标题 · 进度条(多任务) · attempt(临界变警告色)
 *   行3+: 预警(熔断/环境漂移/换脑,警告色)
 */
export function renderWidgetCard(
	theme: WidgetTheme,
	plan: MissionPlan,
	state: MissionState,
	now = Date.now(),
	width = 120,
): string[] {
	const task = state.currentTask ? findTask(plan, state.currentTask) : undefined;
	const t = state.currentTask ? state.tasks[state.currentTask] : undefined;
	const role = ROLE_OF[state.phase];
	const threshold = thresholdFor(state.tier);
	const done = Object.values(state.tasks).filter((x) => x.status === "done").length;
	const total = state.taskOrder.length;
	const cost = costTotal(state);
	const sep = theme.fg("dim", " · ");

	// 行 1:左半 + 右对齐(时长/成本)
	const left = [
		theme.fg("accent", theme.bold(`◆ ${state.missionId}`)),
		theme.fg("dim", state.tier),
		theme.fg(PHASE_COLOR[state.phase] ?? "dim", `phase=${state.phase}`),
		role ? theme.fg("dim", role) : null,
	]
		.filter(Boolean)
		.join(sep);

	const rightBits: string[] = [];
	const elapsed = plan.createdAt ? fmtDuration(plan.createdAt, now) : null;
	if (elapsed && elapsed !== "0min") rightBits.push(theme.fg("dim", elapsed));
	if (cost >= 0.005) rightBits.push(theme.fg("accent", `$${cost.toFixed(2)}`));
	const right = rightBits.join(" ");

	const leftW = visibleWidth(left);
	const rightW = visibleWidth(right);
	const line1 =
		rightW > 0 && leftW + rightW < width
			? left + " ".repeat(width - leftW - rightW) + right
			: left;
	const lines = [truncateToWidth(line1, width)];

	// 行 2:当前任务 + 进度 + attempt
	const bits: string[] = [];
	if (task) bits.push(`${theme.fg("accent", "▶")} ${task.id} ${truncate(task.title, 28)}`);
	if (total > 1) bits.push(`${coloredBar(theme, done, total)} ${theme.fg("dim", `${done}/${total}`)}`);
	if (t && ["do", "check", "act"].includes(state.phase)) {
		const near = t.sameSignatureCount >= threshold - 1 && t.sameSignatureCount > 0;
		bits.push(theme.fg(near ? "warning" : "dim", `attempt ${t.attempts}/${threshold}`));
	}
	if (bits.length > 0) lines.push(truncateToWidth(`  ${bits.join(" ")}`, width));

	// 预警行(警告色)
	if (t && t.sameSignatureCount >= threshold - 1 && t.sameSignatureCount > 0) {
		lines.push(theme.fg("warning", `  ⚠ 同一失败签名 ×${t.sameSignatureCount},再失败一次将升级`));
	}
	if (t && t.inconclusiveStreak > 0) {
		lines.push(theme.fg("warning", `  ⚠ 连续 ${t.inconclusiveStreak} 次无法判定(环境可能漂移)`));
	}
	if (state.pendingHandoff) {
		lines.push(theme.fg("warning", `  ⏸ 等待换脑:${truncate(state.pendingHandoff, 40)} —— 执行 /mission next`));
	}
	return lines;
}

// ─────────────────────────── tab:概览 ───────────────────────────

export function overviewLines(plan: MissionPlan, state: MissionState, now = Date.now()): string[] {
	const done = Object.values(state.tasks).filter((x) => x.status === "done").length;
	const total = state.taskOrder.length;
	const lines = [
		`目标: ${plan.goal}`,
		`Mission: ${state.missionId} · ${state.tier} 档 · phase=${state.phase}` +
			(ROLE_OF[state.phase] ? ` · 角色 ${ROLE_OF[state.phase]}` : ""),
		`进度: ${bar(done, total)} ${done}/${total} 任务` +
			(plan.createdAt ? ` · 已运行 ${fmtDuration(plan.createdAt, now)}` : ""),
		`环境指纹: ${state.envFingerprint ?? "未冻结(PLAN 完成后记录)"}`,
		"",
	];

	const esc = state.escalation;
	lines.push(
		`升级阶梯: L${esc.level}` +
			(esc.history.length > 0
				? ` · 历史: ${esc.history.map((h) => `L${h.from}→L${h.to}(${h.taskId})`).join(", ")}`
				: " · 历史: 无"),
	);

	const costEntries = Object.entries(state.cost).filter(([, v]) => (v ?? 0) > 0);
	lines.push(
		costEntries.length > 0
			? `成本: ${costEntries.map(([r, v]) => `${r}=$${(v ?? 0).toFixed(3)}`).join("  ")} · 合计 $${costTotal(state).toFixed(3)}`
			: "成本: 尚无记录",
		"",
	);

	if (state.currentTask) {
		const t = state.tasks[state.currentTask];
		const pt = findTask(plan, state.currentTask);
		lines.push(
			`当前: ${state.currentTask} ${pt?.title ?? ""} · attempt ${t?.attempts ?? 0}/${thresholdFor(state.tier)}`,
		);
		if (t?.lastFailureReason) lines.push(`  上次失败: ${t.lastFailureReason}`);
		lines.push("");
	}
	if (state.pendingHandoff) lines.push(`⏸ 等待换脑: ${state.pendingHandoff} —— /mission next`);

	const sessions = Object.entries(state.sessionMap);
	if (sessions.length > 0) {
		lines.push(`会话: ${sessions.map(([task, f]) => `${task}→${f.split("/").pop()}`).join("  ")}`);
	}
	return lines;
}

// ─────────────────────────── tab:任务 ───────────────────────────

export function taskLines(plan: MissionPlan, state: MissionState): string[] {
	const lines: string[] = [];
	for (const [mi, ms] of plan.milestones.entries()) {
		if (mi > 0) lines.push("");
		if (plan.tier === "complex" || plan.milestones.length > 1) {
			const msDone = ms.tasks.every((t) => state.tasks[t.id]?.status === "done");
			lines.push(`${msDone ? "✓" : "▸"} ${ms.id} ${ms.title}`);
		}
		for (const t of ms.tasks) {
			const ts = state.tasks[t.id];
			const icon = TASK_ICON[ts?.status ?? "pending"] ?? "○";
			const verify = t.verify.length > 0 ? ` (verify: ${t.verify.join(", ")})` : "";
			lines.push(`  ${icon} ${t.id} ${t.title} · attempt ${ts?.attempts ?? 0}${verify}`);
			if (ts?.lastFailureReason && ts.status !== "done") {
				lines.push(`      上次失败: ${ts.lastFailureReason}`);
			}
			if (ts && ts.sameSignatureCount > 1) {
				lines.push(`      签名 ${ts.lastSignature} ×${ts.sameSignatureCount}`);
			}
		}
	}
	if (lines.length === 0) lines.push("(计划尚未冻结,无任务列表)");
	return lines;
}

// ─────────────────────────── tab:验收 ───────────────────────────

export function acLines(plan: MissionPlan, evidence: EvidenceSummary, dirName: string): string[] {
	const lines: string[] = [];
	if (plan.acceptanceCriteria.length === 0) {
		return plan.tier === "quick"
			? ["(quick 档:无 AC,判定依据是 --verify 冻结的验证命令)"]
			: ["(尚未冻结 AC:PLAN 相位调用 mission_write_plan 后显示)"];
	}
	lines.push(`冻结验收标准 · 执行入口 ./${dirName}/scripts/verify.sh <分支>`, "");
	for (const [i, ac] of plan.acceptanceCriteria.entries()) {
		if (i > 0) lines.push("");
		const ev = evidence.latest[ac.verify];
		const icon = ev ? (EV_ICON[ev.result] ?? "?") : "·";
		const where = ev?.taskId ? `${ev.taskId}-a${ev.attempt}` : null;
		const suffix = ev ? `[${ev.result}@${ev.level}${where ? ` · ${where}` : ""}]` : "[尚无证据]";
		lines.push(`${icon} ${ac.id} (\`${ac.verify}\`) ${suffix}`);
		lines.push(`    ${ac.text}`);
		if (ev?.rawTail) {
			for (const l of ev.rawTail.split("\n").filter(Boolean).slice(-4)) {
				lines.push(`    │ ${l}`);
			}
		}
	}
	return lines;
}

// ─────────────────────────── 扁平拼接(非 TUI 环境的卡片) ───────────────────────────

export function renderStatusDashboard(
	plan: MissionPlan,
	state: MissionState,
	evidence: EvidenceSummary,
	logTail: string[],
	dirName: string,
	now = Date.now(),
): string {
	const sections = [
		overviewLines(plan, state, now),
		["任务:", ...taskLines(plan, state).map((l) => (l ? `  ${l}` : l))],
		["验收:", ...acLines(plan, evidence, dirName).map((l) => (l ? `  ${l}` : l))],
	];
	if (logTail.length > 0) sections.push(["最近日志:", ...logTail.map((l) => `  ${l}`)]);
	return sections.map((s) => s.join("\n")).join("\n\n");
}

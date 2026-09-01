/**
 * pi-missions · ui/task-detail
 *
 * 任务详情的纯渲染层。展示:
 *   1. 任务定义、状态、所属里程碑、任务类型
 *   2. attempt 计数、失败签名、连续次数、上次失败原因
 *   3. verify 分支及关联验收标准 (AC)、baseline
 *   4. 全部 attempt 证据历史 (hard/semi 级别、退出码、完整 raw 输出)
 *   5. Spike 探针问题及书面结论
 *
 * 纯函数,不碰磁盘,不依赖 pi,可单测。
 */

import type { AcceptanceCriterion, PlanMilestone, PlanTask } from "../store/mission.ts";
import type { TaskEvidenceAttempt } from "../store/evidence.ts";
import type { TaskState, Tier } from "../core/types.ts";
import { thresholdFor } from "../core/breaker.ts";
import { clip, pad, ruleLabel, wrap } from "./chrome.ts";
import type { LineTheme } from "./dashboard.ts";

export interface TaskDetailData {
	task: PlanTask;
	taskState?: TaskState;
	milestone?: PlanMilestone;
	criteria: AcceptanceCriterion[];
	attempts: TaskEvidenceAttempt[];
	spikeReport?: string;
	tier?: Tier;
}

const PLAIN: LineTheme = { fg: (_c, s) => s, bold: (s) => s };

const LABEL_W = 10;

function field(t: LineTheme, label: string, value: string): string {
	return t.fg("muted", pad(label, LABEL_W)) + value;
}

function fieldWrapped(
	t: LineTheme,
	label: string,
	value: string,
	width: number,
	color?: string,
): string[] {
	const paint = (x: string) => (color ? t.fg(color, x) : x);
	const parts = wrap(value, Math.max(12, width - LABEL_W), 0);
	return parts.map((part, i) =>
		i === 0 ? field(t, label, paint(part)) : " ".repeat(LABEL_W) + paint(part),
	);
}

const TASK_STATUS_STYLE: Record<string, { icon: string; color: string; label: string }> = {
	done: { icon: "✓", color: "success", label: "已完成" },
	running: { icon: "▸", color: "accent", label: "进行中" },
	pending: { icon: "○", color: "dim", label: "待开始" },
	blocked: { icon: "✗", color: "error", label: "已阻塞" },
};

const EV_STYLE: Record<string, { icon: string; color: string }> = {
	pass: { icon: "✓", color: "success" },
	fail: { icon: "✗", color: "error" },
	inconclusive: { icon: "?", color: "warning" },
};

function fmtTime(ts: number): string {
	if (!ts) return "";
	const d = new Date(ts);
	const pad2 = (n: number) => String(n).padStart(2, "0");
	return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/** 任务详情全部内容行。长文本折行,不截断 */
export function renderTaskDetail(
	data: TaskDetailData,
	t: LineTheme = PLAIN,
	width = 96,
): string[] {
	const lines: string[] = [];
	const task = data.task;
	const state = data.taskState;
	const st = TASK_STATUS_STYLE[state?.status ?? "pending"] ?? TASK_STATUS_STYLE.pending;
	const threshold = thresholdFor(data.tier ?? "standard");

	// ── 1. 任务定义与状态 ──
	lines.push(ruleLabel(t, width, `任务定义 [${task.id}]`, true));
	lines.push(...fieldWrapped(t, "标题", task.title, width));
	lines.push(
		field(
			t,
			"状态",
			`${t.fg(st.color, `${st.icon} ${st.label}`)}  ${t.fg("dim", `(${state?.status ?? "pending"})`)}`,
		),
	);
	lines.push(
		field(
			t,
			"类型",
			task.kind === "spike" ? t.fg("accent", "spike (探针任务)") : t.fg("dim", "impl (代码实现)"),
		),
	);
	if (data.milestone) {
		lines.push(
			...fieldWrapped(t, "里程碑", `${data.milestone.id} ${data.milestone.title}`, width),
		);
	}

	// ── 2. 执行状态与失败历史 ──
	const attempts = state?.attempts ?? 0;
	lines.push(
		field(
			t,
			"尝试次数",
			`attempt ${attempts}/${threshold}` + (attempts >= threshold ? t.fg("warning", " (已达熔断阈值)") : ""),
		),
	);
	if (state?.lastSignature) {
		lines.push(
			field(
				t,
				"失败签名",
				`${t.fg("accent", state.lastSignature)}  ${t.fg(state.sameSignatureCount > 1 ? "warning" : "dim", `同一签名连续 ${state.sameSignatureCount} 次`)}`,
			),
		);
	}
	if (state?.inconclusiveStreak && state.inconclusiveStreak > 0) {
		lines.push(
			field(
				t,
				"环境漂移",
				t.fg("warning", `连续 ${state.inconclusiveStreak} 次无法判定`),
			),
		);
	}
	if (state?.lastFailureReason) {
		lines.push(...fieldWrapped(t, "上次失败", state.lastFailureReason, width, "error"));
	}

	lines.push("");

	// ── 3. 验收标准与验证入口 ──
	if (task.kind === "spike") {
		lines.push(ruleLabel(t, width, "探针目标"));
		lines.push(...fieldWrapped(t, "核心问题", task.question ?? "(未定义具体问题)", width, "accent"));
	} else {
		lines.push(ruleLabel(t, width, "验收标准与验证入口"));
		if (task.verify.length === 0) {
			lines.push(t.fg("dim", "  (无指定 verify 分支)"));
		} else {
			lines.push(field(t, "verify分支", task.verify.join(", ")));
			for (const v of task.verify) {
				const matchedCriteria = data.criteria.filter((c) => c.verify === v);
				if (matchedCriteria.length > 0) {
					for (const ac of matchedCriteria) {
						lines.push(
							`  ${t.fg("accent", ac.id)} ${t.fg("dim", `[verify: ${ac.verify}, baseline: ${ac.baseline ?? "red"}]`)}`,
						);
						for (const wrappedLine of wrap(ac.text, Math.max(12, width - 4), 0)) {
							lines.push(`    ${wrappedLine}`);
						}
					}
				} else {
					lines.push(`  ${t.fg("dim", `• 分支「${v}」无直接对应的显式 AC 正文`)}`);
				}
			}
		}
	}

	lines.push("");

	// ── 4. 全部 attempt 证据历史 ──
	lines.push(ruleLabel(t, width, `证据记录 (${data.attempts.length} 次尝试)`));
	if (data.attempts.length === 0) {
		lines.push(t.fg("dim", "  (暂无执行证据记录)"));
	} else {
		for (const [ai, att] of data.attempts.entries()) {
			if (ai > 0) lines.push("");
			const timeStr = att.at ? ` · ${fmtTime(att.at)}` : "";
			lines.push(`${t.fg("accent", `▶ Attempt ${att.attempt}`)}${t.fg("dim", timeStr)}`);
			if (!att.evidences || att.evidences.length === 0) {
				lines.push(t.fg("dim", "    (无具体证据条目)"));
				continue;
			}
			for (const ev of att.evidences) {
				const evSt = EV_STYLE[ev.result] ?? EV_STYLE.inconclusive;
				const exitStr = ev.exitCode !== undefined ? ` · exit=${ev.exitCode}` : "";
				lines.push(
					`  ${t.fg(evSt.color, evSt.icon)} ${t.fg(evSt.color, ev.result.toUpperCase())} ${t.fg("dim", `@${ev.level}`)}  ${t.fg("accent", ev.acId)}${t.fg("dim", exitStr)}`,
				);
				if (ev.raw && ev.raw.trim()) {
					for (const rawLine of ev.raw.trim().split("\n")) {
						for (const wl of wrap(rawLine, Math.max(12, width - 4), 0)) {
							lines.push(`    ${t.fg("dim", wl)}`);
						}
					}
				}
			}
		}
	}

	// ── 5. Spike 结论报告 ──
	if (task.kind === "spike") {
		lines.push("");
		lines.push(ruleLabel(t, width, "Spike 书面结论"));
		if (data.spikeReport && data.spikeReport.trim()) {
			for (const rLine of data.spikeReport.trim().split("\n")) {
				for (const wl of wrap(rLine, Math.max(12, width - 2), 0)) {
					lines.push(`  ${wl}`);
				}
			}
		} else {
			lines.push(t.fg("dim", "  (尚未生成 Spike 结论文件)"));
		}
	}

	return lines.map((l) => clip(l, width));
}

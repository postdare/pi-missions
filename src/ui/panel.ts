/**
 * pi-missions · ui/panel
 *
 * /missions 主面板(ctx.ui.custom,需 hasUI 守卫)。
 * 顶部三档新建入口,下方 mission 卡片列表 —— 全部从 missions/state/* 扫描重建(I1)。
 *
 * 卡片信息:目标 · 档位 · 相位 · 进度条 · 当前任务/attempt · 成本 · 时长 ·
 *           熔断预警 / 换脑挂起 / 失败原因 · 最近更新时间。
 * d 展开详情(升级历史 + 日志尾部)。
 */

import { Key, matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import { thresholdFor } from "../core/breaker.ts";
import { ROLE_OF } from "../core/machine.ts";
import { readLog } from "../store/log.ts";
import { scanMissions, type ScannedMission } from "../store/evidence.ts";
import { statePaths, type RepoLayout } from "../store/paths.ts";
import { bar, costTotal, fmtDuration, truncate } from "./dashboard.ts";

interface Theme {
	fg(color: string, text: string): string;
	bg(color: string, text: string): string;
	bold(text: string): string;
}

const PHASE_STYLE: Record<string, { icon: string; color: string; label: string }> = {
	plan: { icon: "◌", color: "accent", label: "规划" },
	do: { icon: "●", color: "accent", label: "执行" },
	check: { icon: "◍", color: "accent", label: "判定" },
	act: { icon: "●", color: "warning", label: "调整" },
	done: { icon: "✓", color: "success", label: "完成" },
	halted: { icon: "✕", color: "error", label: "熔断" },
};

const TIER_DESC: Array<{ id: string; desc: string }> = [
	{ id: "quick", desc: "单任务,不落盘,快速循环" },
	{ id: "standard", desc: "任务列表 + 验证闸门(默认)" },
	{ id: "complex", desc: "里程碑 + 独立验证 + 逐里程碑回归" },
];

function relTime(ts: number, now: number): string {
	const mins = Math.max(0, Math.round((now - ts) / 60_000));
	if (mins < 1) return "刚刚";
	if (mins < 60) return `${mins}min 前`;
	const hours = Math.floor(mins / 60);
	if (hours < 24) return `${hours}h 前`;
	return `${Math.floor(hours / 24)}d 前`;
}

/** 单个 mission 的卡片行 */
function missionCard(m: ScannedMission, selected: boolean, detail: boolean, t: Theme, width: number, now: number, l: RepoLayout): string[] {
	const s = m.state;
	const st = PHASE_STYLE[s.phase] ?? PHASE_STYLE.halted;
	const task = s.currentTask ? s.tasks[s.currentTask] : undefined;
	const planTask = s.currentTask ? m.plan?.milestones.flatMap((x) => x.tasks).find((x) => x.id === s.currentTask) : undefined;
	const doneCount = Object.values(s.tasks).filter((x) => x.status === "done").length;
	const total = s.taskOrder.length;
	const cost = costTotal(s);
	const threshold = thresholdFor(s.tier);
	const cursor = selected ? t.fg("accent", "▸") : " ";

	// 标题行:图标 + id + 档位 + 相位 + 更新时间
	const head =
		`${cursor} ${t.fg(st.color, st.icon)} ${t.bold(t.fg(st.color, m.missionId))}` +
		`  ${t.fg("dim", s.tier)}  ${t.fg(st.color, st.label)}` +
		(ROLE_OF[s.phase] ? t.fg("dim", `·${ROLE_OF[s.phase]}`) : "") +
		t.fg("dim", `  ${relTime(s.updatedAt, now)}`);

	const lines = [head];

	// 目标行
	if (m.plan?.goal) lines.push(`    ${t.fg("muted", truncate(m.plan.goal, width - 10))}`);

	// 进度行:进度条 + 当前任务 + attempt + 成本 + 时长
	const progress = total > 0 ? `${bar(doneCount, total)} ${doneCount}/${total}` : "—";
	const bits = [progress];
	if (s.currentTask && s.phase !== "done") {
		bits.push(`▶ ${s.currentTask}${planTask ? ` ${truncate(planTask.title, 20)}` : ""} · a${task?.attempts ?? 0}/${threshold}`);
	}
	if (cost > 0) bits.push(`$${cost.toFixed(2)}`);
	if (m.plan?.createdAt) {
		bits.push(s.phase === "done" || s.phase === "halted" ? `共 ${fmtDuration(m.plan.createdAt, s.updatedAt)}` : fmtDuration(m.plan.createdAt, now));
	}
	lines.push(`    ${bits.join(t.fg("dim", " · "))}`);

	// 预警行(按需):熔断临界 / 换脑挂起 / 失败原因 / 环境漂移
	if (task && task.sameSignatureCount >= threshold - 1 && task.sameSignatureCount > 0) {
		lines.push(`    ${t.fg("warning", `⚠ 同一失败签名 ×${task.sameSignatureCount},再失败一次将升级`)}`);
	}
	if (s.pendingHandoff) {
		lines.push(`    ${t.fg("warning", `⏸ 等待换脑: ${truncate(s.pendingHandoff, width - 20)}`)}`);
	}
	if (task?.lastFailureReason && s.phase !== "done") {
		lines.push(`    ${t.fg("dim", `✗ ${truncate(task.lastFailureReason, width - 12)}`)}`);
	}
	if (s.phase === "halted") {
		const last = s.escalation.history[s.escalation.history.length - 1];
		lines.push(
			`    ${t.fg("error", `止于 L${s.escalation.level}${last ? ` · ${truncate(last.reason, width - 16)}` : ""}`)}`,
		);
	}

	// 详情(d):升级历史 + 日志尾部
	if (detail) {
		if (s.escalation.history.length > 0) {
			lines.push(`    ${t.fg("dim", "升级历史:")}`);
			for (const h of s.escalation.history.slice(-4)) {
				lines.push(`      ${t.fg("dim", `L${h.from}→L${h.to} ${h.taskId} · ${truncate(h.reason, width - 22)}`)}`);
			}
		}
		const logTail = readLog(statePaths(l, m.missionId).logMd).trim().split("\n").filter(Boolean).slice(-8);
		if (logTail.length > 0 && logTail[0] !== "(暂无日志)") {
			lines.push(`    ${t.fg("dim", "日志:")}`);
			for (const line of logTail) lines.push(`      ${t.fg("dim", clip(line, width - 10))}`);
		}
	}
	return lines;
}

function clip(line: string, width: number): string {
	if (visibleWidth(line) <= width) return line;
	let out = line;
	while (out.length > 0 && visibleWidth(`${out}…`) > width) out = out.slice(0, -1);
	return `${out}…`;
}

export interface PanelCallbacks {
	/** ⏎ / r:恢复选中的 mission(面板先关闭) */
	onResume: (missionId: string) => void;
}

export async function openMissionsPanel(ctx: any, l: RepoLayout, cb: PanelCallbacks): Promise<void> {
	if (!ctx.hasUI) {
		const missions = scanMissions(l);
		if (missions.length === 0) {
			ctx.ui.notify("没有历史 mission。/mission new <目标> 新建", "info");
			return;
		}
		const lines = missions.map((m) => {
			const s = m.state;
			return `${s.missionId}  ${s.tier}  ${s.phase}  updated=${new Date(s.updatedAt).toISOString().slice(0, 16)}`;
		});
		ctx.ui.notify(lines.join("\n"), "info");
		return;
	}

	await ctx.ui.custom(
		(tui: any, theme: Theme, _kb: any, done: (r: void) => void) => {
			let missions = scanMissions(l);
			let selected = 0;
			let detail = false;
			let closed = false;

			const refresh = () => {
				try {
					missions = scanMissions(l);
					if (selected >= missions.length) selected = Math.max(0, missions.length - 1);
				} catch {
					/* keep last good */
				}
				if (!closed) tui.requestRender();
			};
			const timer = setInterval(refresh, 2_000);

			const close = () => {
				if (closed) return;
				closed = true;
				clearInterval(timer);
				done(undefined);
			};

			return {
				render: (w: number) => {
					const t = theme;
					const now = Date.now();
					const inner = Math.max(48, Math.min(w - 6, 104));
					const border = (s: string) => t.fg("borderAccent", s);
					const row = (content: string) => {
						const c = clip(content, inner - 4);
						const pad = Math.max(0, inner - 4 - visibleWidth(c));
						return t.bg("customMessageBg", `${border("│")} ${c}${" ".repeat(pad)} ${border("│")}`);
					};

					const title = " Missions ";
					const hint = " ↑↓ 选择 · ⏎ 恢复 · d 详情 · q 退出 ";
					const lines: string[] = [
						t.bg(
							"customMessageBg",
							border("╭─") +
								t.bold(t.fg("accent", title)) +
								border("─".repeat(Math.max(1, inner - 2 - visibleWidth(title) - visibleWidth(hint)))) +
								t.fg("dim", hint) +
								border("─╮"),
						),
					];

					// 新建入口(三档说明)
					lines.push(row(`${t.fg("accent", "+")} ${t.bold("新建任务")}`));
					for (const td of TIER_DESC) {
						const cmd = td.id === "quick" ? "/mission quick <任务>" : `/mission new <目标>${td.id === "complex" ? " --tier=complex" : ""}`;
						lines.push(row(`    ${t.fg("accent", td.id.padEnd(9))}${t.fg("dim", td.desc)}  ${t.fg("dim", cmd)}`));
					}
					lines.push(row(t.fg("dim", "─".repeat(Math.min(56, inner - 8)))));

					if (missions.length === 0) {
						lines.push(row(t.fg("dim", "暂无历史 mission")));
					}
					for (const [i, m] of missions.entries()) {
						if (i > 0) lines.push(row(""));
						for (const line of missionCard(m, i === selected, detail && i === selected, t, inner - 4, now, l)) {
							lines.push(row(line));
						}
					}

					lines.push(
						t.bg("customMessageBg", border("╰") + border("─".repeat(Math.max(1, inner - 2))) + border("╯")),
					);
					return lines;
				},
				invalidate: () => {},
				handleInput: (input: string) => {
					if (matchesKey(input, Key.escape) || matchesKey(input, "q")) return close();
					if (matchesKey(input, Key.up)) {
						selected = Math.max(0, selected - 1);
						return tui.requestRender();
					}
					if (matchesKey(input, Key.down)) {
						selected = Math.min(missions.length - 1, selected + 1);
						return tui.requestRender();
					}
					if (matchesKey(input, "d")) {
						detail = !detail;
						return tui.requestRender();
					}
					if (matchesKey(input, "n")) {
						close();
						ctx.ui.notify("运行 /mission new <目标> 或 /mission quick <任务>", "info");
						return;
					}
					if (matchesKey(input, Key.enter) || matchesKey(input, "r")) {
						const m = missions[selected];
						if (!m) return;
						close();
						cb.onResume(m.missionId);
					}
				},
			};
		},
		{ overlay: true, overlayOptions: { anchor: "center", width: "76%", margin: 1 } },
	);
}

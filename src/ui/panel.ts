/**
 * pi-missions · ui/panel
 *
 * /missions 主面板(ctx.ui.custom,需 hasUI 守卫)。
 * 顶部新建提示,下方历史列表 —— 从 missions/state/*\/STATE.json 扫描重建,不依赖内存(I1)。
 */

import { Key, matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import type { MissionState } from "../core/types.ts";
import { thresholdFor } from "../core/breaker.ts";
import { readLog } from "../store/log.ts";
import { scanMissions, type ScannedMission } from "../store/evidence.ts";
import { statePaths, type RepoLayout } from "../store/paths.ts";

interface Theme {
	fg(color: string, text: string): string;
	bg(color: string, text: string): string;
	bold(text: string): string;
}

const PHASE_STYLE: Record<string, { icon: string; color: string; label: string }> = {
	plan: { icon: "◌", color: "accent", label: "规划中" },
	do: { icon: "●", color: "accent", label: "执行中" },
	check: { icon: "●", color: "accent", label: "判定中" },
	act: { icon: "●", color: "warning", label: "调整中" },
	done: { icon: "○", color: "success", label: "已完成" },
	halted: { icon: "✕", color: "error", label: "已熔断" },
};

function truncate(line: string, width: number): string {
	if (visibleWidth(line) <= width) return line;
	let out = line;
	while (out.length > 0 && visibleWidth(`${out}…`) > width) out = out.slice(0, -1);
	return `${out}…`;
}

function missionSummary(m: ScannedMission, selected: boolean, t: Theme, width: number): string[] {
	const s: MissionState = m.state;
	const st = PHASE_STYLE[s.phase] ?? PHASE_STYLE.halted;
	const task = s.currentTask ? s.tasks[s.currentTask] : undefined;
	const done = Object.values(s.tasks).filter((x) => x.status === "done").length;
	const total = s.taskOrder.length;
	const cursor = selected ? t.fg("accent", "▸") : " ";

	const head = `${cursor} ${t.fg(st.color, st.icon)} ${t.bold(t.fg(st.color, s.missionId))}  ${s.tier}  ${done}/${total}  ${t.fg(st.color, st.label)}`;
	const lines = [head];

	const goal = s.tasks[s.currentTask ?? ""]?.lastFailureReason;
	if (s.phase !== "done" && s.currentTask) {
		lines.push(t.fg("dim", `    当前:${s.currentTask} · attempt ${task?.attempts ?? 0}`));
	}
	if (task && task.sameSignatureCount >= thresholdFor(s.tier) - 1 && task.sameSignatureCount > 0) {
		lines.push(t.fg("warning", `    ⚠ 同一失败签名 ×${task.sameSignatureCount},再失败一次将升级`));
	} else if (goal && s.phase !== "done") {
		lines.push(t.fg("dim", `    ${truncate(goal, width - 8)}`));
	}
	if (s.phase === "halted") {
		const last = s.escalation.history[s.escalation.history.length - 1];
		lines.push(t.fg("error", `    L${s.escalation.level}${last ? ` · ${truncate(last.reason, width - 12)}` : ""}`));
	}
	return lines;
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
					const inner = Math.max(40, Math.min(w - 6, 96));
					const border = (s: string) => t.fg("borderAccent", s);
					const row = (content: string) => {
						const clipped = truncate(content, inner - 4);
						const pad = Math.max(0, inner - 4 - visibleWidth(clipped));
						return t.bg("customMessageBg", `${border("│")} ${clipped}${" ".repeat(pad)} ${border("│")}`);
					};

					const lines: string[] = [];
					const title = " Missions ";
					const hint = " ↑↓ 选择 · ⏎ 恢复 · d 详情 · n 新建 · q 退出 ";
					lines.push(
						t.bg(
							"customMessageBg",
							border("╭─") +
								t.bold(t.fg("accent", title)) +
								border("─".repeat(Math.max(1, inner - 2 - visibleWidth(title) - visibleWidth(hint)))) +
								t.fg("dim", hint) +
								border("─╮"),
						),
					);

					lines.push(row(`${t.fg("accent", "+")} 新建任务:${t.fg("dim", "/mission quick <任务> 或 /mission new <目标> [--tier=complex]")}`));
					lines.push(row(t.fg("dim", "─".repeat(Math.min(40, inner - 8)))));

					if (missions.length === 0) {
						lines.push(row(t.fg("dim", "暂无历史 mission")));
					}
					for (const [i, m] of missions.entries()) {
						for (const line of missionSummary(m, i === selected, t, inner - 4)) lines.push(row(line));
						if (detail && i === selected) {
							const logTail = readLog(statePaths(l, m.missionId).logMd).trim().split("\n").slice(-6);
							for (const line of logTail) lines.push(row(t.fg("dim", `    ${line}`)));
						}
					}

					lines.push(
						t.bg(
							"customMessageBg",
							border("╰") + border("─".repeat(Math.max(1, inner - 2))) + border("╯"),
						),
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
		{ overlay: true, overlayOptions: { anchor: "center", width: "72%", margin: 1 } },
	);
}

/**
 * Mission Control — a live-refreshing modal overlay (pi-open-tui style) for
 * watching mission progress. Opened by /mission-status in TUI mode.
 *
 * Pattern follows pi-open-tui's settings dialog: ctx.ui.custom(factory,
 * { overlay: true }) with a component exposing render/invalidate/handleInput,
 * a refresh timer calling tui.requestRender(), and Esc/q to close.
 */
import { Key, matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { missionContentLines, type StatusCardData, type StatusCardMission } from "./status-card.ts";

interface Theme {
	fg(color: string, text: string): string;
	bg(color: string, text: string): string;
	bold(text: string): string;
}

const REFRESH_MS = 2_000;
const MAX_MISSIONS = 3;
const MAX_FEATURES_PER_MILESTONE = 8;

function truncate(line: string, width: number): string {
	if (visibleWidth(line) <= width) return line;
	// crude but safe: walk from the end until it fits (ANSI-aware enough via visibleWidth loop)
	let out = line;
	while (out.length > 0 && visibleWidth(out + "…") > width) out = out.slice(0, -1);
	return out + "…";
}

function renderOverlay(data: StatusCardData, theme: Theme, width: number, refreshedAt: Date): string[] {
	const t = theme;
	const inner = Math.max(36, Math.min(width - 6, 92));
	const bg = (s: string) => t.bg("customMessageBg", s);
	const border = (s: string) => t.fg("borderAccent", s);

	const lines: string[] = [];
	const title = " ⦿ Mission Control ";
	const clock = ` ${refreshedAt.toLocaleTimeString()} `;
	lines.push(
		bg(
			border("╭─") +
				t.bold(t.fg("accent", title)) +
				border("─".repeat(Math.max(1, inner - 2 - visibleWidth(title) - visibleWidth(clock)))) +
				t.fg("dim", clock) +
				border("─╮"),
		),
	);

	const row = (content: string) => {
		const clipped = truncate(content, inner - 4);
		const pad = Math.max(0, inner - 4 - visibleWidth(clipped));
		return bg(border("│ ") + " " + clipped + " ".repeat(pad) + " " + border(" │"));
	};

	const missions = (data.missions ?? []).slice(0, MAX_MISSIONS);
	if (missions.length === 0) {
		lines.push(row(t.fg("dim", "No missions yet. Start one with /mission <goal>")));
	}
	for (const [index, m] of missions.entries()) {
		if (index > 0) lines.push(row(""));
		const st = { running: "accent", completed: "success", failed: "error", stopped: "warning", pending: "dim" }[m.status] ?? "dim";
		lines.push(row(t.bold(t.fg(st, `${m.title}`)) + " " + t.fg(st, `[${m.status}]`)));
		// Reuse the shared content lines, with per-milestone feature truncation.
		const trimmed: StatusCardMission = {
			...m,
			milestones: (m.milestones ?? []).map((ms) => ({
				...ms,
				features: (ms.features ?? []).slice(0, MAX_FEATURES_PER_MILESTONE),
			})),
		};
		const hidden =
			(m.milestones ?? []).reduce((n, ms) => n + Math.max(0, (ms.features?.length ?? 0) - MAX_FEATURES_PER_MILESTONE), 0);
		for (const line of missionContentLines(trimmed, t)) lines.push(row(line));
		if (hidden > 0) lines.push(row(t.fg("dim", `  … +${hidden} more features`)));
	}

	lines.push(
		bg(
			border("╰─") +
				t.fg("dim", " Esc/q 关闭 · 每 2s 自动刷新 ") +
				border("─".repeat(Math.max(1, inner - 2 - visibleWidth(" Esc/q 关闭 · 每 2s 自动刷新 ")))) +
				border("─╯"),
		),
	);
	return lines;
}

/**
 * Open the Mission Control overlay. `getData` is called on open and on every
 * refresh tick; it should be cheap (ledger + state.json reads, no RPC).
 */
export async function openMissionControl(
	ctx: ExtensionContext,
	getData: () => Promise<StatusCardData> | StatusCardData,
): Promise<void> {
	await ctx.ui.custom<void>(
		(tui, theme, _kb, done) => {
			let data: StatusCardData = { missions: [] };
			let refreshedAt = new Date();
			let closed = false;

			const refresh = async () => {
				try {
					data = await getData();
					refreshedAt = new Date();
				} catch {
					// keep last good data
				}
				if (!closed) tui.requestRender();
			};
			const timer = setInterval(() => void refresh(), REFRESH_MS);
			void refresh();

			const close = () => {
				if (closed) return;
				closed = true;
				clearInterval(timer);
				done(undefined);
			};

			return {
				render: (w: number) => {
					try {
						return renderOverlay(data, theme as unknown as Theme, w, refreshedAt);
					} catch (err) {
						return [`[pi-missions] overlay render error: ${err instanceof Error ? err.message : String(err)}`];
					}
				},
				invalidate: () => {},
				handleInput: (input: string) => {
					if (matchesKey(input, Key.escape) || matchesKey(input, "q")) close();
				},
			};
		},
		{
			overlay: true,
			overlayOptions: { anchor: "center", width: "70%", margin: 1 },
		},
	);
}

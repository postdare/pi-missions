/**
 * Polished TUI rendering for /mission-status — rounded-border card with colored
 * status icons and progress bars, in the spirit of pi-open-tui.
 */
import { visibleWidth } from "@earendil-works/pi-tui";
import type { Mission } from "./ledger.ts";

export interface StatusCardMission {
	id: string;
	title: string;
	status: Mission["status"];
	runId?: string;
	startedAt?: string;
	endedAt?: string;
	error?: string;
	currentLabel?: string;
	featuresDone: number;
	featuresTotal: number;
	milestonesDone: number;
	milestonesTotal: number;
	milestones: Array<{
		id: string;
		title: string;
		status: string;
		features: Array<{ id: string; title: string; status: string }>;
	}>;
}

export interface StatusCardData {
	missions: StatusCardMission[];
}

const STATUS_STYLE: Record<string, { icon: string; color: "success" | "error" | "warning" | "accent" | "dim" }> = {
	done: { icon: "✓", color: "success" },
	completed: { icon: "✓", color: "success" },
	passed: { icon: "✓", color: "success" },
	running: { icon: "●", color: "accent" },
	active: { icon: "▸", color: "accent" },
	failed: { icon: "✗", color: "error" },
	stopped: { icon: "■", color: "warning" },
	pending: { icon: "○", color: "dim" },
	blocked: { icon: "✗", color: "error" },
};

function styleOf(status: string): { icon: string; color: "success" | "error" | "warning" | "accent" | "dim" } {
	return STATUS_STYLE[status] ?? STATUS_STYLE.pending;
}

function bar(done: number, total: number, width = 12): string {
	if (total <= 0) return "░".repeat(width);
	const filled = Math.round((done / total) * width);
	return "█".repeat(filled) + "░".repeat(Math.max(0, width - filled));
}

function duration(startedAt?: string, endedAt?: string): string | undefined {
	if (!startedAt) return undefined;
	const start = Date.parse(startedAt);
	const end = endedAt ? Date.parse(endedAt) : Date.now();
	if (Number.isNaN(start) || Number.isNaN(end)) return undefined;
	const secs = Math.max(0, Math.round((end - start) / 1000));
	if (secs < 60) return `${secs}s`;
	const mins = Math.floor(secs / 60);
	if (mins < 60) return `${mins}m${secs % 60}s`;
	return `${Math.floor(mins / 60)}h${mins % 60}m`;
}

interface Theme {
	fg(color: string, text: string): string;
	bg(color: string, text: string): string;
	bold(text: string): string;
}

/**
 * Content lines for one mission (meta, progress bars, current activity,
 * milestone tree) without any border — shared by the transcript card and the
 * Mission Control overlay.
 */
export function missionContentLines(m: StatusCardMission, t: Theme): string[] {
	const out: string[] = [];
	const meta: string[] = [t.fg("dim", m.id ?? "?")];
	if (m.runId) meta.push(t.fg("dim", `run ${m.runId.slice(0, 8)}`));
	const dur = duration(m.startedAt, m.endedAt);
	if (dur) meta.push(t.fg("dim", dur));
	out.push(meta.join(t.fg("dim", " · ")));

	out.push(
		`${t.fg("accent", bar(m.featuresDone ?? 0, m.featuresTotal ?? 0))} ${t.bold(`${m.featuresDone ?? 0}/${m.featuresTotal ?? 0}`)} features` +
			t.fg("dim", "   ") +
			`${t.fg("accent", bar(m.milestonesDone ?? 0, m.milestonesTotal ?? 0, 6))} ${t.bold(`${m.milestonesDone ?? 0}/${m.milestonesTotal ?? 0}`)} milestones`,
	);

	if (m.currentLabel) out.push(t.fg("accent", "▸ ") + t.fg("text", m.currentLabel));
	if (m.error) out.push(t.fg("error", `error: ${m.error}`));

	for (const ms of m.milestones ?? []) {
		if (!ms || typeof ms !== "object") continue;
		const msStyle = styleOf(ms.status ?? "pending");
		out.push(t.fg(msStyle.color, msStyle.icon) + " " + t.bold(ms.id ?? "?") + t.fg("dim", ` ${ms.title ?? ""}`));
		for (const f of Array.isArray(ms.features) ? ms.features : []) {
			const fStyle = styleOf(f.status);
			out.push(t.fg("dim", "  ") + t.fg(fStyle.color, fStyle.icon) + " " + t.fg("text", f.id) + t.fg("dim", ` ${f.title}`));
		}
	}
	return out;
}

/**
 * Rounded-border card. Implements the pi-tui Component interface directly so
 * the border can be laid out against the exact render width.
 */
export class MissionStatusCard {
	private readonly data: StatusCardData;
	private readonly theme: Theme;

	constructor(data: StatusCardData, theme: Theme) {
		this.data = data;
		this.theme = theme;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const t = this.theme;
		try {
			return this.renderSafe(width);
		} catch (err) {
			// A renderer must never take the whole TUI down.
			return [t.fg("error", `[pi-missions] status card render error: ${err instanceof Error ? err.message : String(err)}`)];
		}
	}

	private renderSafe(width: number): string[] {
		const t = this.theme;
		const data = this.data ?? { missions: [] };
		// Backward compatibility: pre-0.2 entries stored { text: string }.
		const legacyText = (data as { text?: unknown }).text;
		if (!Array.isArray(data.missions)) {
			if (typeof legacyText === "string") return legacyText.split("\n");
			return [t.fg("dim", "[pi-missions] no status data")];
		}
		const missions = data.missions.filter((m) => m && Array.isArray(m.milestones));
		if (missions.length === 0) return [t.fg("dim", "[pi-missions] no missions")];
		const inner = Math.max(30, Math.min(width - 2, 84));
		const out: string[] = [];
		const hr = (left: string, right: string) =>
			t.fg("borderMuted", left + "─".repeat(Math.max(0, inner - visibleWidth(left) - visibleWidth(right))) + right);
		const row = (content: string) => {
			const pad = Math.max(0, inner - 2 - visibleWidth(content));
			return t.fg("borderMuted", "│ ") + content + " ".repeat(pad) + t.fg("borderMuted", " │");
		};

		for (const [index, m] of missions.entries()) {
			if (index > 0) out.push("");
			const st = styleOf(m.status);
			const title = ` ${st.icon} ${m.title} `;
			const badge = ` ${m.status} `;
			out.push(
				t.fg("borderMuted", "╭─") +
					t.bold(t.fg(st.color, title)) +
					t.fg("borderMuted", "─".repeat(Math.max(1, inner - 2 - visibleWidth(title) - visibleWidth(badge)))) +
					t.fg(st.color, badge) +
					t.fg("borderMuted", "─╮"),
			);

			const content = missionContentLines(m, t);
			for (const line of content.slice(0, 2)) out.push(row(line));
			out.push(hr("├─", "─┤"));
			for (const line of content.slice(2)) out.push(row(line));
			out.push(hr("╰─", "─╯"));
		}
		return out;
	}
}

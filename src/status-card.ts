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
	bold(text: string): string;
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
		const inner = Math.max(30, Math.min(width - 2, 84));
		const out: string[] = [];
		const hr = (left: string, right: string) =>
			t.fg("borderMuted", left + "─".repeat(Math.max(0, inner - visibleWidth(left) - visibleWidth(right))) + right);
		const row = (content: string) => {
			const pad = Math.max(0, inner - 2 - visibleWidth(content));
			return t.fg("borderMuted", "│ ") + content + " ".repeat(pad) + t.fg("borderMuted", " │");
		};

		for (const [index, m] of this.data.missions.entries()) {
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

			const meta: string[] = [t.fg("dim", m.id)];
			if (m.runId) meta.push(t.fg("dim", `run ${m.runId.slice(0, 8)}`));
			const dur = duration(m.startedAt, m.endedAt ?? (m.status === "running" ? undefined : m.endedAt));
			if (dur) meta.push(t.fg("dim", dur));
			out.push(row(meta.join(t.fg("dim", " · "))));

			out.push(
				row(
					`${t.fg("accent", bar(m.featuresDone, m.featuresTotal))} ${t.bold(`${m.featuresDone}/${m.featuresTotal}`)} features` +
						t.fg("dim", "   ") +
						`${t.fg("accent", bar(m.milestonesDone, m.milestonesTotal, 6))} ${t.bold(`${m.milestonesDone}/${m.milestonesTotal}`)} milestones`,
				),
			);

			if (m.currentLabel) out.push(row(t.fg("accent", "▸ ") + t.fg("text", m.currentLabel)));
			if (m.error) out.push(row(t.fg("error", `error: ${m.error}`)));

			out.push(hr("├─", "─┤"));
			for (const ms of m.milestones) {
				const msStyle = styleOf(ms.status);
				out.push(row(t.fg(msStyle.color, msStyle.icon) + " " + t.bold(ms.id) + t.fg("dim", ` ${ms.title}`)));
				for (const f of ms.features) {
					const fStyle = styleOf(f.status);
					out.push(row(t.fg("dim", "  ") + t.fg(fStyle.color, fStyle.icon) + " " + t.fg("text", f.id) + t.fg("dim", ` ${f.title}`)));
				}
			}
			out.push(hr("╰─", "─╯"));
		}
		return out;
	}
}

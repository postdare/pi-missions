/**
 * pi-missions · ui/renderer
 *
 * verdict / 状态 / 日志卡片。关键:appendEntry 渲染的卡片只在 TUI 可见,
 * 不进 LLM 上下文 —— 所以可以写得详细而不消耗窗口。
 */

import { visibleWidth } from "@earendil-works/pi-tui";

interface Theme {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

export class TextCard {
	private readonly lines: (t: Theme) => string[];
	private readonly theme: Theme;

	constructor(lines: (t: Theme) => string[], theme: Theme) {
		this.lines = lines;
		this.theme = theme;
	}
	render(width: number): string[] {
		try {
			return this.lines(this.theme).map((l) => {
				if (visibleWidth(l) <= width) return l;
				let out = l;
				while (out.length > 0 && visibleWidth(`${out}…`) > width) out = out.slice(0, -1);
				return `${out}…`;
			});
		} catch {
			return ["[pi-missions] render error"];
		}
	}
	invalidate(): void {}
}

const ICON: Record<string, string> = { pass: "✓", fail: "✗", inconclusive: "?" };
const COLOR: Record<string, string> = { pass: "success", fail: "error", inconclusive: "warning" };

export interface VerdictCardData {
	missionId: string;
	taskId: string;
	attempt: number;
	verdict: { outcome: string; reason: string; signature?: string };
	evidences: Array<{ level: string; acId: string; result: string; exitCode?: number }>;
}

export function renderVerdictCard(t: Theme, d: VerdictCardData): string[] {
	const color = COLOR[d.verdict.outcome] ?? "dim";
	const lines = [
		t.bold(
			t.fg(
				color,
				` ${ICON[d.verdict.outcome] ?? "?"} CHECK ${d.verdict.outcome.toUpperCase()}  ${d.taskId} · attempt ${d.attempt}`,
			),
		),
	];
	for (const e of d.evidences) {
		lines.push(
			`   ${t.fg(COLOR[e.result] ?? "dim", ICON[e.result] ?? "?")} ${e.acId} ${t.fg("dim", `(${e.level}${e.exitCode != null ? `, exit=${e.exitCode}` : ""})`)}`,
		);
	}
	lines.push(`   ${t.fg("dim", d.verdict.reason)}`);
	if (d.verdict.signature) lines.push(`   ${t.fg("dim", `失败签名 ${d.verdict.signature}`)}`);
	return lines;
}

export function renderLogCard(t: Theme, title: string, content: string): string[] {
	return [t.bold(t.fg("accent", ` ${title}`),), ...content.split("\n").slice(-40).map((l) => `   ${l}`)];
}

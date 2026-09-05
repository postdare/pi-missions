/**
 * pi-missions · ui/board-detail
 *
 * 看板上按 Enter 弹出的动作原文。widget 只有几十列,路径被压成尾部两段;
 * 这一页把完整一行折开展示,不截断。
 */
import { Key, matchesKey } from "@earendil-works/pi-tui";
import { bodyHeight, boxBot, boxRow, boxTop, hintBar, windowLines, wrap } from "./chrome.ts";
import type { LineTheme } from "./dashboard.ts";

export interface BoardDetailView {
	theme: LineTheme & { bg?(color: string, s: string): string };
	width: number;
	rows: number;
	line: string;
	scroll?: number;
}

export interface BoardDetailRender {
	lines: string[];
	scroll: number;
}

export function renderBoardDetail(v: BoardDetailView): BoardDetailRender {
	const width = Math.max(40, v.width);
	const inner = width - 4;
	const body = wrap(v.line, inner);
	const height = bodyHeight(v.rows, 4, 1);
	const win = windowLines(body, v.scroll ?? 0, height, null);
	const pos = body.length > height ? `${win.start + 1}-${win.end} of ${body.length}` : undefined;
	return {
		lines: [
			boxTop(v.theme, width, "动作详情"),
			...win.lines.map((l) => boxRow(v.theme, width, l)),
			boxBot(v.theme, width),
			hintBar(v.theme, width, [["↑↓", "滚动"], ["Esc", "返回"]], pos),
		],
		scroll: win.offset,
	};
}

export async function openBoardDetail(ctx: any, line: string): Promise<void> {
	if (!line) return;
	if (!ctx.hasUI) {
		ctx.ui.notify(line, "info");
		return;
	}
	await ctx.ui.custom((tui: any, theme: BoardDetailView["theme"], _kb: unknown, done: (r: void) => void) => {
		let scroll = 0;
		return {
			render: (w: number) => {
				const rendered = renderBoardDetail({
					theme,
					width: w,
					rows: Number(tui.terminal?.rows) || 24,
					line,
					scroll,
				});
				scroll = rendered.scroll;
				return rendered.lines;
			},
			invalidate: () => {},
			handleInput: (data: string) => {
				if (matchesKey(data, Key.up)) {
					scroll = Math.max(0, scroll - 1);
					return tui.requestRender();
				}
				if (matchesKey(data, Key.down)) {
					scroll += 1;
					return tui.requestRender();
				}
				if (matchesKey(data, Key.escape) || matchesKey(data, Key.esc) || matchesKey(data, "q")) {
					done(undefined);
				}
			},
		};
	});
}

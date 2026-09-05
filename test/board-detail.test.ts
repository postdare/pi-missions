import { test } from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { renderBoardDetail } from "../src/ui/board-detail.ts";
import type { LineTheme } from "../src/ui/dashboard.ts";

const theme = {
	fg: (_c: string, s: string) => s,
	bold: (s: string) => s,
} as unknown as LineTheme & { bg?(color: string, s: string): string };

test("动作详情折行不截断 —— 看板把路径压成尾部两段,这一页要把原文还回去", () => {
	const line = "读取 /Users/kim/Projects/todo-list/internal/keymap/keymap.go";
	const rendered = renderBoardDetail({ theme, width: 56, rows: 24, line });
	const out = rendered.lines.join("\n");
	const restored = rendered.lines
		.slice(1, -2)
		.map((row) => row.slice(2, -2).trimEnd())
		.join("");
	assert.equal(restored.replaceAll(/\s/g, ""), line.replaceAll(/\s/g, ""));
	assert.match(out, /todo-list/);
	assert.doesNotMatch(out, /…/);
});

test("长动作详情可滚到底,不会因终端高度丢掉尾部", () => {
	const line = Array.from({ length: 100 }, (_, i) => `第${i + 1}段`).join("/");
	const first = renderBoardDetail({ theme, width: 56, rows: 20, line, scroll: 0 });
	const last = renderBoardDetail({ theme, width: 56, rows: 20, line, scroll: 999 });
	assert.match(first.lines.at(-1)!, /1-8 of/);
	assert.doesNotMatch(first.lines.join("\n"), /第100段/);
	assert.match(last.lines.join("\n"), /第100段/);
	assert.ok(last.scroll > 0);
});

test("终端矮到放不下时,正文塌成一行,但提示条还在", () => {
	// rows=10:这一页之外最坏要占 6 行,盒框 4 行,盒底+提示条 2 行 —— 一共 12 行,
	// 本来就放不下。旧公式在这里给 7 行正文,那 7 行里有 3 行其实在屏幕外。
	// 现在宁可把正文压到 1 行(还能滚),也要保住最后那条提示 —— 它是这页唯一的出口。
	const line = Array.from({ length: 100 }, (_, i) => `第${i + 1}段`).join("/");
	const r = renderBoardDetail({ theme, width: 56, rows: 10, line, scroll: 0 });
	assert.match(r.lines.at(-1)!, /1-1 of/, "提示条(带位置指示)必须是最后一行");
	assert.ok(r.lines.length < 10, `页面 ${r.lines.length} 行,得放得进 10 行的终端`);
});

test("盒行恰好铺满,提示条不越界", () => {
	const line = "读取 /Users/kim/Projects/todo-list/internal/codec/dto.go";
	for (const width of [40, 56, 80, 96, 200]) {
		const lines = renderBoardDetail({ theme, width, rows: 24, line }).lines;
		for (const [i, row] of lines.entries()) {
			const w = visibleWidth(row);
			if (/^[│╭╰]/.test(row)) {
				assert.equal(w, Math.max(40, width), `width=${width} 第 ${i} 行`);
			} else {
				assert.ok(w <= Math.max(40, width), `width=${width} 提示条 ${w}`);
			}
		}
	}
});

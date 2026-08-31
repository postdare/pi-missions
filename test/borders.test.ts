import { test } from "node:test";
import assert from "node:assert/strict";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/**
 * 边框宽度回归测试:任何 "╭─ + 内容 + ─╮" 这类构造,总可见宽度必须 ≤ inner。
 * 这类 bug 出现过两次:① 标题行右端是单个 ╮(1 列)时公式应为 inner-3 而非 inner-4,
 * 差一列导致右上/右下角对不上;② 窄屏下内容本身比 inner 宽,必须截断,否则超宽炸 TUI。
 */

function header(inner: number, title: string): string {
	// 与 status-view 相同:左边 ╭─(2 列),右边 ╮(1 列);title 先截断
	const t = truncateToWidth(title, inner - 6);
	const n = Math.max(1, inner - 3 - visibleWidth(t));
	return `╭─${t}${"─".repeat(n)}╮`;
}

function footer(inner: number, hint: string): string {
	const h = truncateToWidth(hint, inner - 6);
	const n = Math.max(1, inner - 3 - visibleWidth(h));
	return `╰─${h}${"─".repeat(n)}╯`;
}

const HINT = " Tab/←→ 切页 · ↑↓ 滚动 · r 刷新 · q/Esc 关闭 ";

test("非对称角 header/footer:内容放得下时总宽恰好 = inner", () => {
	for (const inner of [48, 60, 90, 100]) {
		assert.equal(visibleWidth(header(inner, " m1 · standard · do ")), inner, `header inner=${inner}`);
		assert.equal(visibleWidth(footer(inner, HINT)), inner, `footer inner=${inner}`);
	}
});

test("窄屏(内容比 inner 宽):截断后总宽 ≤ inner,绝不超宽", () => {
	for (const inner of [30, 40, 44, 46]) {
		assert.ok(visibleWidth(header(inner, " m1 · standard · do ")) <= inner, `header inner=${inner}`);
		assert.ok(visibleWidth(footer(inner, HINT)) <= inner, `footer inner=${inner}`);
	}
});

test("对称角(panel 风格):总宽 = inner", () => {
	const inner = 96;
	const title = " Missions ";
	const hint = " Tab 切换档位 · n 新建 · ↑↓ 选择 · ⏎ 恢复 · d 详情 · q 退出 ";
	const n = Math.max(1, inner - 4 - visibleWidth(title) - visibleWidth(hint));
	assert.equal(visibleWidth(`╭─${title}${"─".repeat(n)}${hint}─╮`), inner);
});

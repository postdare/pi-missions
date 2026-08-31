import { test } from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";

/**
 * 边框宽度回归测试:任何 "╭─ + 内容 + ─╮" 这类构造,总可见宽度必须等于 inner。
 * 这类 bug 出现过两次:标题行右端是单个 ╮(1 列)时公式应为 inner-3 而非 inner-4,
 * 差一列会导致右上/右下角对不上。
 */

function header(inner: number, title: string): string {
	// 与 status-view 相同的构造:左边 ╭─(2 列),右边 ╮(1 列)
	const n = Math.max(1, inner - 3 - visibleWidth(title));
	return `╭─${title}${"─".repeat(n)}╮`;
}

function footer(inner: number, hint: string): string {
	const n = Math.max(1, inner - 3 - visibleWidth(hint));
	return `╰─${hint}${"─".repeat(n)}╯`;
}

test("status-view 风格 header/footer 总宽 = inner(左右非对称角)", () => {
	for (const inner of [44, 60, 90, 100]) {
		const t = " m1 · standard · do ";
		const h = " Tab/←→ 切页 · ↑↓ 滚动 · r 刷新 · q/Esc 关闭 ";
		assert.equal(visibleWidth(header(inner, t)), inner, `header inner=${inner}`);
		assert.equal(visibleWidth(footer(inner, h)), inner, `footer inner=${inner}`);
	}
});

test("panel 风格 header 总宽 = inner(两端都是 2 列)", () => {
	const inner = 96;
	const title = " Missions ";
	const hint = " Tab 切换档位 · n 新建 · ↑↓ 选择 · ⏎ 恢复 · d 详情 · q 退出 ";
	const n = Math.max(1, inner - 4 - visibleWidth(title) - visibleWidth(hint));
	const line = `╭─${title}${"─".repeat(n)}${hint}─╮`;
	assert.equal(visibleWidth(line), inner);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	boxBot,
	boxRow,
	boxSep,
	boxTop,
	clip,
	contentBudget,
	hintBar,
	miniBar,
	wrap,
	ruleLabel,
	tabs,
	windowLines,
} from "../src/ui/chrome.ts";
import { filterMissions, missionRow, tableHeader, visibleCols } from "../src/ui/panel.ts";
import type { ScannedMission } from "../src/store/evidence.ts";
import type { MissionState } from "../src/core/types.ts";

/**
 * 圆角盒内联页框架(chrome.ts)+ 任务页表格(panel.ts 纯函数)回归测试。
 * 历史教训:宽度公式差一列/窄屏超宽炸过 TUI。不变式:
 *   ① 任何一行可见宽度 ≤ width,绝不超宽(超宽会撑破布局);
 *   ② 盒顶/盒底/盒行恰好铺满整行,盒行与盒边框对齐;
 *   ③ 窗口化必须保证锚点(选中项)完整可见;
 *   ④ 筛选与表格行的列对齐。
 */

// 真 ANSI 码:visibleWidth/truncateToWidth 会忽略转义序列,用可见字符模拟颜色会污染宽度断言
const theme = {
	fg: (_color: string, s: string) => `\x1b[31m${s}\x1b[0m`,
	bg: (_color: string, s: string) => `\x1b[44m${s}\x1b[49m`,
	bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

const WIDTHS = [40, 60, 96, 120];

test("boxTop/boxBot/boxSep:可见宽度恰好 = width,窄屏至少 4 列", () => {
	for (const w of [0, 1, 4, 30, 200]) {
		const mw = Math.max(4, w);
		assert.equal(visibleWidth(boxTop(theme, w)), mw, `boxTop width=${w}`);
		assert.equal(visibleWidth(boxSep(theme, w)), mw, `boxSep width=${w}`);
		assert.equal(visibleWidth(boxBot(theme, w)), mw, `boxBot width=${w}`);
	}
});

test("boxTop 带标题:标题嵌在顶边,总宽不变", () => {
	for (const w of WIDTHS) {
		assert.equal(visibleWidth(boxTop(theme, w, "Missions")), w, `boxTop title width=${w}`);
	}
});

test("boxTop 带 meta:meta 靠右嵌在顶边;放不下就丢掉 meta 而不是撑破", () => {
	for (const w of WIDTHS) {
		assert.equal(visibleWidth(boxTop(theme, w, "MISSIONS", "5 个 mission")), w, `boxTop meta width=${w}`);
	}
	assert.ok(boxTop(theme, 96, "MISSIONS", "5 个 mission").includes("5 个 mission"));
	// 窄到放不下:仍然恰好铺满,且不含 meta
	const narrow = boxTop(theme, 20, "MISSIONS", "5 个 mission");
	assert.equal(visibleWidth(narrow), 20);
	assert.ok(!narrow.includes("5 个 mission"));
});

test("boxRow:内容截断/补足后总宽恰好 = width,长内容不撑破", () => {
	const long = theme.fg("accent", "x".repeat(300));
	for (const w of WIDTHS) {
		assert.equal(visibleWidth(boxRow(theme, w, "")), w);
		assert.equal(visibleWidth(boxRow(theme, w, "短内容")), w);
		assert.ok(visibleWidth(boxRow(theme, w, long)) <= w, `boxRow long width=${w}`);
	}
});

test("boxRow highlight:铺满内宽的背景色,宽度不变;主题没 bg 时安全退化", () => {
	for (const w of WIDTHS) {
		const row = boxRow(theme, w, "选中项", { highlight: true });
		assert.equal(visibleWidth(row), w, `highlight width=${w}`);
		assert.ok(row.includes("\x1b[44m"), "必须真的上了背景色");
	}
	const noBg = { fg: theme.fg, bold: theme.bold };
	assert.equal(visibleWidth(boxRow(noBg, 60, "选中项", { highlight: true })), 60);
});

test("miniBar:宽度恒等于要求的列数,满进度用 success 色", () => {
	const colors: string[] = [];
	const spy = { fg: (c: string, s: string) => (colors.push(c), s), bold: (s: string) => s };
	for (const w of [1, 5, 8, 20]) {
		assert.equal(visibleWidth(miniBar(theme, 3, 8, w)), w, `miniBar width=${w}`);
		assert.equal(visibleWidth(miniBar(theme, 0, 0, w)), w, "total=0 也要占满");
	}
	colors.length = 0;
	miniBar(spy, 4, 4, 5);
	assert.ok(colors.includes("success"), "跑完了就该是成功色,不再是 accent");
});

test("miniBar 不用 ░:那个字形在很多等宽字体里是一整块实心灰板", () => {
	for (const [done, total] of [[0, 5], [3, 8], [4, 4], [0, 0]]) {
		const b = miniBar(theme, done, total, 10).replace(/\x1b\[[0-9;]*m/g, "");
		assert.ok(!b.includes("░") && !b.includes("▒"), `阴影块字符不许出现: ${b}`);
	}
});

test("wrap:按可见宽度折行,中文硬断,英文优先断在空格", () => {
	const cjk = "新增 Antix AI 额度 widget:像 DeepSeek 一样显示账户余额并复用现有外观";
	for (const w of [16, 24, 40]) {
		for (const line of wrap(cjk, w)) {
			assert.ok(visibleWidth(line) <= w, `w=${w} 折行后仍超宽: ${line}`);
		}
	}
	// 英文不该被劈开在单词中间
	const en = wrap("the quick brown fox jumps over the lazy dog", 20);
	assert.ok(en.every((l) => visibleWidth(l) <= 20));
	assert.ok(!en.some((l) => l.startsWith(" ")), "断行处不留前导空格");
	// maxLines 截断:最后一行带省略号,总行数不超
	const capped = wrap(cjk, 16, 2);
	assert.equal(capped.length, 2);
	assert.ok(capped[1].endsWith("…"));
	assert.ok(capped.every((l) => visibleWidth(l) <= 16));
	// 空串也要给一行,调用方直接取 [0] 不能炸
	assert.deepEqual(wrap("", 20), [""]);
});

test("ruleLabel:标签 + 横线恰好铺满给定宽度", () => {
	for (const w of [20, 40, 92]) {
		assert.equal(visibleWidth(ruleLabel(theme, w, "概览")), w, `ruleLabel width=${w}`);
		assert.equal(visibleWidth(ruleLabel(theme, w, "任务 3/9", true)), w);
	}
});

test("hintBar:键名+描述,右侧位置指示右对齐,总宽 ≤ width", () => {
	const hints: Array<[string, string]> = [["↑↓", "导航"], ["Enter", "选择"], ["Tab", "档位"]];
	for (const w of WIDTHS) {
		assert.ok(visibleWidth(hintBar(theme, w, hints)) <= w);
		const withRight = hintBar(theme, w, hints, "1-4 of 5");
		assert.ok(visibleWidth(withRight) <= w, `hintBar right width=${w}`);
		// 窄屏时左侧提示过长会截掉右指示,只保证不超宽;宽屏必须完整保留
		if (w >= 96) assert.ok(withRight.includes("1-4 of 5"));
	}
});

test("tabs:活动项是背景色药丸,非活动项同宽 dim 文字", () => {
	const items = [{ id: "a", label: "任务" }, { id: "b", label: "模型" }];
	const line = tabs(theme, items, "b");
	assert.ok(line.includes("\x1b[44m"), "活动页签铺背景色");
	assert.ok(line.includes("\x1b[1m"), "活动页签加粗");
	// 贴着盒子左边框的位置不许出现竖线 —— 会被读成"边框裂了一道"
	assert.ok(!line.includes("▎") && !line.includes("┃"), "页签不用竖条");
	// 两种状态的列宽一致 —— 切页时标签不会左右跳
	assert.equal(visibleWidth(line), visibleWidth(tabs(theme, items, "a")));
	// 主题没给 bg 时也要能用
	assert.ok(tabs({ fg: theme.fg, bold: theme.bold }, items, "b").includes("模型"));
});

test("contentBudget:夹在 [10,30],预留聊天区", () => {
	assert.equal(contentBudget(5), 10);
	assert.equal(contentBudget(24), 18);
	assert.equal(contentBudget(60), 30);
});

test("windowLines:内容不超窗口时原样返回,offset 归零", () => {
	const all = ["a", "b", "c"];
	const r = windowLines(all, 7, 10, null);
	assert.deepEqual(r.lines, all);
	assert.equal(r.offset, 0);
});

test("windowLines:锚点(选中项)永远完整可见", () => {
	const all = Array.from({ length: 30 }, (_, i) => `line-${i}`);
	const r = windowLines(all, 0, 10, { start: 25, end: 28 });
	assert.equal(r.lines.length, 10);
	assert.ok(r.lines.includes("line-25") && r.lines.includes("line-27"), "锚点完整可见");
	assert.equal(r.offset + 10, 28, "窗口底恰好贴住锚点尾");
	const r2 = windowLines(all, 20, 10, { start: 0, end: 3 });
	assert.equal(r2.offset, 0);
	assert.ok(r2.lines.includes("line-0"));
});

// ─────────────────────────── panel 纯函数 ───────────────────────────

function fakeMission(id: string, goal: string, phase: string, tier = "standard"): ScannedMission {
	const state = {
		missionId: id,
		tier,
		phase,
		tasks: {},
		taskOrder: ["T1", "T2"],
		currentTask: "T1",
		cost: {},
		escalation: { level: 1, history: [] },
		sessionMap: {},
		envFingerprint: null,
		updatedAt: Date.now(),
	} as unknown as MissionState;
	return { missionId: id, state, plan: { goal } as ScannedMission["plan"], stateDir: "/tmp/x" };
}

const MISSIONS = [
	fakeMission("m-aaa", "CMS 管理端 REST 重构", "do"),
	fakeMission("m-bbb", "New Session 落盘", "plan", "quick"),
	fakeMission("m-ccc", "验证链路改造", "done", "complex"),
];

test("filterMissions:id/目标/相位/档位小写包含,空串不过滤", () => {
	assert.equal(filterMissions(MISSIONS, "").length, 3);
	assert.equal(filterMissions(MISSIONS, "cms").length, 1);
	assert.equal(filterMissions(MISSIONS, "M-CCC").length, 1);
	assert.equal(filterMissions(MISSIONS, "plan").length, 1); // 相位匹配
	assert.equal(filterMissions(MISSIONS, "quick").length, 1);
	assert.equal(filterMissions(MISSIONS, "不存在").length, 0);
});

test("tableHeader/missionRow:列对齐且不超宽", () => {
	for (const w of WIDTHS) {
		const inner = w - 4;
		for (const [i, m] of MISSIONS.entries()) {
			const row = missionRow(m, i === 1, theme, inner, Date.now());
			assert.ok(visibleWidth(row) <= inner, `row width=${w}: ${visibleWidth(row)}`);
			if (i === 1) assert.ok(row.includes("\x1b[1m"), "选中行加粗");
		}
		assert.ok(visibleWidth(tableHeader(theme, inner)) <= inner, `tableHeader width=${w}`);
	}
});

test("窄屏按重要性丢列:先丢档位,再丢进度,目标永远保留", () => {
	assert.deepEqual(visibleCols(92), { tier: true, progress: true });
	assert.deepEqual(visibleCols(60), { tier: false, progress: true });
	assert.deepEqual(visibleCols(36), { tier: false, progress: false });
	const row = missionRow(MISSIONS[0], false, theme, 36, Date.now());
	assert.ok(row.includes("CMS"), "窄屏也要看得到目标");
	assert.ok(!row.includes("standard"), "窄屏丢掉档位列");
});

test("missionRow:熔断临界时状态列换成 ⚠ 警告色", () => {
	const m = fakeMission("m-ddd", "临界任务", "do");
	(m.state as any).pendingHandoff = "等待换脑";
	const row = missionRow(m, false, theme, 96, Date.now());
	assert.ok(row.includes("⚠"));
	assert.ok(!row.includes("●"));
});

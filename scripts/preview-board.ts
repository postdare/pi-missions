/**
 * 子 agent 执行看板的离线预览 —— 不起 pi。
 *
 *   COLUMNS=56 node --experimental-strip-types scripts/preview-board.ts all
 *
 * 段:collapsed(收起)/ expanded(展开)/ scout(侦查扇出)/ idle(没有子 agent)
 */

import { renderBoard, type BoardView } from "../src/ui/board.ts";
import type { LineTheme } from "../src/ui/dashboard.ts";

const width = Number(process.env.COLUMNS ?? 96);
const now = Date.now();

const C: Record<string, string> = {
	accent: "\x1b[36m",
	dim: "\x1b[90m",
	fg: "",
	warning: "\x1b[33m",
	error: "\x1b[31m",
	success: "\x1b[32m",
	muted: "\x1b[90m",
};
const theme: LineTheme = {
	fg: (c: string, s: string) => `${C[c] ?? ""}${s}\x1b[0m`,
	bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
} as LineTheme;

// 真机 E2 那一轮 verifier 的轨迹形状(30 条,这里取 12 条代表)
const TRACE = [
	"初始化独立 AgentSession",
	"分析冻结验收标准",
	"完成第 2 轮核验",
	"浏览 /Users/kim/Projects/todo-list/internal",
	"浏览 /Users/kim/Projects/todo-list/internal/schema",
	"读取 /Users/kim/Projects/todo-list/internal/codec/dto.go",
	"完成第 5 轮核验",
	"查找 **/*_test.go",
	"读取 /Users/kim/Projects/todo-list/internal/todo/recurrence_test.go",
	"完成第 8 轮核验",
	"读取 /Users/kim/Projects/todo-list/internal/api/handler.go",
	"读取 /Users/kim/Projects/todo-list/internal/keymap/keymap.go",
];

const check = {
	taskId: "T1",
	attempt: 1,
	startedAt: now - 94_000,
	updatedAt: now,
	stage: "running_verifier",
	completedBranches: [],
	verifier: { status: "running", startedAt: now - 88_000, turns: 11, toolCalls: 22, trace: TRACE },
} as never;

const base: BoardView = { expanded: false, selected: -1, scroll: 0, check, now, width };

const modes: Record<string, () => { label: string; v: BoardView }> = {
	collapsed: () => ({ label: "收起态(常驻,只占 1 行)", v: base }),
	expanded: () => ({ label: "展开态(跟随最新一条)", v: { ...base, expanded: true } }),
	scrolled: () => ({ label: "展开态(选中第 3 条,窗口跟着走)", v: { ...base, expanded: true, selected: 2 } }),
	scout: () => ({
		label: "侦查扇出(PLAN 相位)",
		v: {
			...base,
			expanded: true,
			check: null,
			scout: {
				startedAt: now - 32_000,
				progress: {
					done: 1,
					total: 4,
					running: ["S2", "S3"],
					activity: {
						S1: "已交回结论",
						S2: "读 /Users/kim/Projects/todo-list/internal/keymap/default.go",
						S3: "搜 recurrence",
						S4: "排队中",
					},
				},
			},
		},
	}),
	idle: () => ({ label: "没有子 agent 在跑(整块不出现)", v: { ...base, check: null } }),
};

const want = process.argv[2] ?? "all";
for (const [name, make] of Object.entries(modes)) {
	if (want !== "all" && want !== name) continue;
	const { label, v } = make();
	console.log(`\n── width=${width} · ${name} · ${label} ──`);
	const lines = renderBoard(v, theme);
	if (lines.length === 0) console.log("(空 —— 调用方据此把 widget 摘掉)");
	for (const l of lines) console.log(l);
	console.log(`   [${lines.length} 行]`);
}

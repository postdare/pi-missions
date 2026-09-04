/**
 * mission_scout 工具块 + 常驻卡扇出行的离线预览。不起 pi,直接渲染到 stdout。
 *
 * 用法:
 *   node --experimental-strip-types scripts/preview-scout.ts            # 全部四态
 *   COLUMNS=56 node --experimental-strip-types scripts/preview-scout.ts  # 窄终端
 *   node --experimental-strip-types scripts/preview-scout.ts call        # 只看调用块
 *   node --experimental-strip-types scripts/preview-scout.ts running     # 扇出进行中
 *   node --experimental-strip-types scripts/preview-scout.ts done        # 回来了(折叠)
 *   node --experimental-strip-types scripts/preview-scout.ts expanded    # 回来了(展开)
 *   node --experimental-strip-types scripts/preview-scout.ts widget      # 常驻卡那一行
 */
import { renderScoutCall, renderScoutResult } from "../src/ui/scout-view.ts";
import { renderWidgetCard } from "../src/ui/dashboard.ts";
import { initialState } from "../src/core/machine.ts";
import type { ScoutFinding } from "../src/core/scout.ts";
import type { MissionPlan } from "../src/store/mission.ts";

const theme = {
	fg: (c: string, s: string) => (c === "dim" || c === "muted" ? `\x1b[90m${s}\x1b[0m` : `\x1b[36m${s}\x1b[0m`),
	bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

const width = Number(process.env.COLUMNS) || 100;
const mode = process.argv[2] ?? "all";

const questions = [
	{ id: "S1", text: "旧 ORM 的私有 API 在哪些文件里被用到、共几处?按文件列出来" },
	{ id: "S2", text: "有没有现成的集成测试能挂 AC" },
	{ id: "S3", text: "分页参数是从哪个配置读的" },
	{ id: "S4", text: "迁移脚本里还有没有直接拼 SQL 的地方" },
];

const findings: ScoutFinding[] = [
	{
		id: "S1",
		question: questions[0].text,
		assume: "3 处左右,集中在 repo 层",
		answer: "11 处,集中在 src/repo 下的 4 个文件,另有 2 处在 scripts/ 的迁移脚本里",
		status: "answered",
		citations: ["src/repo/user.ts:88", "src/repo/order.ts:31", "scripts/migrate.ts:14"],
		surprised: true,
	},
	{
		id: "S2",
		question: questions[1].text,
		assume: "有",
		answer: "有,test/orm/*.test.ts 共 12 个用例,都走真实 sqlite",
		status: "answered",
		citations: ["test/orm/user.test.ts:1"],
		surprised: false,
	},
	{
		id: "S3",
		question: questions[2].text,
		assume: "从 config.yaml 读",
		answer: "未查明(超过 180s 或被中止)。沿用假设:从 config.yaml 读",
		status: "unanswered",
		citations: [],
		surprised: false,
	},
	{
		id: "S4",
		question: questions[3].text,
		assume: "没有了",
		answer: "没有了,最后一处在 3 个月前被删掉",
		status: "answered",
		citations: ["scripts/migrate.ts"],
		surprised: false,
	},
];

const progress = {
	done: 1,
	total: 4,
	activity: { S1: "已交回结论", S2: "读 src/repo/user.ts", S3: "搜 privateApi", S4: "排队中" },
	running: ["S2", "S3", "S4"],
};

const plan: MissionPlan = {
	missionId: "2026-09-04-mission-orm",
	tier: "standard",
	goal: "把旧 ORM 换成新的查询层",
	acceptanceCriteria: [],
	milestones: [{ id: "M1", title: "only", tasks: [] }],
	verifyScript: "",
	createdAt: Date.now() - 600_000,
};

function section(title: string, lines: string[]): void {
	console.log(`\n\x1b[7m ${title} \x1b[0m ${"─".repeat(Math.max(0, width - title.length - 4))}`);
	console.log(lines.join("\n"));
}

if (mode === "all" || mode === "call") {
	section("调用块", renderScoutCall({ theme, width, questions }));
}
if (mode === "all" || mode === "running") {
	section("扇出中", renderScoutResult({ theme, width, expanded: false, details: { kind: "progress", progress } }));
}
if (mode === "all" || mode === "done") {
	section(
		"回来了(折叠)",
		renderScoutResult({ theme, width, expanded: false, details: { kind: "done", round: 1, findings } }),
	);
}
if (mode === "all" || mode === "expanded") {
	section(
		"回来了(展开)",
		renderScoutResult({ theme, width, expanded: true, details: { kind: "done", round: 1, findings } }),
	);
}
if (mode === "all" || mode === "widget") {
	const s = initialState({ missionId: plan.missionId, tier: "standard", taskOrder: ["T1"] });
	s.phase = "plan";
	s.currentTask = null;
	section(
		"常驻卡(扇出中)",
		renderWidgetCard(theme, plan, s, Date.now(), width, null, { startedAt: Date.now() - 72_000, progress }),
	);
}

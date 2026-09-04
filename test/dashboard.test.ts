import { test } from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { PHASE_STYLE, checkProgressLines, overviewLines, renderStatusDashboard, renderWidgetCard, shortId, shortenActivity, taskBlocks, taskLines } from "../src/ui/dashboard.ts";
import { initialState } from "../src/core/machine.ts";
import type { MissionPlan } from "../src/store/mission.ts";

const plan: MissionPlan = {
	missionId: "auth-refactor",
	tier: "standard",
	goal: "迁移登录鉴权到 JWT",
	acceptanceCriteria: [
		{ id: "AC1", text: "登录链路集成测试全绿", verify: "auth-integration" },
		{ id: "AC2", text: "接口契约不变", verify: "contract-snapshot" },
	],
	milestones: [
		{
			id: "M1",
			title: "m",
			tasks: [
				{ id: "T1", title: "引入 JwtProvider", verify: ["compile"] },
				{ id: "T2", title: "迁移登录端点", verify: ["auth-integration"] },
			],
		},
	],
	verifyScript: "#!/usr/bin/env bash\n",
	createdAt: Date.now() - 5 * 60_000,
};

function runningState(): ReturnType<typeof initialState> {
	const s = initialState({ missionId: "auth-refactor", tier: "standard", taskOrder: ["T1", "T2"] });
	s.phase = "do";
	s.currentTask = "T2";
	s.tasks.T1 = { ...s.tasks.T1, status: "done", attempts: 1 };
	s.tasks.T2 = {
		...s.tasks.T2,
		status: "running",
		attempts: 2,
		lastSignature: "abc123",
		sameSignatureCount: 2,
		lastFailureReason: "AuthIntegrationTest#refreshToken 断言失败",
	};
	s.cost = { executor: 0.87, verifier: 0.09 };
	return s;
}

// 模拟主题:fg 记录颜色但不注入可见标记(否则 visibleWidth 会把标记当字符,截断测试失真)
const usedColors: string[] = [];
const mockTheme = {
	fg: (color: string, s: string) => {
		usedColors.push(color);
		return s;
	},
	bold: (s: string) => s,
};

test("widget:身份/goal/进度/成本/熔断预警(多任务才显示进度条)", () => {
	usedColors.length = 0;
	const lines = renderWidgetCard(mockTheme, plan, runningState(), Date.now(), 120);
	assert.ok(lines[0].includes("auth-refactor"), "没有日期前缀的 id 原样上屏,不许砍成 refactor");
	assert.ok(lines[0].includes("standard"));
	assert.ok(lines[0].includes("● 执行"), "相位显示成带图标的中文,不是 phase=do");
	assert.ok(lines[0].includes("迁移登录鉴权到 JWT"), "goal 上屏在行 1");
	assert.ok(!lines.some((l) => l.includes("executor")), "role 是 phase 的纯函数,不再重复显示");
	assert.ok(lines[1].includes("T2"));
	assert.ok(lines[1].includes("attempt 2/3"));
	assert.ok(lines[1].includes("1/2")); // 多任务:进度条在第二行
	assert.ok(lines[0].includes("$0.96"), "成本右对齐在行 1");
	assert.ok(lines.some((l) => l.includes("同一失败签名 ×2")), "熔断临界必须可见");
	// 临界 attempt 与预警都用了 warning 色
	assert.ok(usedColors.includes("warning"));
	// mission id 用了 accent
	assert.ok(usedColors.includes("accent"));
});

test("widget:id 只剥日期前缀,省下的列给 goal", () => {
	const s = runningState();
	s.missionId = "2026-09-03-mission-mtl9aicc";
	const lines = renderWidgetCard(mockTheme, { ...plan, missionId: s.missionId }, s, Date.now(), 120);
	assert.ok(lines[0].includes("mission-mtl9aicc"), `短 id 上屏:${lines[0]}`);
	assert.ok(!lines[0].includes("2026-09-03"), "日期前缀不再占列");
	assert.equal(visibleWidth(lines[0]), 120, "goal 放得下时成本仍右对齐");
});

test("shortId:只剥日期前缀 —— 取末段会把拉丁 goal 的 slug 扔掉", () => {
	// id 的构造是 <日期>-<slugify(goal)>,拉丁 goal 的 id 本身就是 goal
	assert.equal(shortId("2026-09-03-migrate-auth-to-jwt"), "migrate-auth-to-jwt");
	assert.equal(shortId("2026-09-03-mission-mtl9aicc"), "mission-mtl9aicc");
	assert.equal(shortId("auth-refactor"), "auth-refactor", "没有日期前缀就原样返回");
	assert.equal(shortId("nodash"), "nodash");
});

const LONG_GOAL =
	"把登录鉴权整体迁移到 JWT,包括刷新令牌轮换、多设备踢下线与审计日志落盘,并保证旧客户端在灰度期内继续可用";

test("widget:goal 再长也不吃高度,也不挤掉时长/成本", () => {
	// widget 是常驻 chrome,高度是永久成本。goal 全程不变,截断即可;
	// 曾经这里用 wrap,COLUMNS=56 + 一个正常长度的中文 goal 就涨到 12 行。
	const s = runningState();
	const p = { ...plan, goal: LONG_GOAL };
	for (const width of [56, 72, 80, 120, 200]) {
		const short = renderWidgetCard(mockTheme, plan, s, Date.now(), width);
		const long = renderWidgetCard(mockTheme, p, s, Date.now(), width);
		assert.equal(long.length, short.length, `goal 长短不改变行数 @${width}`);
	}
	// 右侧账目在任何宽度下都不许被 goal 吃掉
	for (const width of [80, 120, 200]) {
		const lines = renderWidgetCard(mockTheme, p, s, plan.createdAt + 5 * 60_000, width);
		assert.ok(lines[0].includes("$0.96"), `长 goal 下成本仍在行 1 @${width}:${lines[0]}`);
		assert.ok(lines[0].includes("5min"), `长 goal 下时长仍在行 1 @${width}`);
		assert.equal(visibleWidth(lines[0]), width, `行 1 恰好占满 @${width}`);
	}
});

test("widget:goal 预算不足就整条不显示 —— 认不出的残句还白占列", () => {
	const s = runningState();
	const narrow = renderWidgetCard(mockTheme, { ...plan, goal: LONG_GOAL }, s, Date.now(), 48);
	assert.ok(!narrow[0].includes("把登录"), `48 列放不下 goal:${narrow[0]}`);
	assert.ok(narrow[0].includes("standard"), "身份位仍在");
});

test("widget:任务标题按宽度折行(截断 bug 回归),attempt 1/N 收起", () => {
	const s = runningState();
	s.tasks.T2 = { ...s.tasks.T2, status: "running", attempts: 1, sameSignatureCount: 0 };
	const longTitle = "FirstScreen 双屏轨道:ScreenLayout 与 HomeLinkList 的分组拖拽坐标体系迁移";
	const p: MissionPlan = {
		...plan,
		milestones: [{ id: "M1", title: "m", tasks: [{ id: "T2", title: longTitle, verify: [] }] }],
	};
	const lines = renderWidgetCard(mockTheme, p, s, Date.now(), 80);
	const joined = lines.join("");
	for (const ch of longTitle) assert.ok(joined.includes(ch), `标题全文可见,不截断:${ch}`);
	assert.ok(!lines.some((l) => l.includes("attempt 1/3")), "attempt 1/N 收起,训练不出选择性失明");
	// 续行必须悬挂到标题列:"  " + "· T2 " = 7 列。差一列不报错,只会看着像另起一段。
	// 前缀用中点而不是 ▸ —— 后者是可选中行的光标,而常驻卡收不了按键(见 render.test.ts)
	assert.ok(lines[1].startsWith("  · T2 "), `前缀不带分隔点:${lines[1]}`);
	const titleCol = lines[1].indexOf("FirstScreen");
	assert.equal(titleCol, 7, "标题起于第 7 列");
	assert.equal(
		lines[2].length - lines[2].trimStart().length,
		titleCol,
		`续行悬挂量必须等于标题列:${JSON.stringify(lines[2])}`,
	);
});

test("widget:任何相位 × 宽度 × 换脑原因都不许有行越界(越界会炸 TUI)", () => {
	// L0 实际会写进 pendingHandoff 的全部取值,逐条抄自 machine.ts
	const handoffs = [
		null,
		"advance to T3",
		"plan rejected ×2",
		"escalate L3",
		"escalate L2 on T2",
		"promote standard→complex on T12",
		"spike T2 未产出结论",
		"context-watermark 82%",
		"人工主动换脑",
	];
	for (const width of [40, 48, 56, 72, 80, 100, 120, 200]) {
		for (const phase of ["define", "plan", "do", "check", "act"] as const) {
			for (const handoff of handoffs) {
				const s = runningState();
				s.phase = phase;
				s.pendingHandoff = handoff;
				if (phase === "define") {
					s.currentTask = null;
					s.taskOrder = [];
					s.tasks = {};
				}
				const lines = renderWidgetCard(mockTheme, { ...plan, goal: LONG_GOAL }, s, Date.now(), width);
				for (const [i, l] of lines.entries()) {
					assert.ok(
						visibleWidth(l) <= width,
						`越界 w=${width} ${phase} handoff=${handoff} 行${i} 宽=${visibleWidth(l)}:${l}`,
					);
				}
			}
		}
	}
});

test("widget:单任务(quick)不显示进度条,零成本/零时长不显示", () => {
	const s = initialState({ missionId: "quick-x", tier: "quick", taskOrder: ["T1"] });
	s.phase = "do";
	s.currentTask = "T1";
	s.tasks.T1 = { ...s.tasks.T1, status: "running", attempts: 1 };
	const p: MissionPlan = {
		missionId: "quick-x",
		tier: "quick",
		goal: "x",
		acceptanceCriteria: [],
		milestones: [{ id: "M1", title: "m", tasks: [{ id: "T1", title: "本周天气如何呢", verify: [] }] }],
		verifyScript: "",
		createdAt: Date.now(),
	};
	const lines = renderWidgetCard(mockTheme, p, s, Date.now(), 120);
	assert.ok(!lines.some((l) => l.includes("░")), "单任务不显示进度条");
	assert.ok(!lines.some((l) => l.includes("$0")), "零成本不显示");
	assert.ok(!lines.some((l) => l.includes("0min")), "零时长不显示");
	assert.ok(lines[1].includes("本周天气如何呢"));
	assert.ok(!lines.some((l) => l.includes("attempt")), "attempt 1/N 收起");
});

test("widget:右对齐时长/成本;换脑挂起警告色", () => {
	usedColors.length = 0;
	const s = runningState();
	s.pendingHandoff = "escalate L2 on T2";
	const lines = renderWidgetCard(mockTheme, plan, s, plan.createdAt + 5 * 60_000, 120);
	// 行 1 有填充使成本靠右:总可见宽度 = 120
	assert.equal(visibleWidth(lines[0]), 120);
	assert.ok(lines[0].trimEnd().endsWith("$0.96")); // 成本在最右
	assert.ok(lines.some((l) => l.includes("/mission next")));
	assert.ok(usedColors.includes("warning")); // 换脑提示是警告色
});

test("widget:网关不报价(美元=0)时显 token 用量,不显 $0", () => {
	const s = runningState();
	s.cost = {}; // 没报价
	s.tokens = { executor: { input: 30_100, output: 8_000, cacheRead: 641_600, cacheWrite: 0 }, verifier: { input: 12_000, output: 2_300, cacheRead: 55_000, cacheWrite: 0 } };
	const lines = renderWidgetCard(mockTheme, plan, s, Date.now(), 120);
	assert.ok(lines[0].includes("749.0k tok"), `token 合计右对齐在行 1:${lines[0]}`);
	assert.ok(!lines.some((l) => l.includes("$0")), "美元为零不显示 $");
});

test("CHECK:widget 与概览显示实时阶段、耗时和当前分支", () => {
	const s = runningState();
	s.phase = "check";
	const check = {
		taskId: "T2",
		attempt: 2,
		startedAt: 10_000,
		updatedAt: 12_000,
		stage: "running_scripts" as const,
		currentBranch: "auth-integration",
		completedBranches: [
			{ acId: "lint", status: "pass" as const, exitCode: 0, durationMs: 800 },
		],
		verifier: { status: "pending" as const },
	};
	const widget = renderWidgetCard(mockTheme, plan, s, 15_000, 120, check).join("\n");
	assert.ok(widget.includes("执行脚本"));
	assert.ok(widget.includes("5s"));
	assert.ok(widget.includes("脚本 1 项"));
	assert.ok(!widget.includes("已完成 1"));
	assert.ok(widget.includes("auth-integration"));
	const overview = overviewLines(plan, s, {
		now: 15_000,
		theme: mockTheme,
		width: 80,
		checkState: check,
	}).join("\n");
	assert.ok(overview.includes("验证阶段"));
	assert.ok(overview.includes("已完成"));
	assert.ok(overview.includes("lint"));
});

test("dashboard:任务清单 + AC 证据状态 + 成本分账 + 日志", () => {
	const out = renderStatusDashboard(
		plan,
		runningState(),
		{ latest: { "auth-integration": { result: "fail", level: "hard", at: 1 } } },
		["10:22 T2 a=1 verdict=FAIL ev=refreshToken断言"],
		"missions",
	);
	assert.ok(out.includes("迁移登录鉴权到 JWT"));
	assert.ok(out.includes("✓ T1"));
	// 状态页的任务行用的是**状态图标**(STATUS_ICON 里 running = ▸),
	// 和常驻卡那个"可选中光标"是两回事 —— 状态页的任务行确实可以上下选中。
	assert.ok(out.includes("▸ T2"));
	assert.ok(out.includes("上次失败: AuthIntegrationTest#refreshToken"));
	assert.ok(out.includes("✗ AC1"), "AC1 有失败证据应标 ✗");
	assert.ok(out.includes("AC2") && out.includes("尚无证据"), "无证据的 AC 必须明示");
	assert.ok(out.includes("executor $0.870"));
	assert.ok(out.includes("verdict=FAIL"));
});

test("taskBlocks 与 taskLines 输出一致且结构化切分准确", () => {
	const s = runningState();
	const blocks = taskBlocks(plan, s, mockTheme, 80);
	assert.equal(blocks.length, 2);
	assert.equal(blocks[0].taskId, "T1");
	assert.equal(blocks[1].taskId, "T2");

	// 展平 blocks 必须与 taskLines 完全一致
	const flat = blocks.flatMap((b) => b.lines);
	const direct = taskLines(plan, s, mockTheme, 80);
	assert.deepEqual(flat, direct);
});

test("taskBlocks: complex 多里程碑下标题正确归入首个任务块", () => {
	const complexPlan: MissionPlan = {
		missionId: "complex-m",
		tier: "complex",
		goal: "重构",
		acceptanceCriteria: [{ id: "AC1", text: "t", verify: "b1" }],
		milestones: [
			{ id: "M1", title: "第一阶段", tasks: [{ id: "T1", title: "t1", verify: ["b1"] }, { id: "T2", title: "t2", verify: ["b1"] }] },
			{ id: "M2", title: "第二阶段", tasks: [{ id: "T3", title: "t3", verify: ["b1"] }] },
		],
		verifyScript: "",
		createdAt: Date.now(),
	};
	const s = initialState({ missionId: "complex-m", tier: "complex", taskOrder: ["T1", "T2", "T3"] });
	const blocks = taskBlocks(complexPlan, s, mockTheme, 80);
	assert.equal(blocks.length, 3);
	// M1 标题在 T1
	assert.ok(blocks[0].lines.some((l) => l.includes("M1 第一阶段")));
	assert.ok(!blocks[1].lines.some((l) => l.includes("M1 第一阶段")));
	// M2 标题在 T3
	assert.ok(blocks[2].lines.some((l) => l.includes("M2 第二阶段")));

	const flat = blocks.flatMap((b) => b.lines);
	const direct = taskLines(complexPlan, s, mockTheme, 80);
	assert.deepEqual(flat, direct);
});

test("相位图标只用好渲染的那几个字形(◌ ◍ ◑ 会被渲染成大圆盘)", () => {
	const bad = ["◌", "◍", "◑", "◐", "◒", "◓", "⬤"];
	for (const [phase, st] of Object.entries(PHASE_STYLE)) {
		assert.ok(!bad.includes(st.icon), `${phase} 用了会糊掉的字形 ${st.icon}`);
		assert.equal(visibleWidth(st.icon), 1, `${phase} 的图标必须是 1 列宽`);
	}
});

test("概览:目标折行不截断;不显示会话文件名这类机器字符串", () => {
	const longGoal =
		"新增 Antix (antigma.ai) AI 额度 widget:像 DeepSeek 一样显示账户余额,支持在 NewTab 里添加,并复用现有 QuotaWidget 的外观与刷新策略";
	const p2: MissionPlan = { ...plan, goal: longGoal };
	const s = runningState();
	s.sessionMap = { T1: "/x/2026-09-01T03-47-31-939Z_01a05b14-4be3-7f5d.jsonl" };
	const width = 48;
	const lines = overviewLines(p2, s, { width, omitIdentity: true });
	for (const l of lines) assert.ok(visibleWidth(l) <= width, `概览行超宽: ${l}`);
	// 目标必须完整出现(拼掉悬挂缩进后)
	const joined = lines.map((l) => l.trim()).join("");
	assert.ok(joined.includes("刷新策略"), "目标的结尾被截掉了");
	assert.ok(!lines.some((l) => l.includes(".jsonl")), "会话文件名不该占概览的行");
	// omitIdentity:盒标题/头行已经给过的东西不再重复
	assert.ok(!lines.some((l) => l.includes("mission ")), "身份行应由调用方决定是否显示");
});

test("概览:非 TUI 扁平卡片仍要带上身份与进度(没有盒标题兜底)", () => {
	const lines = overviewLines(plan, runningState(), {});
	assert.ok(lines.some((l) => l.includes("auth-refactor")), "扁平形态必须自带 mission id");
	assert.ok(lines.some((l) => l.includes("任务")), "扁平形态必须自带进度");
});

test("widget:无结论预警的括号内容跟着成因走 —— 核验模型 400 时别把人指去查环境", () => {
	const warnOf = (cause?: string) => {
		const s = runningState();
		s.tasks.T2 = { ...s.tasks.T2, inconclusiveStreak: 2, lastInconclusiveCause: cause as never };
		return renderWidgetCard(mockTheme, plan, s, Date.now(), 120).join("\n");
	};
	assert.match(warnOf("judge"), /核验裁判不可用/);
	assert.match(warnOf("evidence"), /证据没采到/);
	// 第一次无结论之前这个字段没有值 —— 那一格不能渲染成 (undefined)
	const line = warnOf(undefined);
	assert.match(line, /证据没采到/);
	assert.doesNotMatch(line, /undefined/);
});

test("widget:窄终端下卡片高度有上限 —— 常驻 chrome 不许无限长", () => {
	const s = runningState();
	const longTitle = "FirstScreen 双屏轨道:ScreenLayout 与 HomeLinkList 的分组拖拽坐标体系迁移";
	const p: MissionPlan = {
		...plan,
		goal: LONG_GOAL,
		milestones: [{ id: "M1", title: "m", tasks: [{ id: "T2", title: longTitle, verify: [] }] }],
	};
	s.pendingHandoff = "promote standard→complex on T12";
	for (const width of [40, 48, 56, 72, 80, 120]) {
		const lines = renderWidgetCard(mockTheme, p, s, Date.now(), width);
		assert.ok(lines.length <= 5, `w=${width} 涨到了 ${lines.length} 行:\n${lines.join("\n")}`);
	}
});

test("widget:等人终审时说'等待你终审',不许说成'独立核验'", () => {
	// 真实事故:collectHumanVerdict 落的是 stage=running_verifier(标签「独立核验」),
	// 于是人在等着点确认,卡片却显示「独立核验 17m7s」—— 人不知道该去点什么。
	const s = runningState();
	s.phase = "check";
	const check = {
		taskId: "T2",
		attempt: 1,
		startedAt: 10_000,
		updatedAt: 12_000,
		stage: "awaiting_human" as const,
		completedBranches: [],
		verifier: { status: "skipped" as const, message: "人工终审(不可重放)" },
	};
	const widget = renderWidgetCard(mockTheme, plan, s, 25_000, 120, check).join("\n");
	assert.ok(widget.includes("等待你终审"), `实际:${widget}`);
	assert.ok(!widget.includes("独立核验"), "等人的时候不许说模型在跑");
	assert.ok(widget.includes("15s"), "计时要走 —— 人得知道自己晾了多久");
});

// ─────────────────────────── 侦查扇出的常驻行 ───────────────────────────

const SCOUT_LIVE = {
	startedAt: 0,
	progress: {
		done: 1,
		total: 4,
		activity: { S1: "已交回结论", S2: "读 src/repo/user.ts", S3: "搜 privateApi", S4: "排队中" },
		running: ["S2", "S3", "S4"],
	},
};

function planningState(): ReturnType<typeof initialState> {
	const s = initialState({ missionId: "auth-refactor", tier: "standard", taskOrder: ["T1", "T2"] });
	s.phase = "plan";
	s.currentTask = null;
	return s;
}

test("widget:扇出时要能看出跑到哪了,而且只占一行", () => {
	// 每路一行的话 4 路就是 4 行常驻,而这张卡的高度是永久成本;
	// 逐路明细在工具调用块里(ui/scout-view.ts),那儿的高度是临时的
	const now = 75_000;
	const lines = renderWidgetCard(mockTheme, plan, planningState(), now, 120, null, SCOUT_LIVE);
	const scoutLines = lines.filter((l) => l.includes("侦查扇出"));
	assert.equal(scoutLines.length, 1, "只许一行");
	assert.ok(scoutLines[0].includes("1/4"), "要报进度");
	assert.ok(scoutLines[0].includes("S2"), "要点名一路还在跑的 —— 只报 x/y 的话卡住了看不出卡在哪");
	assert.ok(scoutLines[0].includes("读 src/repo/user.ts"), "以及它在干什么");
});

test("widget:没在扇出就不占那一行", () => {
	const lines = renderWidgetCard(mockTheme, plan, planningState(), Date.now(), 120, null, null);
	assert.ok(!lines.some((l) => l.includes("侦查扇出")));
});

test("widget:扇出行在任何宽度下都不越界", () => {
	for (const width of [40, 56, 72, 100, 120]) {
		for (const line of renderWidgetCard(mockTheme, plan, planningState(), 75_000, width, null, SCOUT_LIVE)) {
			assert.ok(visibleWidth(line) <= width, `w=${width} 越界:${JSON.stringify(line)}`);
		}
	}
});

test("widget:全部回来之后不再点名,只剩 4/4", () => {
	const all = {
		startedAt: 0,
		progress: { done: 4, total: 4, activity: { S1: "已交回结论" }, running: [] },
	};
	const line = renderWidgetCard(mockTheme, plan, planningState(), 75_000, 120, null, all).find((l) =>
		l.includes("侦查扇出"),
	)!;
	assert.ok(line.includes("4/4"));
	assert.ok(!line.includes("S1"), "没有还在跑的就别点名");
});

// 用户在真机上的原话:「我现在完全看不到独立核验的进展」。
// 当时 widget 上是一行 `独立核验 running · 1m34s`,两分多钟一动不动,
// 而同一时刻 CHECK.json 里 activity 是「读取 …/keymap.go」、turns 11、toolCalls 22。
// 数据一直都在,只是一个字段都没渲染。
test("check 进度:核验跑着的时候要看得出它在干什么", () => {
	const now = Date.now();
	const lines = checkProgressLines(
		{
			taskId: "T1",
			attempt: 1,
			startedAt: now - 94_000,
			updatedAt: now,
			stage: "running_verifier",
			completedBranches: [],
			verifier: {
				status: "running",
				startedAt: now - 88_000,
				turns: 11,
				toolCalls: 22,
				activity: "读取 /Users/kim/Projects/todo-list/internal/keymap/keymap.go",
			},
		},
		now,
		mockTheme,
		56,
	).join("\n");
	assert.match(lines, /核验中/, "状态要说人话,不是 running");
	assert.doesNotMatch(lines, /running/, "英文枚举不该漏到界面上");
	assert.match(lines, /11 轮/);
	assert.match(lines, /22 次调用/, "调用数是「它真的在干活」的唯一证据");
	assert.match(lines, /keymap\.go/, "当前动作要看得见");
	assert.match(lines, /1m2[0-9]s/, "跑着的时候 durationMs 还没有值,得用 startedAt 现算");
});

// 0 次调用的 degraded 和 22 次调用的 running 在旧版里都只显示状态词,
// 而前者意味着独立核验根本没发生(I3 当轮是空的)。这两种必须一眼可分。
test("check 进度:降级且零调用要和真干活的区分得开", () => {
	const now = Date.now();
	const lines = checkProgressLines(
		{
			taskId: "T1",
			attempt: 1,
			startedAt: now - 3000,
			updatedAt: now,
			stage: "judging",
			completedBranches: [],
			verifier: { status: "degraded", durationMs: 1228, turns: 1, toolCalls: 0 },
		},
		now,
		mockTheme,
		56,
	).join("\n");
	assert.match(lines, /已降级/);
	assert.doesNotMatch(lines, /次调用/, "0 次调用不该印出来,空着本身就是信号");
});

test("check 进度:核验结束后不再印当前动作 —— 那会读成它还在跑", () => {
	const now = Date.now();
	const lines = checkProgressLines(
		{
			taskId: "T1",
			attempt: 1,
			startedAt: now - 3000,
			updatedAt: now,
			stage: "completed",
			completedBranches: [],
			verifier: { status: "completed", durationMs: 5000, turns: 6, toolCalls: 8, activity: "读取 /a/b/c.go" },
		},
		now,
		mockTheme,
		56,
	).join("\n");
	assert.match(lines, /已完成/);
	assert.doesNotMatch(lines, /c\.go/);
});

test("shortenActivity:绝对路径压成尾部两段 —— 前缀对读的人是零信息", () => {
	assert.equal(
		shortenActivity("读取 /Users/kim/Projects/todo-list/internal/keymap/keymap.go"),
		"读取 …/keymap/keymap.go",
	);
	assert.equal(shortenActivity("搜索 TestFoo|TestBar"), "搜索 TestFoo|TestBar", "没有路径就别动它");
	assert.equal(shortenActivity("浏览 /tmp"), "浏览 /tmp", "本来就短的不加省略号");
});

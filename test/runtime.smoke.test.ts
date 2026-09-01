/**
 * pi-missions · runtime 冒烟测试(headless)
 *
 * 用 mock pi/ctx 驱动真实 Runtime + 真实 core,在临时仓库里走完整循环:
 *   new → writePlan → (fail → act → adjust) → submit → check → pass → done
 * 验证 runtime 粘合层没有判定逻辑错误。core 的纯函数单测在 core/__tests__/。
 *
 * 运行:node --test test/*.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Runtime, renderStateCard } from "../src/runtime.ts";
import { parseMissionMd } from "../src/store/mission.ts";
import { toolsForPhase } from "../src/hooks/gate.ts";

function execReal(cmd: string, args: string[], opts?: { cwd?: string; timeout?: number }) {
	return new Promise<{ code: number; stdout: string; stderr: string; killed: boolean }>((resolve) => {
		execFile(cmd, args, { cwd: opts?.cwd, timeout: opts?.timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
			resolve({
				code: err && typeof (err as any).code === "number" ? ((err as any).code as number) : err ? 1 : 0,
				stdout: String(stdout),
				stderr: String(stderr),
				killed: false,
			});
		});
	});
}

function mockPi() {
	const calls = { activeTools: [] as string[][], followUps: [] as string[], entries: [] as any[], thinking: [] as string[] };
	return {
		calls,
		exec: execReal,
		setActiveTools: (t: string[]) => void calls.activeTools.push(t),
		setThinkingLevel: (l: string) => void calls.thinking.push(l),
		setModel: async () => true,
		getThinkingLevel: () => "medium",
		sendUserMessage: (m: string) => void calls.followUps.push(m),
		sendMessage: () => {},
		appendEntry: (type: string, data: any) => void calls.entries.push({ type, data }),
	};
}

function mockCtx(cwd: string) {
	const notifications: string[] = [];
	return {
		notifications,
		cwd,
		hasUI: false,
		mode: "tui",
		ui: {
			notify: (m: string) => void notifications.push(m),
			setWidget: () => {},
			confirm: async () => true,
		},
		getContextUsage: () => ({ tokens: 0, contextWindow: 100_000, percent: 0 }),
		sessionManager: { getSessionFile: () => "/tmp/fake-session.jsonl" },
		modelRegistry: { find: () => undefined },
	};
}

const VERIFY_SH = `#!/usr/bin/env bash
case "$1" in
  hello-exists) test -f hello.txt && grep -q hello hello.txt ;;
  *) echo "unknown branch: $1" >&2; exit 2 ;;
esac
`;

async function newMission(tmp: string) {
	const pi = mockPi();
	const ctx = mockCtx(tmp);
	const rt = new Runtime(pi, tmp);
	const start = await rt.startNew(ctx, "create hello.txt", "standard");
	assert.ok("id" in start, JSON.stringify(start));
	assert.equal(rt.active!.state.phase, "frame", "standard 起于 FRAME");
	const fr = await rt.frame(ctx, { goal: "create hello.txt", constraints: [], nonGoals: [] });
	assert.ok("ok" in fr, JSON.stringify(fr));
	const wp = await rt.writePlan(ctx, {
		goal: "create hello.txt",
		acceptanceCriteria: [{ id: "AC1", text: "hello.txt 存在且含 hello", verify: "hello-exists" }],
		milestones: [{ id: "M1", title: "only", tasks: [{ id: "T1", title: "create hello.txt", verify: ["hello-exists"] }] }],
		verifyScript: VERIFY_SH,
	});
	assert.ok("ok" in wp, JSON.stringify(wp));
	assert.equal(rt.active!.state.phase, "do");
	assert.equal(rt.active!.state.currentTask, "T1");
	return { pi, ctx, rt };
}

test("完整闭环:fail → act → adjust → pass → done", async () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-missions-smoke-"));
	const { pi, ctx, rt } = await newMission(tmp);

	// 计划与脚手架已落盘
	assert.ok(fs.existsSync(path.join(tmp, "missions", "plans", rt.active!.state.missionId, "MISSION.md")));
	assert.ok(fs.existsSync(path.join(tmp, "missions", "scripts", "verify.sh")));
	assert.ok(fs.existsSync(path.join(tmp, "missions", "phases", "do.md")));

	// 第一轮:hello.txt 不存在 → hard fail → act
	let r = await rt.applyEvent({ type: "SUBMIT", at: Date.now() }, ctx);
	assert.ok(!r.error);
	await rt.runCheck(ctx);
	assert.equal(rt.active!.state.phase, "act");
	assert.equal(rt.active!.state.tasks.T1.sameSignatureCount, 1);
	assert.ok(pi.calls.entries.some((e) => e.type === "missions-verdict" && e.data.verdict.outcome === "fail"));
	// act 的 followUp 已发出
	assert.ok(pi.calls.followUps.some((m) => m.includes("ACT")));

	// ACT 一轮诊断结束 → ADJUST_DONE → do,attempts=2
	r = await rt.applyEvent({ type: "ADJUST_DONE", at: Date.now() }, ctx);
	assert.ok(!r.error);
	assert.equal(rt.active!.state.phase, "do");
	assert.equal(rt.active!.state.tasks.T1.attempts, 2);

	// 执行者修好(模拟)
	fs.writeFileSync(path.join(tmp, "hello.txt"), "hello\n");

	// 第二轮:pass → 单任务完成 → done + RESTORE
	r = await rt.applyEvent({ type: "SUBMIT", at: Date.now() }, ctx);
	await rt.runCheck(ctx);
	assert.equal(rt.active!.state.phase, "done");

	// 状态与日志落盘
	const stateFile = path.join(tmp, "missions", "state", rt.active!.state.missionId, "STATE.json");
	const saved = JSON.parse(fs.readFileSync(stateFile, "utf8"));
	assert.equal(saved.phase, "done");
	assert.equal(saved.tasks.T1.status, "done");
	const log = fs.readFileSync(path.join(tmp, "missions", "state", rt.active!.state.missionId, "LOG.md"), "utf8");
	assert.ok(log.includes("verdict=FAIL"));
	assert.ok(log.includes("verdict=PASS"));
	// 证据归档
	assert.ok(fs.readdirSync(path.join(tmp, "missions", "state", rt.active!.state.missionId, "evidence")).length >= 2);
});

test("计划不合法时被 writePlan 拒绝", async () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-missions-smoke-"));
	const pi = mockPi();
	const ctx = mockCtx(tmp);
	const rt = new Runtime(pi, tmp);
	await rt.startNew(ctx, "x", "standard");
	await rt.frame(ctx, { goal: "x", constraints: [], nonGoals: [] });
	const r = await rt.writePlan(ctx, {
		goal: "x",
		acceptanceCriteria: [{ id: "AC1", text: "y", verify: "missing-branch" }],
		milestones: [{ id: "M1", title: "m", tasks: [{ id: "T1", title: "t", verify: ["missing-branch"] }] }],
		verifyScript: "#!/usr/bin/env bash\nexit 0\n",
	});
	assert.ok("error" in r);
	assert.match((r as any).error, /missing-branch/);
	assert.equal(rt.active!.state.phase, "plan");
});

test("闸门:do 相位写冻结件被拦,pendingHandoff 硬阻断", async () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-missions-smoke-"));
	const { ctx, rt } = await newMission(tmp);

	// do 相位写 MISSION.md → 拦
	assert.ok(rt.gate("write", { path: `missions/plans/${rt.active!.state.missionId}/MISSION.md` }));
	// do 相位写 state → 拦
	assert.ok(rt.gate("edit", { path: `missions/state/${rt.active!.state.missionId}/STATE.json` }));
	// 普通文件 → 放行
	assert.equal(rt.gate("write", { path: "src/main.ts" }), null);

	// 换脑挂起 → 写工具全拦,只读放行
	await rt.applyEvent({ type: "HANDOFF_REQUEST", at: Date.now(), reason: "test" }, ctx);
	assert.ok(rt.gate("write", { path: "src/main.ts" }));
	assert.ok(rt.gate("bash", { command: "npm test" }));
	assert.equal(rt.gate("read", { path: "src/main.ts" }), null);

	await rt.applyEvent({ type: "HANDOFF_DONE", at: Date.now(), sessionFile: "/tmp/s.jsonl" }, ctx);
	assert.equal(rt.gate("write", { path: "src/main.ts" }), null);
});

test("跨实例换脑接力:新 Runtime 从磁盘握手完成 HANDOFF_DONE", async () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-missions-smoke-"));
	const { ctx, rt } = await newMission(tmp);

	// 进入 pendingHandoff(complex 推进/水位/升级的等价物)
	const r = await rt.applyEvent({ type: "HANDOFF_REQUEST", at: Date.now(), reason: "advance to T2" }, ctx);
	assert.ok(!r.error);
	assert.equal(rt.active!.state.pendingHandoff, "advance to T2");

	// 模拟 pi 在 newSession 后重建扩展实例:全新 Runtime,同一仓库
	const pi2 = mockPi();
	const ctx2 = mockCtx(tmp);
	const rt2 = new Runtime(pi2, tmp);
	assert.equal(rt2.active, null, "新实例内存为空");

	await rt2.onSessionStart(ctx2);

	// 从磁盘接上 + 换脑握手完成 + 闸门重新生效
	assert.ok(rt2.active, "必须从磁盘重附着");
	assert.equal(rt2.active!.state.pendingHandoff, null, "HANDOFF_DONE 已落账");
	assert.equal(rt2.active!.state.phase, "do");
	assert.equal(rt2.active!.state.sessionMap.T1, "/tmp/fake-session.jsonl");
	assert.ok(
		rt2.gate("write", { path: `missions/plans/${rt2.active!.state.missionId}/MISSION.md` }),
		"闸门在接力后必须重新生效",
	);
	assert.equal(rt2.gate("write", { path: "src/main.ts" }), null, "换脑完成后写工具解冻");
	// 用户现场 profile 落盘,跨实例可还原
	assert.ok(
		fs.existsSync(path.join(tmp, "missions", "state", rt2.active!.state.missionId, "profile.json")),
	);
});

test("ensureAttached:内存丢失时驱动命令从磁盘悄悄接上", async () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-missions-smoke-"));
	const { rt } = await newMission(tmp);
	const id = rt.active!.state.missionId;

	// 同仓库新实例:接上
	const rt2 = new Runtime(mockPi(), tmp);
	assert.equal(await rt2.ensureAttached(mockCtx(tmp)), true);
	assert.equal(rt2.active!.state.missionId, id);
	assert.equal(rt2.active!.state.phase, "do");

	// 无 mission 的仓库:接不上,返回 false(命令随后报"无活动 mission")
	const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-missions-empty-"));
	const rt3 = new Runtime(mockPi(), emptyDir);
	assert.equal(await rt3.ensureAttached(mockCtx(emptyDir)), false);
});

test("quick 档:内存态不落盘,--verify 命令驱动判定", async () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-missions-smoke-"));
	const pi = mockPi();
	const ctx = mockCtx(tmp);
	const rt = new Runtime(pi, tmp);
	const r = await rt.startQuick(ctx, "create hello.txt", "test -f hello.txt");
	assert.ok("id" in r, JSON.stringify(r));
	assert.equal(rt.active!.state.phase, "do");
	assert.ok(rt.active!.inMemory);
	// quick 不产生任何磁盘状态
	assert.ok(!fs.existsSync(path.join(tmp, "missions")));

	fs.writeFileSync(path.join(tmp, "hello.txt"), "hello\n");
	const s = await rt.applyEvent({ type: "SUBMIT", at: Date.now() }, ctx);
	assert.ok(!s.error);
	await rt.runCheck(ctx);
	assert.equal(rt.active!.state.phase, "done");
	assert.ok(!fs.existsSync(path.join(tmp, "missions")), "quick 全程零落盘");
});

test("quick 带 --verify:命令进 DO 前冻结,走完判定闭环", async () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-missions-smoke-"));
	const pi = mockPi();
	const ctx = mockCtx(tmp);
	const rt = new Runtime(pi, tmp);

	const r = await rt.startQuick(ctx, "create hello.txt", "test -f hello.txt");
	assert.ok("id" in r, JSON.stringify(r));
	assert.equal(r.tier, "quick");
	assert.equal(rt.active!.state.tier, "quick");
	assert.equal(rt.active!.state.phase, "do");
	assert.equal(rt.active!.quickVerifyCommand, "test -f hello.txt");
	assert.equal(rt.active!.inMemory, true, "quick 不落盘");

	// 命令不满足 → fail;满足 → pass → done
	await rt.applyEvent({ type: "SUBMIT", at: Date.now() }, ctx);
	await rt.runCheck(ctx);
	assert.equal(rt.active!.state.phase, "act");

	await rt.applyEvent({ type: "ADJUST_DONE", at: Date.now() }, ctx);
	fs.writeFileSync(path.join(tmp, "hello.txt"), "hello\n");
	await rt.applyEvent({ type: "SUBMIT", at: Date.now() }, ctx);
	await rt.runCheck(ctx);
	assert.equal(rt.active!.state.phase, "done");
});

test("quick 无 --verify:不进 DO,自动升 standard 停在 FRAME", async () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-missions-smoke-"));
	const pi = mockPi();
	const ctx = mockCtx(tmp);
	const rt = new Runtime(pi, tmp);

	const r = await rt.startQuick(ctx, "让登录快一点");
	assert.ok("id" in r, JSON.stringify(r));
	assert.equal(r.tier, "standard", "没有判定依据就不该有快车道");
	assert.equal(rt.active!.state.tier, "standard");
	assert.equal(rt.active!.state.phase, "frame", "模糊输入先去定义问题,再谈 AC");
	assert.equal(rt.active!.quickVerifyCommand, undefined);
	assert.equal(rt.active!.inMemory, false, "升档后走正常落盘路径");
	assert.ok(ctx.notifications.some((m) => m.includes("--verify")), "要告诉人为什么升档了");

	// FRAME 相位:只读 + 问一轮 + 交定义,连 mission_write_plan 都还没给
	const tools = pi.calls.activeTools.at(-1)!;
	assert.ok(tools.includes("mission_ask") && tools.includes("mission_frame"));
	assert.ok(!tools.includes("mission_write_plan"), "问题没定义清楚不给写计划");
	assert.ok(!tools.includes("write"));
});

test("PLAN 相位的 State Card 不能把'尚未冻结'说成 quick 档口径", async () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-missions-smoke-"));
	const pi = mockPi();
	const ctx = mockCtx(tmp);
	const rt = new Runtime(pi, tmp);
	await rt.startNew(ctx, "x", "standard");

	const card = renderStateCard(rt.active!.plan, rt.active!.state, "missions");
	assert.ok(!card.includes("quick 档"), "standard mission 的卡片不该出现 quick 档口径");
	assert.ok(card.includes("尚未冻结"));
});

test("空壳 AC(冻结时就绿)被基线打回,计划不冻结", async () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-missions-smoke-"));
	const pi = mockPi();
	const ctx = mockCtx(tmp);
	const rt = new Runtime(pi, tmp);
	await rt.startNew(ctx, "x", "standard");
	await rt.frame(ctx, { goal: "x", constraints: [], nonGoals: [] });

	const r = await rt.writePlan(ctx, {
		goal: "x",
		acceptanceCriteria: [{ id: "AC1", text: "看起来可执行,其实是空壳", verify: "always-ok" }],
		milestones: [{ id: "M1", title: "m", tasks: [{ id: "T1", title: "t", verify: ["always-ok"] }] }],
		verifyScript: '#!/usr/bin/env bash\ncase "$1" in\n  always-ok) exit 0 ;;\n  *) exit 2 ;;\nesac\n',
	});

	assert.ok("error" in r, "exit 0 的分支必须被拒");
	assert.match((r as any).error, /在动手之前就已经通过/);
	assert.equal(rt.active!.state.phase, "plan", "计划未冻结,仍在 PLAN");
	assert.ok(!fs.existsSync(path.join(tmp, "missions", "plans", rt.active!.state.missionId, "MISSION.md")), "被拒的计划不落 MISSION.md");
	const log = fs.readFileSync(path.join(tmp, "missions", "state", rt.active!.state.missionId, "LOG.md"), "utf8");
	assert.ok(log.includes("baseline REJECTED"));
});

test("回归项显式声明 baseline green 才放行,并与红项共存", async () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-missions-smoke-"));
	const pi = mockPi();
	const ctx = mockCtx(tmp);
	const rt = new Runtime(pi, tmp);
	await rt.startNew(ctx, "x", "standard");
	await rt.frame(ctx, { goal: "x", constraints: [], nonGoals: [] });

	const script = '#!/usr/bin/env bash\ncase "$1" in\n  hello-exists) test -f hello.txt ;;\n  no-regression) exit 0 ;;\n  *) exit 2 ;;\nesac\n';

	// 回归项不声明 green → 被当成 red,基线不符,拒
	const bad = await rt.writePlan(ctx, {
		goal: "x",
		acceptanceCriteria: [
			{ id: "AC1", text: "hello.txt 存在", verify: "hello-exists" },
			{ id: "AC2", text: "现有测试不许挂", verify: "no-regression" },
		],
		milestones: [{ id: "M1", title: "m", tasks: [{ id: "T1", title: "t", verify: ["hello-exists"] }] }],
		verifyScript: script,
	});
	assert.ok("error" in bad);
	assert.match((bad as any).error, /AC2/);

	// 显式声明 green → 放行
	const ok = await rt.writePlan(ctx, {
		goal: "x",
		acceptanceCriteria: [
			{ id: "AC1", text: "hello.txt 存在", verify: "hello-exists" },
			{ id: "AC2", text: "现有测试不许挂", verify: "no-regression", baseline: "green" },
		],
		milestones: [{ id: "M1", title: "m", tasks: [{ id: "T1", title: "t", verify: ["hello-exists"] }] }],
		verifyScript: script,
	});
	assert.ok("ok" in ok, JSON.stringify(ok));
	assert.equal(rt.active!.state.phase, "do");
	const md = fs.readFileSync(path.join(tmp, "missions", "plans", rt.active!.state.missionId, "MISSION.md"), "utf8");
	assert.ok(md.includes("baseline: green"), "MISSION.md 要写明基线声明");
	assert.ok(md.includes("baseline: red"));
});

test("L2 重规划不被基线锁死:已经做完的部分变绿也能重新冻结", async () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-missions-smoke-"));
	const { ctx, rt } = await newMission(tmp);

	// 执行者已经把 AC1 做绿了(T1 完成),但 mission 因为别的原因走到 L2
	fs.writeFileSync(path.join(tmp, "hello.txt"), "hello\n");
	await rt.applyEvent({ type: "ESCALATE", at: Date.now(), to: 2, reason: "方案错了" }, ctx);
	assert.equal(rt.active!.state.phase, "plan");
	await rt.applyEvent({ type: "HANDOFF_DONE", at: Date.now() }, ctx);

	// 同一份 AC(L2 不许改 AC)此刻已经是绿的 —— 若仍跑基线,planner 将无路可走
	const r = await rt.writePlan(ctx, {
		goal: "create hello.txt",
		acceptanceCriteria: [{ id: "AC1", text: "hello.txt 存在且含 hello", verify: "hello-exists" }],
		milestones: [{ id: "M1", title: "only", tasks: [{ id: "T1", title: "create hello.txt", verify: ["hello-exists"] }] }],
		verifyScript: VERIFY_SH,
	});

	assert.ok("ok" in r, JSON.stringify(r));
	assert.equal(rt.active!.state.phase, "do");
	const log = fs.readFileSync(path.join(tmp, "missions", "state", rt.active!.state.missionId, "LOG.md"), "utf8");
	assert.ok(log.includes("baseline skipped"));
});

test("被基线拒掉的计划不会污染 State Card(a.plan 不提前认账)", async () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-missions-smoke-"));
	const pi = mockPi();
	const ctx = mockCtx(tmp);
	const rt = new Runtime(pi, tmp);
	await rt.startNew(ctx, "x", "standard");
	await rt.frame(ctx, { goal: "x", constraints: [], nonGoals: [] });

	const r = await rt.writePlan(ctx, {
		goal: "x",
		acceptanceCriteria: [{ id: "AC1", text: "空壳", verify: "always-ok" }],
		milestones: [{ id: "M1", title: "m", tasks: [{ id: "T1", title: "t", verify: ["always-ok"] }] }],
		verifyScript: '#!/usr/bin/env bash\ncase "$1" in\n  always-ok) exit 0 ;;\n  *) exit 2 ;;\nesac\n',
	});
	assert.ok("error" in r);

	assert.equal(rt.active!.plan.acceptanceCriteria.length, 0, "被拒的 AC 不进 a.plan");
	const card = renderStateCard(rt.active!.plan, rt.active!.state, "missions");
	assert.ok(!card.includes("空壳"), "被拒的 AC 不该以冻结口径出现在卡片里");
	assert.ok(card.includes("尚未冻结"));
});

test("FRAME:提问预算由 L0 强制 —— 一轮、最多 3 个", async () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-missions-smoke-"));
	const pi = mockPi();
	const ctx = mockCtx(tmp);
	const rt = new Runtime(pi, tmp);
	await rt.startNew(ctx, "让登录快一点", "standard");
	assert.equal(rt.active!.state.phase, "frame");

	// 超过 3 个:拒,且不消耗预算
	const tooMany = await rt.ask(ctx, ["q1", "q2", "q3", "q4"]);
	assert.ok("error" in tooMany);
	assert.equal(rt.active!.state.frameAsks, 0, "被拒的提问不算一轮");

	// 首轮 3 个:放行,问题以卡片交给人
	const first = await rt.ask(ctx, ["『快』指首屏还是接口?", "目标多少 ms?", "允许改数据库 schema 吗?"]);
	assert.ok("ok" in first);
	assert.equal(rt.active!.state.frameAsks, 1);
	assert.ok(pi.calls.entries.some((e) => e.type === "missions-card" && String(e.data.body).includes("目标多少 ms?")));

	// 第二轮:拒 —— 连环追问在这里被截断
	const second = await rt.ask(ctx, ["再问一个"]);
	assert.ok("error" in second);
	assert.match((second as any).error, /只许问一轮/);

	// 交定义 → 进 PLAN,约束/边界进 State Card
	const fr = await rt.frame(ctx, {
		goal: "登录接口 p95 从 800ms 降到 300ms 以内",
		constraints: ["不改数据库 schema"],
		nonGoals: ["前端首屏优化"],
	});
	assert.ok("ok" in fr, JSON.stringify(fr));
	assert.equal(rt.active!.state.phase, "plan");
	assert.equal(rt.active!.plan.goal, "登录接口 p95 从 800ms 降到 300ms 以内");

	const card = renderStateCard(rt.active!.plan, rt.active!.state, "missions");
	assert.ok(card.includes("不改数据库 schema"));
	assert.ok(card.includes("前端首屏优化"));

	// PLAN 相位不能再提问,也不能重复定义
	assert.ok("error" in (await rt.ask(ctx, ["x"])));
	assert.ok("error" in (await rt.frame(ctx, { goal: "y", constraints: [], nonGoals: [] })));
});

test("FRAME 的产出进 MISSION.md fence,冻结后可解析回来", async () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-missions-smoke-"));
	const pi = mockPi();
	const ctx = mockCtx(tmp);
	const rt = new Runtime(pi, tmp);
	await rt.startNew(ctx, "create hello.txt", "standard");
	await rt.frame(ctx, { goal: "create hello.txt", constraints: ["只动仓库根目录"], nonGoals: ["不碰 CI"] });
	const wp = await rt.writePlan(ctx, {
		goal: "create hello.txt",
		acceptanceCriteria: [{ id: "AC1", text: "hello.txt 存在且含 hello", verify: "hello-exists" }],
		milestones: [{ id: "M1", title: "only", tasks: [{ id: "T1", title: "create hello.txt", verify: ["hello-exists"] }] }],
		verifyScript: VERIFY_SH,
	});
	assert.ok("ok" in wp, JSON.stringify(wp));

	const md = fs.readFileSync(path.join(tmp, "missions", "plans", rt.active!.state.missionId, "MISSION.md"), "utf8");
	assert.ok(md.includes("## Frame"));
	assert.ok(md.includes("只动仓库根目录"));
	const parsed = parseMissionMd(md);
	assert.deepEqual(parsed!.framing!.nonGoals, ["不碰 CI"]);
});

test("L3 落点是 FRAME:归档旧计划、重置提问预算、换脑简报按相位分流", async () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-missions-smoke-"));
	const { ctx, rt } = await newMission(tmp);
	ctx.hasUI = true; // L3 必须人工确认;非交互环境视为拒绝(→ halted),那是另一条路径

	await rt.applyEvent({ type: "ESCALATE", at: Date.now(), to: 3, reason: "AC 定义错了" }, ctx);
	// CONFIRM 效果 → mockCtx.confirm 恒 true → ESCALATION_CONFIRMED
	assert.equal(rt.active!.state.phase, "frame", "L3 回 FRAME 而不是 PLAN");
	assert.equal(rt.active!.state.frameAsks, 0, "新的问题定义可以再问一轮");
	assert.ok(rt.active!.state.pendingHandoff, "升级必须换脑(I5)");
	assert.ok(fs.readdirSync(path.join(tmp, "missions", "state", rt.active!.state.missionId, "archive")).length > 0);

	// 换脑完成后工具集回到 FRAME:没有 mission_write_plan,也没有写工具
	await rt.applyEvent({ type: "HANDOFF_DONE", at: Date.now() }, ctx);
	assert.equal(rt.gate("write", { path: "src/main.ts" }), null);
	const tools = toolsForPhase(rt.active!.state.phase);
	assert.ok(tools.includes("mission_frame") && !tools.includes("mission_write_plan"));

	// 重新定义 → 回到 PLAN,可以带新的 AC 重新冻结
	const fr = await rt.frame(ctx, { goal: "换个说法的目标", constraints: [], nonGoals: [] });
	assert.ok("ok" in fr, JSON.stringify(fr));
	assert.equal(rt.active!.state.phase, "plan");
});

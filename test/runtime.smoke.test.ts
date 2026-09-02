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
import { Runtime, renderStateCard, renderDoBrief } from "../src/runtime.ts";
import { parseMissionMd } from "../src/store/mission.ts";
import { toolsForPhase } from "../src/hooks/gate.ts";
import type { MissionSnapshotV2 } from "../src/store/repository.ts";

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

function mockCtx(cwd: string, human?: { select?: string; input?: string; custom?: (questions: any[]) => any }) {
	const notifications: string[] = [];
	const prompts: string[] = [];
	return {
		notifications,
		/** 人工终审弹出的问题;用来断言"确实问了人",而不是悄悄放行 */
		prompts,
		cwd,
		hasUI: !!human,
		mode: "tui",
		ui: {
			notify: (m: string) => void notifications.push(m),
			setWidget: () => {},
			confirm: async () => true,
			select: async (title: string, options: string[]) => {
				prompts.push(title);
				return options.find((o) => o.startsWith(human?.select ?? "")) ?? undefined;
			},
			input: async (title: string) => {
				prompts.push(title);
				return human?.input;
			},
			/** 问答页 mock:工厂第 4 参 done 收裁决;human.custom 是题目断言 + 答案来源 */
			custom: async (factory: any) => {
				let captured: any[] = [];
				const page = factory({}, plainTheme(), {}, (r: any) => {
					page.result = r;
				});
				captured = human?.custom ? human.custom(page) : [];
				return captured ?? { status: "cancelled" };
			},
		},
		getContextUsage: () => ({ tokens: 0, contextWindow: 100_000, percent: 0 }),
		sessionManager: { getSessionFile: () => "/tmp/fake-session.jsonl", getEntries: () => [] },
		modelRegistry: { find: () => undefined },
	};
}

/** 与 chrome 一致的恒等着色器,给 mock 的 ui.custom 工厂用 */
function plainTheme() {
	return {
		fg: (_c: string, s: string) => s,
		bg: (_c: string, s: string) => s,
		bold: (s: string) => s,
	};
}

/** 所有 mission 共用的一条完成条件;AC 用 covers: ["DW1"] 指回它 */
const DW = [{ id: "DW1", text: "hello.txt 存在且内容含 hello" }];

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
	assert.equal(rt.active!.state.phase, "define", "standard 起于 DEFINE");
	const fr = await rt.define(ctx, {
		goal: "create hello.txt",
		doneWhen: [{ id: "DW1", text: "仓库根目录有一个内容含 hello 的 hello.txt" }],
		constraints: [],
		nonGoals: [],
	});
	assert.ok("ok" in fr, JSON.stringify(fr));
	const wp = await rt.writePlan(ctx, {
		goal: "create hello.txt",
		acceptanceCriteria: [{ id: "AC1", text: "hello.txt 存在且含 hello", verify: "hello-exists", covers: ["DW1"] }],
		milestones: [{ id: "M1", title: "only", tasks: [{ id: "T1", title: "create hello.txt", verify: ["hello-exists"] }] }],
		verifyScript: VERIFY_SH,
	});
	assert.ok("ok" in wp, JSON.stringify(wp));
	assert.equal(rt.active!.state.phase, "do");
	assert.equal(rt.active!.state.currentTask, "T1");
	return { pi, ctx, rt };
}

function snapshotOf(rt: Runtime): MissionSnapshotV2 {
	const loaded = rt.repository.load(rt.active!.state.missionId);
	assert.ok(loaded.ok, loaded.error);
	return loaded.snapshot;
}

function missionMdOf(rt: Runtime): string {
	return rt.repository.generationMissionMd(snapshotOf(rt));
}

function verifyShOf(rt: Runtime): string {
	return rt.repository.generationVerifySh(snapshotOf(rt));
}

test("完整闭环:fail → act → adjust → pass → done", async () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-missions-smoke-"));
	const { pi, ctx, rt } = await newMission(tmp);

	// 计划与脚手架已落盘
	assert.ok(fs.existsSync(missionMdOf(rt)));
	assert.ok(fs.existsSync(verifyShOf(rt)));
	assert.ok(fs.existsSync(path.join(tmp, "missions", "phases", "do.md")));

	// 第一轮:hello.txt 不存在 → hard fail → act
	let r = await rt.applyEvent({ type: "SUBMIT", at: Date.now() }, ctx);
	assert.ok(!r.error);
	await rt.runCheck(ctx);
	assert.equal(rt.active!.state.phase, "act");
	assert.equal(rt.active!.state.tasks.T1.sameSignatureCount, 1);
	assert.ok(pi.calls.entries.some((e) => e.type === "missions-verdict" && e.data.verdict.outcome === "fail"));
	const checkFile = path.join(tmp, "missions", "state", rt.active!.state.missionId, "CHECK.json");
	const check = JSON.parse(fs.readFileSync(checkFile, "utf8"));
	assert.equal(check.stage, "completed");
	assert.equal(check.outcome, "fail");
	assert.equal(check.completedBranches[0].acId, "hello-exists");
	assert.equal(check.completedBranches[0].exitCode, 1);
	const firstEvidenceFile = path.join(
		tmp,
		"missions",
		"state",
		rt.active!.state.missionId,
		"evidence",
		"T1-attempt1.json",
	);
	const firstEvidence = JSON.parse(fs.readFileSync(firstEvidenceFile, "utf8")).evidences[0];
	assert.match(firstEvidence.command, /verify\.sh hello-exists/);
	assert.equal(typeof firstEvidence.startedAt, "number");
	assert.equal(typeof firstEvidence.durationMs, "number");
	assert.equal(typeof firstEvidence.stdout, "string");
	assert.equal(typeof firstEvidence.stderr, "string");
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
	const snapshotFile = path.join(tmp, "missions", "state", rt.active!.state.missionId, "SNAPSHOT.json");
	const saved = JSON.parse(fs.readFileSync(snapshotFile, "utf8")).state;
	assert.equal(saved.phase, "done");
	assert.equal(saved.tasks.T1.status, "done");
	const log = fs.readFileSync(path.join(tmp, "missions", "state", rt.active!.state.missionId, "LOG.md"), "utf8");
	assert.ok(log.includes("verdict=FAIL"));
	assert.ok(log.includes("verdict=PASS"));
	// 证据归档
	assert.ok(fs.readdirSync(path.join(tmp, "missions", "state", rt.active!.state.missionId, "evidence")).length >= 2);
});

test("CHECK 执行异常转为 INCONCLUSIVE 并回到 DO,不会卡死在 check", async () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-missions-smoke-"));
	const { pi, ctx, rt } = await newMission(tmp);
	const originalExec = pi.exec;
	pi.exec = async (cmd: string, args: string[], opts?: { cwd?: string; timeout?: number }) => {
		if (cmd === "bash" && String(args[0]).endsWith("verify.sh")) {
			throw new Error("spawn failed");
		}
		return originalExec(cmd, args, opts);
	};

	const submitted = await rt.applyEvent({ type: "SUBMIT", at: Date.now() }, ctx);
	assert.ok(!submitted.error);
	await rt.runCheck(ctx);
	assert.equal(rt.active!.state.phase, "do");
	assert.equal(rt.active!.state.tasks.T1.inconclusiveStreak, 1);
	const checkFile = path.join(tmp, "missions", "state", rt.active!.state.missionId, "CHECK.json");
	const check = JSON.parse(fs.readFileSync(checkFile, "utf8"));
	assert.equal(check.stage, "error");
	assert.match(check.error, /spawn failed/);
	assert.ok(pi.calls.followUps.some((message) => message.includes("DO")));
});

test("配置的 verifier 模型解析不到 → 显式 hard-only 降级,不静默退回会话模型", async () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-missions-smoke-"));
	const { ctx, rt } = await newMission(tmp);
	rt.active!.git = true; // 临时目录不是 git 仓库;这里要测的是模型解析,不是仓库探测
	// 会话模型明明可用,但 verifier 配的是一个 modelRegistry 里不存在的模型
	(ctx as any).model = { provider: "session", id: "main" };
	fs.writeFileSync(
		path.join(tmp, "missions", "models.json"),
		JSON.stringify({ verifier: { provider: "openai", model: "gpt-x", thinking: "low" } }),
	);
	fs.writeFileSync(path.join(tmp, "hello.txt"), "hello\n");

	const submitted = await rt.applyEvent({ type: "SUBMIT", at: Date.now() }, ctx);
	assert.ok(!submitted.error);
	await rt.runCheck(ctx);

	const checkFile = path.join(tmp, "missions", "state", rt.active!.state.missionId, "CHECK.json");
	const check = JSON.parse(fs.readFileSync(checkFile, "utf8"));
	assert.equal(check.verifier.status, "degraded");
	assert.match(check.verifier.message, /openai\/gpt-x 不可用/, "要写明是哪个配置不可用,而不是静默换模型");
	const log = fs.readFileSync(path.join(tmp, "missions", "state", rt.active!.state.missionId, "LOG.md"), "utf8");
	assert.ok(log.includes("降级为 hard-only"), "降级必须进审计链");
	// hard 证据仍然足够:不因为 verifier 缺席而误伤
	assert.equal(rt.active!.state.phase, "done");
});

test("startCheck 对并发调用复用同一个 CHECK", async () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-missions-smoke-"));
	const { ctx, rt } = await newMission(tmp);
	let finish!: () => void;
	const pending = new Promise<void>((resolve) => {
		finish = resolve;
	});
	let runs = 0;
	rt.runCheck = async () => {
		runs += 1;
		await pending;
	};

	const first = rt.startCheck(ctx);
	const second = rt.startCheck(ctx);
	assert.strictEqual(second, first);
	assert.equal(runs, 1);

	rt.active = {
		...rt.active!,
		state: structuredClone(rt.active!.state),
	};
	const otherMissionInstance = rt.startCheck(ctx);
	assert.notStrictEqual(otherMissionInstance, first);
	assert.equal(runs, 2, "新的附着实例不应被旧 CHECK 阻塞");

	finish();
	await Promise.all([first, otherMissionInstance]);

	const third = rt.startCheck(ctx);
	assert.notStrictEqual(third, first);
	await third;
	assert.equal(runs, 3);
});

test("startCheck 吸收后台异常并允许重试", async () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-missions-smoke-"));
	const { ctx, rt } = await newMission(tmp);
	let runs = 0;
	rt.runCheck = async () => {
		runs += 1;
		throw new Error("background failed");
	};

	await assert.doesNotReject(rt.startCheck(ctx));
	await assert.doesNotReject(rt.startCheck(ctx));
	assert.equal(runs, 2);
	assert.ok(ctx.notifications.some((message) => message.includes("background failed")));
});

test("CHECK widget 运行时刷新计时,销毁后停止", async () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-missions-smoke-"));
	const { ctx, rt } = await newMission(tmp);
	let factory: ((tui: any, theme: any) => { dispose?: () => void }) | undefined;
	(ctx.ui as any).setWidget = (_key: string, content: typeof factory) => {
		factory = content;
	};
	rt.active!.state.phase = "check";
	(rt as any).liveCheckState = {
		taskId: "T1",
		attempt: 1,
		startedAt: Date.now(),
		updatedAt: Date.now(),
		stage: "running_verifier",
		completedBranches: [],
		verifier: { status: "running", startedAt: Date.now() },
		summary: "核验中",
	};

	rt.refreshWidget(ctx);
	assert.ok(factory);
	let renders = 0;
	const component = factory!(
		{ requestRender: () => void (renders += 1) },
		{ fg: (_color: string, text: string) => text, bold: (text: string) => text },
	);
	await new Promise((resolve) => setTimeout(resolve, 550));
	assert.ok(renders > 0);

	component.dispose?.();
	const stoppedAt = renders;
	await new Promise((resolve) => setTimeout(resolve, 550));
	assert.equal(renders, stoppedAt);
});

test("计划不合法时被 writePlan 拒绝", async () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-missions-smoke-"));
	const pi = mockPi();
	const ctx = mockCtx(tmp);
	const rt = new Runtime(pi, tmp);
	await rt.startNew(ctx, "x", "standard");
	await rt.define(ctx, { goal: "x", doneWhen: DW, constraints: [], nonGoals: [] });
	const r = await rt.writePlan(ctx, {
		goal: "x",
		acceptanceCriteria: [{ id: "AC1", text: "y", verify: "missing-branch" , covers: ["DW1"] }],
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
	assert.ok(rt.gate("write", { path: `missions/state/${rt.active!.state.missionId}/generations/1/MISSION.md` }));
	// do 相位写 state → 拦
	assert.ok(rt.gate("edit", { path: `missions/state/${rt.active!.state.missionId}/SNAPSHOT.json` }));
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
	const handoff = rt.active!.handoff!;
	ctx2.sessionManager = {
		getSessionFile: () => "/tmp/replacement-session.jsonl",
		getEntries: () => [
			{
				type: "custom",
				customType: "pi-missions-handoff",
				data: {
					missionId: rt.active!.state.missionId,
					token: handoff.token,
					revision: handoff.requestedRevision,
				},
			},
		],
	};
	const rt2 = new Runtime(pi2, tmp);
	assert.equal(rt2.active, null, "新实例内存为空");

	await rt2.onSessionStart({ reason: "new", previousSessionFile: handoff.parentSession }, ctx2);

	// 从磁盘接上 + 换脑握手完成 + 闸门重新生效
	assert.ok(rt2.active, "必须从磁盘重附着");
	assert.equal(rt2.active!.state.pendingHandoff, null, "HANDOFF_DONE 已落账");
	assert.equal(rt2.active!.state.phase, "do");
	assert.equal(rt2.active!.state.sessionMap.T1, "/tmp/replacement-session.jsonl");
	assert.ok(
		rt2.gate("write", { path: `missions/state/${rt2.active!.state.missionId}/generations/1/MISSION.md` }),
		"闸门在接力后必须重新生效",
	);
	assert.equal(rt2.gate("write", { path: "src/main.ts" }), null, "换脑完成后写工具解冻");
	// 用户现场 profile 落盘,跨实例可还原
	assert.ok(
		fs.existsSync(path.join(tmp, "missions", "state", rt2.active!.state.missionId, "profile.json")),
	);
});

test("/mission next:写入 handoff marker；newSession 取消则显式解锁", async () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-missions-smoke-"));
	const pi = mockPi();
	const ctx = mockCtx(tmp) as any;
	const rt = new Runtime(pi, tmp);
	await rt.startNew(ctx, "验证换脑 marker", "standard");
	let marker: unknown = null;
	ctx.newSession = async (opts: any) => {
		await opts.setup({
			appendCustomEntry: (type: string, data: unknown) => {
				marker = { type, data };
			},
			appendMessage: () => {},
		});
		return { cancelled: false };
	};

	assert.deepEqual(await rt.handoff(ctx), { ok: true });
	assert.equal((marker as any).type, "pi-missions-handoff");
	assert.equal((marker as any).data.token, rt.active!.handoff!.token);
	assert.ok(rt.active!.state.pendingHandoff, "新会话尚未握手前必须保持硬阻断");

	const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), "pi-missions-smoke-"));
	const ctx2 = mockCtx(tmp2) as any;
	ctx2.newSession = async () => ({ cancelled: true });
	const rt2 = new Runtime(mockPi(), tmp2);
	await rt2.startNew(ctx2, "验证取消换脑", "standard");
	assert.deepEqual(await rt2.handoff(ctx2), { ok: true });
	assert.equal(rt2.active!.state.pendingHandoff, null);
	assert.equal(rt2.active!.handoff, null);
	const saved = rt2.repository.load(rt2.active!.state.missionId);
	assert.ok(saved.ok, saved.error);
	assert.equal(saved.snapshot.handoff, null);

	const tmp3 = fs.mkdtempSync(path.join(os.tmpdir(), "pi-missions-smoke-"));
	const ctx3 = mockCtx(tmp3) as any;
	ctx3.newSession = async () => {
		throw new Error("session backend unavailable");
	};
	const rt3 = new Runtime(mockPi(), tmp3);
	await rt3.startNew(ctx3, "验证换脑创建失败", "standard");
	const failed = await rt3.handoff(ctx3);
	assert.match("error" in failed ? failed.error : "", /session backend unavailable/);
	assert.ok(rt3.active!.state.pendingHandoff, "创建失败后保留挂起请求，允许重试");
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

test("quick 档:内存态不落盘,命令判据驱动判定", async () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-missions-smoke-"));
	const pi = mockPi();
	const ctx = mockCtx(tmp);
	const rt = new Runtime(pi, tmp);
	const r = await rt.startQuick(ctx, "create hello.txt", {
		judge: "command",
		text: "test -f hello.txt",
		command: "test -f hello.txt",
	});
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

test("quick 命令判据:进 DO 前冻结,走完判定闭环", async () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-missions-smoke-"));
	const pi = mockPi();
	const ctx = mockCtx(tmp);
	const rt = new Runtime(pi, tmp);

	const r = await rt.startQuick(ctx, "create hello.txt", {
		judge: "command",
		text: "test -f hello.txt",
		command: "test -f hello.txt",
	});
	assert.ok("id" in r, JSON.stringify(r));
	assert.equal(r.tier, "quick");
	assert.equal(rt.active!.state.tier, "quick");
	assert.equal(rt.active!.state.phase, "do");
	assert.deepEqual(rt.active!.quickCriterion, {
		judge: "command",
		text: "test -f hello.txt",
		command: "test -f hello.txt",
	});
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

test("quick 不问人:停在 PLAN 只给只读工具,AI 交判据后才解锁写工具进 DO", async () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-missions-smoke-"));
	const pi = mockPi();
	const ctx = mockCtx(tmp);
	const rt = new Runtime(pi, tmp);

	const r = await rt.startQuick(ctx, "把导航栏在窄屏下改成汉堡菜单");
	assert.ok("id" in r, JSON.stringify(r));
	assert.equal(r.tier, "quick", "写不出 shell 断言不再被踢去 standard");
	assert.equal(rt.active!.state.phase, "plan");

	// 判据先于写代码冻结 —— 这一步是工具闸门的物理保证,不是提示词约定
	const planTools = pi.calls.activeTools.at(-1)!;
	assert.ok(planTools.includes("mission_criterion"));
	assert.ok(!planTools.includes("write") && !planTools.includes("edit"), "判据没定就不给写工具");
	assert.ok(!planTools.includes("mission_submit"));

	// 空泛判据被 L0 退回,相位不动
	const bad = await rt.freezeQuickCriterion(ctx, { judge: "ai", text: "样式正确显示出来" });
	assert.ok("error" in bad && bad.error.includes("锚点"), JSON.stringify(bad));
	assert.equal(rt.active!.state.phase, "plan", "判据不合格就不该进 DO");

	// 复读目标同样退回
	const echo = await rt.freezeQuickCriterion(ctx, { judge: "ai", text: "把导航栏在窄屏下改成汉堡菜单" });
	assert.ok("error" in echo && echo.error.includes("复读"), JSON.stringify(echo));

	const ok = await rt.freezeQuickCriterion(ctx, {
		judge: "human",
		text: "窄屏下导航折叠成汉堡,点开含全部入口,宽屏布局不变",
	});
	assert.ok("ok" in ok, JSON.stringify(ok));
	assert.equal(rt.active!.state.phase, "do");
	assert.equal(rt.active!.quickCriterion?.judge, "human");

	const doTools = pi.calls.activeTools.at(-1)!;
	assert.ok(doTools.includes("mission_submit") && doTools.includes("write"), "冻结之后才解锁写工具");
	assert.equal(ctx.notifications.length, 0, "全程没打断人");
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

test("quick 的 State Card 必须印出真实判据与裁判(印不出来 planner 会以为没冻结)", async () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-missions-smoke-"));
	const pi = mockPi();
	const ctx = mockCtx(tmp);
	const rt = new Runtime(pi, tmp);
	await rt.startQuick(ctx, "调整小组件在卡片里的排布");

	// 判据未冻结:说清楚下一步是什么,而不是含糊成"没有 AC"
	const before = renderStateCard(rt.active!.plan, rt.active!.state, "missions", 0, rt.active!.quickCriterion);
	assert.ok(before.includes("mission_criterion"), before);
	assert.ok(!before.includes("--verify"), "别再提一个已经不存在的入口");

	await rt.freezeQuickCriterion(ctx, {
		judge: "human",
		text: "大档卡片里预览完整可见,不出现内容溢出或被裁切",
	});
	const after = renderStateCard(rt.active!.plan, rt.active!.state, "missions", 0, rt.active!.quickCriterion);
	assert.ok(after.includes("大档卡片里预览完整可见"), "判据正文必须在卡片上,否则模型会自己造一套");
	assert.ok(after.includes("人工终审"), "谁来判也要写清楚");
	assert.ok(!after.includes("submit 时提供"), "与 mission_submit 不收参数直接矛盾的旧文案");
});

test("空壳 AC(冻结时就绿)被基线打回,计划不冻结", async () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-missions-smoke-"));
	const pi = mockPi();
	const ctx = mockCtx(tmp);
	const rt = new Runtime(pi, tmp);
	await rt.startNew(ctx, "x", "standard");
	await rt.define(ctx, { goal: "x", doneWhen: DW, constraints: [], nonGoals: [] });

	const r = await rt.writePlan(ctx, {
		goal: "x",
		acceptanceCriteria: [{ id: "AC1", text: "看起来可执行,其实是空壳", verify: "always-ok" , covers: ["DW1"] }],
		milestones: [{ id: "M1", title: "m", tasks: [{ id: "T1", title: "t", verify: ["always-ok"] }] }],
		verifyScript: '#!/usr/bin/env bash\ncase "$1" in\n  always-ok) exit 0 ;;\n  *) exit 2 ;;\nesac\n',
	});

	assert.ok("error" in r, "exit 0 的分支必须被拒");
	assert.match((r as any).error, /在动手之前就已经通过/);
	assert.equal(rt.active!.state.phase, "plan", "计划未冻结,仍在 PLAN");
	// MISSION.md 从 define 起就存在(恢复锚点),但被拒的计划内容不能进去
	const onDisk = parseMissionMd(fs.readFileSync(missionMdOf(rt), "utf8"));
	assert.equal(onDisk?.acceptanceCriteria.length, 0, "被拒的 AC 不落 MISSION.md");
	assert.equal(onDisk?.verifyScript, "", "被拒的 verify.sh 不落 MISSION.md");
	const log = fs.readFileSync(path.join(tmp, "missions", "state", rt.active!.state.missionId, "LOG.md"), "utf8");
	assert.ok(log.includes("baseline REJECTED"));
});

test("回归项显式声明 baseline green 才放行,并与红项共存", async () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-missions-smoke-"));
	const pi = mockPi();
	const ctx = mockCtx(tmp);
	const rt = new Runtime(pi, tmp);
	await rt.startNew(ctx, "x", "standard");
	await rt.define(ctx, { goal: "x", doneWhen: DW, constraints: [], nonGoals: [] });

	const script = '#!/usr/bin/env bash\ncase "$1" in\n  hello-exists) test -f hello.txt ;;\n  no-regression) exit 0 ;;\n  *) exit 2 ;;\nesac\n';

	// 回归项不声明 green → 被当成 red,基线不符,拒
	const bad = await rt.writePlan(ctx, {
		goal: "x",
		acceptanceCriteria: [
			{ id: "AC1", text: "hello.txt 存在", verify: "hello-exists" , covers: ["DW1"] },
			{ id: "AC2", text: "现有测试不许挂", verify: "no-regression" , covers: ["DW1"] },
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
			{ id: "AC1", text: "hello.txt 存在", verify: "hello-exists" , covers: ["DW1"] },
			{ id: "AC2", text: "现有测试不许挂", verify: "no-regression", baseline: "green" , covers: ["DW1"] },
		],
		milestones: [{ id: "M1", title: "m", tasks: [{ id: "T1", title: "t", verify: ["hello-exists"] }] }],
		verifyScript: script,
	});
	assert.ok("ok" in ok, JSON.stringify(ok));
	assert.equal(rt.active!.state.phase, "do");
	const md = fs.readFileSync(missionMdOf(rt), "utf8");
	assert.ok(md.includes("baseline: green"), "MISSION.md 要写明基线声明");
	assert.ok(md.includes("baseline: red"));
});

test("完成条件覆盖:漏一条 / 孤儿 AC 都冻结不了", async () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-missions-smoke-"));
	const pi = mockPi();
	const ctx = mockCtx(tmp);
	const rt = new Runtime(pi, tmp);
	await rt.startNew(ctx, "x", "standard");
	await rt.define(ctx, {
		goal: "x",
		doneWhen: [
			{ id: "DW1", text: "hello.txt 存在且含 hello" },
			{ id: "DW2", text: "现有测试不许挂" },
		],
		constraints: [],
		nonGoals: [],
	});

	const script = '#!/usr/bin/env bash\ncase "$1" in\n  hello-exists) test -f hello.txt ;;\n  no-regression) exit 0 ;;\n  *) exit 2 ;;\nesac\n';
	const ms = [{ id: "M1", title: "m", tasks: [{ id: "T1", title: "t", verify: ["hello-exists"] }] }];

	// DW2 没有任何 AC 覆盖 —— "人以为会做、机器不会验"的那部分
	const missing = await rt.writePlan(ctx, {
		goal: "x",
		acceptanceCriteria: [{ id: "AC1", text: "hello.txt 存在", verify: "hello-exists", covers: ["DW1"] }],
		milestones: ms,
		verifyScript: script,
	});
	assert.ok("error" in missing);
	assert.match((missing as any).error, /没有任何 AC 覆盖:DW2/);

	// 孤儿 AC —— planner 在批准的目标之外自己加戏
	const orphan = await rt.writePlan(ctx, {
		goal: "x",
		acceptanceCriteria: [
			{ id: "AC1", text: "hello.txt 存在", verify: "hello-exists", covers: ["DW1", "DW2"] },
			{ id: "AC2", text: "顺手加的", verify: "no-regression", baseline: "green" },
		],
		milestones: ms,
		verifyScript: script,
	});
	assert.ok("error" in orphan);
	assert.match((orphan as any).error, /AC2 没有声明它覆盖哪条完成条件/);
	assert.equal(rt.active!.state.phase, "plan", "被拒不迁移相位");

	// 两条都覆盖上就放行
	const ok = await rt.writePlan(ctx, {
		goal: "x",
		acceptanceCriteria: [
			{ id: "AC1", text: "hello.txt 存在", verify: "hello-exists", covers: ["DW1"] },
			{ id: "AC2", text: "现有测试不许挂", verify: "no-regression", baseline: "green", covers: ["DW2"] },
		],
		milestones: ms,
		verifyScript: script,
	});
	assert.ok("ok" in ok, JSON.stringify(ok));
	const md = fs.readFileSync(missionMdOf(rt), "utf8");
	assert.ok(md.includes("覆盖: DW1"), "AC 与完成条件的对应关系要写进 MISSION.md");
	assert.ok(md.includes("DW2: 现有测试不许挂"));
});

test("approach:complex 缺方案冻结不了,standard 可选;方案进 MISSION.md 与 fence", async () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-missions-smoke-"));
	const pi = mockPi();
	const ctx = mockCtx(tmp);
	const rt = new Runtime(pi, tmp);
	await rt.startNew(ctx, "x", "complex");
	await rt.define(ctx, { goal: "x", doneWhen: DW, constraints: [], nonGoals: [] });

	const acs = [{ id: "AC1", text: "hello.txt 存在且含 hello", verify: "hello-exists", covers: ["DW1"] }];
	const ms = [{ id: "M1", title: "m", tasks: [{ id: "T1", title: "t", verify: ["hello-exists"] }] }];

	const noApproach = await rt.writePlan(ctx, { goal: "x", acceptanceCriteria: acs, milestones: ms, verifyScript: VERIFY_SH });
	assert.ok("error" in noApproach);
	assert.match((noApproach as any).error, /complex 档必须写 approach/);

	// 决策没写为什么 —— 没有理由的决策不是决策,是偏好
	const noWhy = await rt.writePlan(ctx, {
		goal: "x",
		approach: { summary: "直接写文件", decisions: [{ id: "D1", text: "用 fs.writeFileSync", why: "  " }] },
		acceptanceCriteria: acs,
		milestones: ms,
		verifyScript: VERIFY_SH,
	});
	assert.ok("error" in noWhy);
	assert.match((noWhy as any).error, /D1 没写为什么/);

	const ok = await rt.writePlan(ctx, {
		goal: "x",
		approach: {
			summary: "在仓库根直接落一个 hello.txt,不引入任何构建步骤",
			decisions: [{ id: "D1", text: "不建 src/ 目录", why: "这个 mission 只产出一个文本文件", rejected: "起一个生成脚本" }],
		},
		acceptanceCriteria: acs,
		milestones: ms,
		verifyScript: VERIFY_SH,
	});
	assert.ok("ok" in ok, JSON.stringify(ok));

	const md = fs.readFileSync(missionMdOf(rt), "utf8");
	assert.ok(md.includes("## Approach"));
	assert.ok(md.includes("否决:起一个生成脚本"));
	const parsed = parseMissionMd(md)!;
	assert.equal(parsed.approach?.decisions[0].id, "D1", "方案要能从 fence 解析回来 —— 换脑后 planner 得读得到");
});

test("计划评审:打回带意见回传 planner,连打三次转 L3 回 DEFINE", async () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-missions-smoke-"));
	const pi = mockPi();
	let approve = false;
	const comment = "AC1 那条根本不会红,换个能判别的写法";
	const ctx = { ...mockCtx(tmp), hasUI: true } as any;
	// 评审页在测试里退化成一个可控的裁决,但**真的渲染一遍** ——
	// 用真实的 plan/state 跑一次 render 才能发现"评审页在真实数据上炸了"
	ctx.ui = {
		...ctx.ui,
		custom: async (factory: any) => {
			const plain = { fg: (_c: string, x: string) => x, bg: (_c: string, x: string) => x, bold: (x: string) => x };
			const comp = factory({ requestRender: () => {}, terminal: { rows: 24 } }, plain, {}, () => {});
			for (const w of [40, 96]) assert.ok(comp.render(w).length > 0);
			return { status: approve ? "approved" : "rejected" };
		},
		editor: async () => comment,
	};

	const rt = new Runtime(pi, tmp);
	await rt.startNew(ctx, "x", "standard");
	await rt.define(ctx, { goal: "x", doneWhen: DW, constraints: [], nonGoals: [] });

	const params = {
		goal: "x",
		acceptanceCriteria: [{ id: "AC1", text: "hello.txt 存在且含 hello", verify: "hello-exists", covers: ["DW1"] }],
		milestones: [{ id: "M1", title: "only", tasks: [{ id: "T1", title: "t", verify: ["hello-exists"] }] }],
		verifyScript: VERIFY_SH,
	};

	// 第一次打回:意见回传给 planner,并进 STATE + State Card + LOG
	const r1 = await rt.writePlan(ctx, params);
	assert.ok("error" in r1);
	assert.match((r1 as any).error, /人工打回.第 1 次./);
	assert.ok((r1 as any).error.includes(comment), "打回意见必须回传 —— 只回一个 bit 的\"不行\"没法改");
	assert.equal(rt.active!.state.phase, "plan");
	assert.equal(rt.active!.state.planReview?.rejections, 1);
	const card = renderStateCard(rt.active!.plan, rt.active!.state, "missions");
	assert.ok(card.includes("PREV REJECTION"), "换脑之后 planner 也要读得到");
	assert.ok(card.includes(comment));
	const logMd = fs.readFileSync(path.join(tmp, "missions", "state", rt.active!.state.missionId, "LOG.md"), "utf8");
	assert.ok(logMd.includes(comment));

	// 第二次
	assert.ok("error" in (await rt.writePlan(ctx, params)));
	assert.equal(rt.active!.state.planReview?.rejections, 2);

	// 第三次:硬拦,转 L3 回 DEFINE 并挂起换脑
	const r3 = await rt.writePlan(ctx, params);
	assert.ok("error" in r3);
	assert.match((r3 as any).error, /不再重交/);
	assert.equal(rt.active!.state.phase, "define");
	assert.equal(rt.active!.state.escalation.level, 3);
	assert.ok(rt.active!.state.pendingHandoff);
	assert.equal(rt.active!.state.defineAsks, 0, "重新定义问题时提问轮次要还回来");

	// 换脑后重新定义 → 批准 → 正常冻结
	await rt.applyEvent({ type: "HANDOFF_DONE", at: Date.now() }, ctx);
	await rt.define(ctx, { goal: "x2", doneWhen: DW, constraints: [], nonGoals: [] });
	approve = true;
	const ok = await rt.writePlan(ctx, params);
	assert.ok("ok" in ok, JSON.stringify(ok));
	assert.equal(rt.active!.state.phase, "do");
});

test("计划评审:Esc 取消不记作打回", async () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-missions-smoke-"));
	const ctx = { ...mockCtx(tmp), hasUI: true } as any;
	ctx.ui = {
		...ctx.ui,
		custom: async () => ({ status: "cancelled" }),
	};
	const rt = new Runtime(mockPi(), tmp);
	await rt.startNew(ctx, "x", "standard");
	await rt.define(ctx, { goal: "x", doneWhen: DW, constraints: [], nonGoals: [] });
	const result = await rt.writePlan(ctx, {
		goal: "x",
		acceptanceCriteria: [{ id: "AC1", text: "hello.txt 存在且含 hello", verify: "hello-exists", covers: ["DW1"] }],
		milestones: [{ id: "M1", title: "only", tasks: [{ id: "T1", title: "t", verify: ["hello-exists"] }] }],
		verifyScript: VERIFY_SH,
	});
	assert.deepEqual(result, { error: "计划评审已取消,未冻结也未记作打回" });
	assert.equal(rt.active!.state.planReview.rejections, 0);
	assert.equal(rt.active!.state.phase, "plan");
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
		acceptanceCriteria: [{ id: "AC1", text: "hello.txt 存在且含 hello", verify: "hello-exists" , covers: ["DW1"] }],
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
	await rt.define(ctx, { goal: "x", doneWhen: DW, constraints: [], nonGoals: [] });

	const r = await rt.writePlan(ctx, {
		goal: "x",
		acceptanceCriteria: [{ id: "AC1", text: "空壳", verify: "always-ok" , covers: ["DW1"] }],
		milestones: [{ id: "M1", title: "m", tasks: [{ id: "T1", title: "t", verify: ["always-ok"] }] }],
		verifyScript: '#!/usr/bin/env bash\ncase "$1" in\n  always-ok) exit 0 ;;\n  *) exit 2 ;;\nesac\n',
	});
	assert.ok("error" in r);

	assert.equal(rt.active!.plan.acceptanceCriteria.length, 0, "被拒的 AC 不进 a.plan");
	const card = renderStateCard(rt.active!.plan, rt.active!.state, "missions");
	assert.ok(!card.includes("空壳"), "被拒的 AC 不该以冻结口径出现在卡片里");
	assert.ok(card.includes("尚未冻结"));
});

function q(id: string, text: string, over: Record<string, unknown> = {}) {
	return { id, text, recommend: "按接口 p95 口径", impact: `决定 ${id} 对应的完成条件怎么写`, ...over };
}

test("DEFINE:提问闸门由 L0 强制 —— 每问带推荐答案、每轮 ≤3、standard 2 轮、要结账", async () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-missions-smoke-"));
	// 问答页 mock:记录题目,人把两题都按推荐作答
	let seenQuestions: any[] = [];
	const ctx = mockCtx(tmp, {
		custom: () => {
			return { status: "answered", answers: seenQuestions.map(() => ({ kind: "none" })) };
		},
	});
	// 借 custom 工厂拿到题目:openAskReview 的 questions 在闭包里,从这里探
	// (mock 的 custom 不经过工厂渲染,题目断言靠下面信封的内容兜底)
	const pi = mockPi();
	const rt = new Runtime(pi, tmp);
	await rt.startNew(ctx, "让登录快一点", "standard");
	assert.equal(rt.active!.state.phase, "define");

	// 超过每轮 3 个:拒,且不消耗轮次
	const tooMany = await rt.ask(ctx, [q("Q1", "a"), q("Q2", "b"), q("Q3", "c"), q("Q4", "d")], []);
	assert.ok("error" in tooMany);
	assert.equal(rt.active!.state.defineAsks, 0, "被拒的提问不算一轮");

	// 没有推荐答案:拒 —— 那是懒问题
	const lazy = await rt.ask(ctx, [q("Q1", "能详细说说需求吗?", { recommend: "" })], []);
	assert.ok("error" in lazy);
	assert.match((lazy as any).error, /没有给推荐答案/);
	assert.equal(rt.active!.state.defineAsks, 0);

	// 首轮 3 个:放行,人通过交互页作答,答案直接回到信封里
	const first = await rt.ask(
		ctx,
		[q("Q1", "『快』指首屏还是接口?"), q("Q2", "目标多少 ms?", { recommend: "p95 < 300ms" }), q("Q3", "允许改数据库 schema 吗?")],
		[],
	);
	assert.ok("ok" in first, JSON.stringify(first));
	assert.equal(rt.active!.state.defineAsks, 1);
	assert.ok(String((first as any).envelope).includes("『快』指首屏还是接口?"), "信封里有问答记录");
	assert.ok(String((first as any).envelope).includes("(人未作答,采用推荐)"), "未作答回落推荐要标记");
	// 答案落进 state —— 换脑后照这里抄 resolved
	assert.equal(rt.active!.state.defineAnswers.length, 3);
	assert.deepEqual(rt.active!.state.defineAnswers[1], { q: "目标多少 ms?", a: "p95 < 300ms" });
	assert.ok(seenQuestions !== undefined);
	void seenQuestions;

	// 第二轮但没结账:拒 —— 上一轮问完什么都没定下来
	const stalled = await rt.ask(ctx, [q("Q4", "再问一个")], []);
	assert.ok("error" in stalled);
	assert.match((stalled as any).error, /没有任何决策落定/);
	assert.equal(rt.active!.state.defineAsks, 1, "被拒不消耗轮次");

	// 第二轮 + 结账增长:放行
	const second = await rt.ask(ctx, [q("Q4", "限流是否也算在内?")], ["Q1", "Q2"]);
	assert.ok("ok" in second, JSON.stringify(second));
	assert.equal(rt.active!.state.defineAsks, 2);
	assert.deepEqual(rt.active!.state.defineSettled, ["Q1", "Q2"]);
	assert.equal(rt.active!.state.defineAnswers.length, 4, "回答按轮累积");

	// 第三轮:standard 只有 2 轮
	const third = await rt.ask(ctx, [q("Q5", "还有吗?")], ["Q1", "Q2", "Q4"]);
	assert.ok("error" in third);
	assert.match((third as any).error, /轮次已经用完/);

	// 问过就必须交回答 —— state 里有记录,resolved 仍要模型显式带来(答案与完成条件的对应由它衔接)
	const noResolved = await rt.define(ctx, {
		goal: "登录接口 p95 从 800ms 降到 300ms 以内",
		doneWhen: [{ id: "DW1", text: "登录接口 p95 < 300ms" }],
		constraints: [],
		nonGoals: [],
	});
	assert.ok("error" in noResolved);
	assert.match((noResolved as any).error, /没有交 resolved/);

	// doneWhen 为空也不行
	const noDw = await rt.define(ctx, {
		goal: "x",
		doneWhen: [],
		constraints: [],
		nonGoals: [],
		resolved: [{ q: "『快』指什么?", a: "接口" }],
	});
	assert.ok("error" in noDw);
	assert.match((noDw as any).error, /doneWhen 为空/);

	// 交定义 → 进 PLAN,完成条件/约束/边界/接缝进 State Card
	const fr = await rt.define(ctx, {
		goal: "登录接口 p95 从 800ms 降到 300ms 以内",
		doneWhen: [{ id: "DW1", text: "登录接口 p95 < 300ms" }],
		constraints: ["不改数据库 schema"],
		nonGoals: ["前端首屏优化"],
		verifySeam: "已有集成测试 test/auth/*",
		resolved: [{ q: "『快』指首屏还是接口?", a: "接口" }],
	});
	assert.ok("ok" in fr, JSON.stringify(fr));
	assert.equal(rt.active!.state.phase, "plan");
	assert.equal(rt.active!.plan.goal, "登录接口 p95 从 800ms 降到 300ms 以内");

	const card = renderStateCard(rt.active!.plan, rt.active!.state, "missions");
	assert.ok(card.includes("不改数据库 schema"));
	assert.ok(card.includes("前端首屏优化"));
	assert.ok(card.includes("DW1"), "完成条件要进 State Card —— PLAN 得照着它写 AC");
	assert.ok(card.includes("已有集成测试 test/auth/*"));

	// PLAN 相位不能再提问,也不能重复定义
	assert.ok("error" in (await rt.ask(ctx, [q("Q9", "x")], [])));
	assert.ok("error" in (await rt.define(ctx, { goal: "y", doneWhen: DW, constraints: [], nonGoals: [] })));
});

test("DEFINE:人中断问答(Esc)烧轮次但不留答案;无 UI 宿主被拒并指引改走聊天", async () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-missions-smoke-"));
	// 中断:custom mock 返回 cancelled
	const ctxEsc = mockCtx(tmp, { custom: () => undefined });
	const rtEsc = new Runtime(mockPi(), tmp);
	await rtEsc.startNew(ctxEsc, "让登录快一点", "standard");
	const esc = await rtEsc.ask(ctxEsc, [q("Q1", "『快』指首屏还是接口?")], []);
	assert.ok("ok" in esc, JSON.stringify(esc));
	assert.equal(rtEsc.active!.state.defineAsks, 1, "中断也算一轮 —— 否则模型可以反复问反复中断原地打转");
	assert.equal(rtEsc.active!.state.defineAnswers.length, 0, "中断不留答案");
	assert.match(String((esc as any).envelope), /人中断/);
	assert.match(String((esc as any).envelope), /不要原样重问/);

	// 自定义文本回答:原样进信封与 state
	const ctxCustom = mockCtx(tmp, {
		custom: () => ({ status: "answered", answers: [{ kind: "custom", value: "首屏 LCP < 2.5s" }] }),
	});
	const rtCustom = new Runtime(mockPi(), tmp);
	await rtCustom.startNew(ctxCustom, "让登录快一点", "standard");
	const custom = await rtCustom.ask(ctxCustom, [q("Q1", "『快』指首屏还是接口?")], []);
	assert.ok("ok" in custom);
	assert.deepEqual(rtCustom.active!.state.defineAnswers, [{ q: "『快』指首屏还是接口?", a: "首屏 LCP < 2.5s" }]);
	assert.match(String((custom as any).envelope), /首屏 LCP < 2.5s/);
	assert.doesNotMatch(String((custom as any).envelope), /人未作答/);

	// 无 UI(RPC/ACP):直接拒,不再铺静态卡片
	const ctxNoUi = mockCtx(tmp);
	const rtNoUi = new Runtime(mockPi(), tmp);
	await rtNoUi.startNew(ctxNoUi, "让登录快一点", "standard");
	const noUi = await rtNoUi.ask(ctxNoUi, [q("Q1", "『快』指首屏还是接口?")], []);
	assert.ok("error" in noUi);
	assert.match((noUi as any).error, /没有交互界面/);
	assert.equal(rtNoUi.active!.state.defineAsks, 0, "打不开页面的提问不算一轮");
});

test("DEFINE 范围确认:complex 恒确认,拒绝则停在 DEFINE 且不返还轮次", async () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-missions-smoke-"));
	const pi = mockPi();
	let answer = false;
	const ctx = { ...mockCtx(tmp), hasUI: true } as any;
	ctx.ui = { ...ctx.ui, confirm: async () => answer };
	const rt = new Runtime(pi, tmp);
	await rt.startNew(ctx, "重构鉴权", "complex");

	const params = {
		goal: "把鉴权从 session 迁到 JWT",
		doneWhen: [{ id: "DW1", text: "旧 session 中间件不再被引用" }],
		constraints: [],
		nonGoals: ["刷新令牌轮换"],
	};
	const rejected = await rt.define(ctx, params);
	assert.ok("error" in rejected);
	assert.match((rejected as any).error, /拒绝了这个范围定义/);
	assert.equal(rt.active!.state.phase, "define", "被拒就停在 DEFINE");

	answer = true;
	assert.ok("ok" in (await rt.define(ctx, params)));
	assert.equal(rt.active!.state.phase, "plan");
});

test("DEFINE 的产出进 MISSION.md fence,冻结后可解析回来", async () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-missions-smoke-"));
	const pi = mockPi();
	const ctx = mockCtx(tmp);
	const rt = new Runtime(pi, tmp);
	await rt.startNew(ctx, "create hello.txt", "standard");
	await rt.define(ctx, { goal: "create hello.txt", doneWhen: DW, constraints: ["只动仓库根目录"], nonGoals: ["不碰 CI"] });
	const wp = await rt.writePlan(ctx, {
		goal: "create hello.txt",
		acceptanceCriteria: [{ id: "AC1", text: "hello.txt 存在且含 hello", verify: "hello-exists" , covers: ["DW1"] }],
		milestones: [{ id: "M1", title: "only", tasks: [{ id: "T1", title: "create hello.txt", verify: ["hello-exists"] }] }],
		verifyScript: VERIFY_SH,
	});
	assert.ok("ok" in wp, JSON.stringify(wp));

	const md = fs.readFileSync(missionMdOf(rt), "utf8");
	assert.ok(md.includes("## Define"));
	assert.ok(md.includes("只动仓库根目录"));
	const parsed = parseMissionMd(md);
	assert.deepEqual(parsed!.definition!.nonGoals, ["不碰 CI"]);
});

test("L3 落点是 DEFINE:归档旧计划、重置提问预算、换脑简报按相位分流", async () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-missions-smoke-"));
	const { ctx, rt } = await newMission(tmp);
	ctx.hasUI = true; // L3 必须人工确认;非交互环境视为拒绝(→ halted),那是另一条路径

	await rt.applyEvent({ type: "ESCALATE", at: Date.now(), to: 3, reason: "AC 定义错了" }, ctx);
	// CONFIRM 效果 → mockCtx.confirm 恒 true → ESCALATION_CONFIRMED
	assert.equal(rt.active!.state.phase, "define", "L3 回 DEFINE 而不是 PLAN");
	assert.equal(rt.active!.state.defineAsks, 0, "新的问题定义可以再问一轮");
	assert.ok(rt.active!.state.pendingHandoff, "升级必须换脑(I5)");
	assert.ok(fs.readdirSync(path.join(tmp, "missions", "state", rt.active!.state.missionId, "archive")).length > 0);

	// 换脑完成后工具集回到 DEFINE:没有 mission_write_plan,也没有写工具
	await rt.applyEvent({ type: "HANDOFF_DONE", at: Date.now() }, ctx);
	assert.equal(rt.gate("write", { path: "src/main.ts" }), null);
	const tools = toolsForPhase(rt.active!.state.phase);
	assert.ok(tools.includes("mission_define") && !tools.includes("mission_write_plan"));

	// 重新定义 → 回到 PLAN,可以带新的 AC 重新冻结
	const fr = await rt.define(ctx, { goal: "换个说法的目标", doneWhen: DW, constraints: [], nonGoals: [] });
	assert.ok("ok" in fr, JSON.stringify(fr));
	assert.equal(rt.active!.state.phase, "plan");
});

const SPIKE_REPORT = [
	"# 结论:旧 ORM 私有 API 的使用面",
	"",
	"grep 了 src/,`_rawQuery` 出现在 3 个模块共 12 处;其中 4 处依赖 v2 才有的 `_hints` 参数,",
	"新 ORM 没有等价物,需要改写成显式 join。其余 8 处可以直接换 API。",
].join("\n");

/** 起一个只含探针任务的计划 */
async function spikeMission(tmp: string) {
	const pi = mockPi();
	const ctx = mockCtx(tmp);
	const rt = new Runtime(pi, tmp);
	await rt.startNew(ctx, "迁移到新 ORM", "standard");
	await rt.define(ctx, { goal: "迁移到新 ORM", doneWhen: DW, constraints: [], nonGoals: [] });
	const wp = await rt.writePlan(ctx, {
		goal: "迁移到新 ORM",
		acceptanceCriteria: [{ id: "AC1", text: "hello.txt 存在", verify: "hello-exists" , covers: ["DW1"] }],
		milestones: [
			{
				id: "M1",
				title: "先摸清改动面",
				tasks: [
					{ id: "T1", title: "摸清旧 ORM 私有 API 的使用面", kind: "spike", question: "私有 API 用在多少处?哪些没有等价物?", verify: [] },
					{ id: "T2", title: "改造", verify: ["hello-exists"] },
				],
			},
		],
		verifyScript: VERIFY_SH,
	});
	assert.ok("ok" in wp, JSON.stringify(wp));
	return { pi, ctx, rt };
}

test("spike:闸门只放行写结论文件,改实现与 bash 写操作都被拦", async () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-missions-smoke-"));
	const { rt } = await spikeMission(tmp);

	assert.equal(rt.active!.state.currentTask, "T1");
	assert.equal(rt.active!.state.tasks.T1.kind, "spike");
	const report = rt.currentSpikeReport()!;
	assert.ok(report.rel.includes("missions/spikes/"));
	assert.ok(fs.existsSync(path.dirname(report.abs)), "结论目录要先建好");

	// 只放行结论文件
	assert.equal(rt.gate("write", { path: report.rel }), null);
	const blocked = rt.gate("write", { path: "src/main.ts" });
	assert.ok(blocked && blocked.includes("只能写结论文件"));
	assert.ok(rt.gate("edit", { path: "src/orm.ts" }));

	// 只读调查放行,写操作拦下
	assert.equal(rt.gate("bash", { command: "grep -rn _rawQuery src/" }), null);
	assert.equal(rt.gate("bash", { command: "npx tsc --noEmit" }), null);
	assert.ok(rt.gate("bash", { command: "sed -i s/a/b/ src/main.ts" }));
	assert.ok(rt.gate("bash", { command: "echo x > src/main.ts" }));
});

test("spike:出结论 → 回 PLAN 重新规划,并强制换脑", async () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-missions-smoke-"));
	const { ctx, rt } = await spikeMission(tmp);
	const report = rt.currentSpikeReport()!;
	fs.writeFileSync(report.abs, SPIKE_REPORT, "utf8");

	await rt.applyEvent({ type: "SUBMIT", at: Date.now() }, ctx);
	await rt.runCheck(ctx);

	assert.equal(rt.active!.state.phase, "plan", "探针不推进到下一任务,回 PLAN");
	assert.equal(rt.active!.state.tasks.T1.status, "done");
	assert.equal(rt.active!.state.currentTask, null);
	assert.ok(rt.active!.state.pendingHandoff, "拿调研噪音去重新规划正是 I5 要避免的");
	assert.ok(fs.readdirSync(path.join(tmp, "missions", "state", rt.active!.state.missionId, "archive")).length > 0);

	// 探针只打一次:重写的计划里不能再排 spike
	await rt.applyEvent({ type: "HANDOFF_DONE", at: Date.now() }, ctx);
	const again = await rt.writePlan(ctx, {
		goal: "迁移到新 ORM",
		acceptanceCriteria: [{ id: "AC1", text: "hello.txt 存在", verify: "hello-exists" , covers: ["DW1"] }],
		milestones: [
			{
				id: "M1",
				title: "再探一次",
				tasks: [{ id: "T3", title: "再看看", kind: "spike", question: "还有别的吗?", verify: [] }],
			},
		],
		verifyScript: VERIFY_SH,
	});
	assert.ok("error" in again);
	assert.match((again as any).error, /已经跑过一次 spike/);
});

test("spike:没写结论就提交 → 判 fail,但同样回 PLAN 不重试", async () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-missions-smoke-"));
	const { ctx, rt } = await spikeMission(tmp);
	fs.writeFileSync(rt.currentSpikeReport()!.abs, "TODO", "utf8"); // 太短,不算结论

	await rt.applyEvent({ type: "SUBMIT", at: Date.now() }, ctx);
	await rt.runCheck(ctx);

	assert.equal(rt.active!.state.phase, "plan", "探针失败也不进 ACT、不熔断");
	assert.equal(rt.active!.state.tasks.T1.status, "blocked");
	assert.equal(rt.active!.state.tasks.T1.attempts, 1, "一次机会");
	assert.equal(rt.active!.state.tasks.T1.sameSignatureCount, 0, "不进熔断计数");
});

test("spike 的结构约束:必须有 question,不能有 verify 分支", async () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-missions-smoke-"));
	const pi = mockPi();
	const ctx = mockCtx(tmp);
	const rt = new Runtime(pi, tmp);
	await rt.startNew(ctx, "x", "standard");
	await rt.define(ctx, { goal: "x", doneWhen: DW, constraints: [], nonGoals: [] });

	const bad = await rt.writePlan(ctx, {
		goal: "x",
		acceptanceCriteria: [{ id: "AC1", text: "hello.txt 存在", verify: "hello-exists" , covers: ["DW1"] }],
		milestones: [
			{ id: "M1", title: "m", tasks: [{ id: "T1", title: "探", kind: "spike", verify: ["hello-exists"] }] },
		],
		verifyScript: VERIFY_SH,
	});
	assert.ok("error" in bad);
	assert.match((bad as any).error, /必须写明它要回答的那一个问题/);
	assert.match((bad as any).error, /不能有 verify 分支/);
});

test("spike 的结论文件放行不能变成绕过闸门的通道", async () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-missions-smoke-"));
	const { rt } = await spikeMission(tmp);
	const report = rt.currentSpikeReport()!;

	// 相对路径与绝对路径两种写法都放行
	assert.equal(rt.gate("write", { path: report.rel }), null);
	assert.equal(rt.gate("write", { path: report.abs }), null);

	// 尾部凑巧相同的别处路径不放行
	assert.ok(rt.gate("write", { path: `../elsewhere/${report.rel}` }));
	assert.ok(rt.gate("write", { path: `evil${report.rel}` }));

	// 冻结件仍然受保护(spike 的放行分支不早退)
	assert.ok(rt.gate("write", { path: `missions/state/${rt.active!.state.missionId}/generations/1/MISSION.md` }));
	assert.ok(rt.gate("write", { path: `missions/state/${rt.active!.state.missionId}/SNAPSHOT.json` }));
});

test("模型设置:写 models.json、记 LOG.md、verifier 中途换裁判要告警", async () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-missions-smoke-"));
	const { pi, ctx, rt } = await newMission(tmp); // 停在 do 相位(executor)

	const modelsFile = path.join(tmp, "missions", "models.json");
	assert.ok(!fs.existsSync(modelsFile), "没配过就不该有这个文件");

	// 配 verifier(不是当前相位角色)
	await rt.setRoleModel(ctx, "verifier", { provider: "openai", id: "gpt-x" }, "low");
	const cfg = JSON.parse(fs.readFileSync(modelsFile, "utf8"));
	assert.deepEqual(cfg.verifier, { provider: "openai", model: "gpt-x", thinking: "low" });

	const log = () => fs.readFileSync(path.join(tmp, "missions", "state", rt.active!.state.missionId, "LOG.md"), "utf8");
	assert.ok(log().includes("MODEL verifier: 跟随会话 → openai/gpt-x"), "判定口径变了,必须进审计链");
	assert.ok(
		ctx.notifications.some((m) => m.includes("verifier")),
		"mission 进行中换 verifier 等于换裁判,要告警",
	);

	// 清除配置 → 回到跟随会话,同样记账
	await rt.setRoleModel(ctx, "verifier", null);
	assert.equal(JSON.parse(fs.readFileSync(modelsFile, "utf8")).verifier.provider, undefined);
	assert.ok(log().includes("MODEL verifier: openai/gpt-x → 跟随会话"));

	// 改当前相位的角色 → 立刻 applyRole(thinking 当场生效)
	const before = pi.calls.thinking.length;
	await rt.setRoleModel(ctx, "executor", null, "xhigh");
	assert.ok(pi.calls.thinking.length > before, "当前相位的角色要立刻生效,不等下次相位切换");
	assert.equal(pi.calls.thinking.at(-1), "xhigh");
});

test("define/plan 阶段换脑可恢复:goal 与 definition 先于冻结落盘(I1)", async () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-missions-smoke-"));
	const pi = mockPi();
	const ctx = mockCtx(tmp);
	const rt = new Runtime(pi, tmp);
	const start = await rt.startNew(ctx, "重构组件管理页", "standard");
	assert.ok("id" in start, JSON.stringify(start));
	const id = start.id;
	assert.equal(rt.active!.state.phase, "define");

	// define 阶段(还没走到 PLAN):MISSION.md 必须已经落盘,goal 可解析
	const mdPath = missionMdOf(rt);
	assert.ok(fs.existsSync(mdPath), "define 阶段就要有 MISSION.md —— 否则换脑后 attach 没有锚点");
	const parsed = parseMissionMd(fs.readFileSync(mdPath, "utf8"));
	assert.equal(parsed?.goal, "重构组件管理页");

	// 模拟会话重建:全新 Runtime 实例,靠 CURRENT 指针从磁盘接上
	const rt2 = new Runtime(mockPi(), tmp);
	assert.ok(await rt2.ensureAttached(mockCtx(tmp)), "define 阶段的 mission 必须能重附着");
	assert.equal(rt2.active!.state.phase, "define");
	assert.equal(rt2.active!.plan.goal, "重构组件管理页");

	// DEFINE 完成 → plan 阶段:definition 落盘,再换脑也不丢
	const dr = await rt2.define(mockCtx(tmp), {
		goal: "重构组件管理页:合并成单列表",
		doneWhen: [{ id: "DW1", text: "整页一个栅格,每种组件一张卡" }],
		constraints: [],
		nonGoals: ["不动首屏布局"],
	});
	assert.ok("ok" in dr, JSON.stringify(dr));
	assert.equal(rt2.active!.state.phase, "plan");

	const rt3 = new Runtime(mockPi(), tmp);
	assert.ok(await rt3.ensureAttached(mockCtx(tmp)), "plan 阶段的 mission 必须能重附着");
	assert.equal(rt3.active!.state.phase, "plan");
	assert.equal(rt3.active!.plan.goal, "重构组件管理页:合并成单列表");
	assert.equal(rt3.active!.plan.definition?.doneWhen[0]?.text, "整页一个栅格,每种组件一张卡");
	assert.deepEqual(rt3.active!.plan.definition?.nonGoals, ["不动首屏布局"]);
});

test("换脑握手:错误 token 与普通 startup 都不能消费 pendingHandoff", async () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-missions-smoke-"));
	const pi = mockPi();
	const ctx = mockCtx(tmp);
	const rt = new Runtime(pi, tmp);
	const start = await rt.startNew(ctx, "验证换脑身份", "standard");
	assert.ok("id" in start, JSON.stringify(start));
	await rt.applyEvent({ type: "HANDOFF_REQUEST", at: Date.now(), reason: "context-watermark 61.53%" }, ctx);
	const handoff = rt.active!.handoff!;

	const wrongCtx = mockCtx(tmp);
	wrongCtx.sessionManager = {
		getSessionFile: () => "/tmp/wrong-session.jsonl",
		getEntries: () => [
			{
				type: "custom",
				customType: "pi-missions-handoff",
				data: { missionId: start.id, token: "wrong", revision: handoff.requestedRevision },
			},
		],
	};
	const wrong = new Runtime(mockPi(), tmp);
	await wrong.onSessionStart({ reason: "new", previousSessionFile: handoff.parentSession }, wrongCtx);
	assert.equal(wrong.active, null);
	assert.ok(wrongCtx.notifications.some((m) => m.includes("token")));

	const startupCtx = mockCtx(tmp);
	const startup = new Runtime(mockPi(), tmp);
	await startup.onSessionStart({ reason: "startup" }, startupCtx);
	assert.equal(startup.active, null);
	assert.ok(startupCtx.notifications.some((m) => m.includes("只能由 /mission next")));
	assert.ok(rt.repository.load(start.id).ok, "错误会话不能损坏 snapshot");
});

test("成本分账:网关不报价时 token 账照记(message_end 按角色累计)", async () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-missions-smoke-"));
	const { rt } = await newMission(tmp); // do 相位,当前角色 executor

	// cost.total = 0(自建网关不报价):美元不记,token 必须记
	await rt.onMessageEnd(
		{ role: "assistant", usage: { input: 1000, output: 200, cacheRead: 8000, cacheWrite: 0, cost: { total: 0 } } },
		mockCtx(tmp),
	);
	assert.deepEqual(rt.active!.state.tokens?.executor, { input: 1000, output: 200, cacheRead: 8000, cacheWrite: 0 });
	assert.equal(rt.active!.state.cost.executor, undefined, "没报价就不记美元");

	// 累计:第二条消息两本账都加
	await rt.onMessageEnd(
		{ role: "assistant", usage: { input: 500, output: 100, cacheRead: 0, cacheWrite: 0, cost: { total: 0.002 } } },
		mockCtx(tmp),
	);
	assert.equal(rt.active!.state.tokens?.executor?.input, 1500);
	assert.equal(rt.active!.state.tokens?.executor?.cacheRead, 8000);
	assert.equal(rt.active!.state.cost.executor, 0.002);

	// 非 assistant 消息不记账
	await rt.onMessageEnd(
		{ role: "user", usage: { input: 999, output: 0, cacheRead: 0, cacheWrite: 0 } },
		mockCtx(tmp),
	);
	assert.equal(rt.active!.state.tokens?.executor?.input, 1500);
});

test("重复 tool_result 不创建无变化 snapshot revision", async () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-missions-smoke-"));
	const ctx = mockCtx(tmp);
	const rt = new Runtime(mockPi(), tmp);
	await rt.startNew(ctx, "验证改动面去重", "standard");

	await rt.onToolResult({ toolName: "edit", input: { path: "src/a.ts" }, isError: false }, ctx);
	const firstRevision = rt.active!.revision;
	await rt.onToolResult({ toolName: "edit", input: { path: "src/a.ts" }, isError: false }, ctx);
	assert.equal(rt.active!.revision, firstRevision);
});

test("补证据闸门:inconclusive 后原样重交被拦截,修改工作区后放行", async () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-missions-smoke-"));
	// 初始化 git 仓库使 treeFp 生效
	await execReal("git", ["init"], { cwd: tmp });
	await execReal("git", ["config", "user.name", "test"], { cwd: tmp });
	await execReal("git", ["config", "user.email", "test@example.com"], { cwd: tmp });
	await execReal("git", ["commit", "--allow-empty", "-m", "init"], { cwd: tmp });

	const { pi, ctx, rt } = await newMission(tmp);
	assert.equal(rt.active!.state.phase, "do");

	// 第 1 次 SUBMIT(带自动计算的 treeFp)
	const sub1 = await rt.applyEvent({ type: "SUBMIT", at: Date.now() }, ctx);
	assert.ok(!sub1.error);
	assert.equal(rt.active!.state.phase, "check");
	const tree1 = rt.active!.state.tasks.T1.submittedTreeFp;
	assert.ok(tree1 && tree1.startsWith("sha256:"));

	// 收到 evidence 类 inconclusive 判决
	await rt.applyEvent(
		{
			type: "VERDICT",
			at: Date.now(),
			verdict: {
				outcome: "inconclusive",
				inconclusiveCause: "evidence",
				missingAcIds: ["AC1"],
				failing: [],
				reason: "缺少验收证据:AC1",
			},
		},
		ctx,
	);
	assert.equal(rt.active!.state.phase, "do");
	assert.ok(rt.active!.state.tasks.T1.awaitingEvidence);
	assert.equal(rt.active!.state.tasks.T1.awaitingEvidence?.treeFp, tree1);

	// State Card 与 DO brief 渲染提示
	const card = renderStateCard(rt.active!.plan, rt.active!.state);
	assert.ok(card.includes("AWAITING EVIDENCE"));
	const brief = renderDoBrief(rt.active!.plan, rt.active!.state);
	assert.ok(brief.includes("回到 DO:T1") && brief.includes("缺少验收证据:AC1") && brief.includes("补证据闸门"));
	assert.ok(ctx.notifications.some((m) => m.includes("无法判定") && m.includes("缺少验收证据:AC1")));

	// 未改动工作区原样重交 → 被拦截
	const sub2 = await rt.applyEvent({ type: "SUBMIT", at: Date.now() }, ctx);
	assert.ok(sub2.error);
	assert.match(sub2.error!, /未检测到任何改动/);
	assert.equal(rt.active!.state.phase, "do");

	// 真实修改工作区文件
	fs.writeFileSync(path.join(tmp, "hello.txt"), "hello world\n");

	// 再次提交 → 指纹变化,放行进 check,awaitingEvidence 复位
	const sub3 = await rt.applyEvent({ type: "SUBMIT", at: Date.now() }, ctx);
	assert.ok(!sub3.error);
	assert.equal(rt.active!.state.phase, "check");
	assert.equal(rt.active!.state.tasks.T1.awaitingEvidence, null);
	assert.notEqual(rt.active!.state.tasks.T1.submittedTreeFp, tree1);
});
// ─────────────────────────── quick 的三种裁判 ───────────────────────────

test("quick 人工终审:人点通过 → done,证据是 human 级且标记为不可重放", async () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-missions-smoke-"));
	const pi = mockPi();
	const ctx = mockCtx(tmp, { select: "通过" });
	const rt = new Runtime(pi, tmp);

	const r = await rt.startQuick(ctx, "把导航栏在窄屏改成汉堡菜单", {
		judge: "human",
		text: "窄屏折叠成汉堡,宽屏不变",
	});
	assert.ok("id" in r, JSON.stringify(r));
	assert.equal(r.tier, "quick", "写不出 shell 断言不该被挡去 standard");
	assert.equal(rt.active!.state.phase, "do");

	await rt.applyEvent({ type: "SUBMIT", at: Date.now() }, ctx);
	await rt.runCheck(ctx);

	assert.equal(rt.active!.state.phase, "done");
	assert.ok(
		ctx.prompts.some((p) => p.includes("窄屏折叠成汉堡")),
		"必须把冻结的判据摆在人面前再问,而不是只问一句'过不过'",
	);
});

test("quick 人工终审:人说不通过 → 回 ACT,理由进证据", async () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-missions-smoke-"));
	const pi = mockPi();
	const ctx = mockCtx(tmp, { select: "不通过", input: "汉堡点开只有 3 个链接" });
	const rt = new Runtime(pi, tmp);

	await rt.startQuick(ctx, "改导航栏", { judge: "human", text: "窄屏折叠成汉堡" });
	await rt.applyEvent({ type: "SUBMIT", at: Date.now() }, ctx);
	await rt.runCheck(ctx);

	assert.equal(rt.active!.state.phase, "act", "人说不行就是 fail,和命令判失败同权");
	const task = rt.active!.state.tasks.T1;
	assert.ok(task.lastSignature, "人工 fail 也要有签名,否则熔断记不上账");
	// 人打的那句话是这一轮唯一的信息源:ACT 相位只有只读工具,escalator 无法自己重现
	assert.ok(
		task.lastFailureReason?.includes("汉堡点开只有 3 个链接"),
		`人补充的原因必须进 State Card / ACT 简报,实际是:${task.lastFailureReason}`,
	);
});

test("quick 人工终审:人取消不算通过(没做选择 ≠ 放行)", async () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-missions-smoke-"));
	const pi = mockPi();
	// select 返回 undefined = 人按了 Esc
	const ctx = mockCtx(tmp, { select: "\u0000没有这个选项" });
	const rt = new Runtime(pi, tmp);

	await rt.startQuick(ctx, "改导航栏", { judge: "human", text: "窄屏折叠成汉堡" });
	await rt.applyEvent({ type: "SUBMIT", at: Date.now() }, ctx);
	await rt.runCheck(ctx);

	assert.notEqual(rt.active!.state.phase, "done", "取消绝不能被当成通过");
});

test("quick 第一次没过、走真实驱动 onAgentSettled:升档落在 PLAN,不是留在 DO 空转", async () => {
	// 这条必须走 onAgentSettled 而不是手动发 ADJUST_DONE —— 生产里的驱动是它,
	// 而 bug 恰好只在它那条路上:ADJUST_DONE 之后紧接着 evaluatePromotion 发
	// PROMOTE_TIER,当时那个 case 只改 tier 不改相位,于是留下
	// tier=standard / phase=do / acceptanceCriteria 为空的 mission。
	// runCheck 按 state.tier 分流:档位一变就不看那条冻结判据了,转去跑空的
	// verify.sh,采不到证据判 inconclusive,回 DO 再来,三次之后停机 ——
	// 人工终审的判据从此再没被问过。手动发 ADJUST_DONE 的老测试测不出这条。
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-missions-smoke-"));
	const pi = mockPi();
	const ctx = mockCtx(tmp, { select: "不通过", input: "CSP 报错,脚本加载不了" });
	const rt = new Runtime(pi, tmp);

	await rt.startQuick(ctx, "调整小组件在卡片里的排布", {
		judge: "human",
		text: "大档卡片里预览完整可见,不出现内容溢出",
	});

	await rt.applyEvent({ type: "SUBMIT", at: Date.now() }, ctx);
	await rt.runCheck(ctx);
	assert.equal(rt.active!.state.phase, "act", "人说不行 → 先进 ACT 诊断一轮");

	// ★ 真实驱动:ACT 那一轮结束
	await rt.onAgentSettled(ctx);

	assert.equal(rt.active!.state.tier, "standard");
	assert.equal(rt.active!.state.phase, "plan", "升档要回 PLAN 把判据摊开成 AC + verify.sh");
	assert.ok(rt.active!.state.pendingHandoff, "换脑必须挂起");
	assert.equal(rt.active!.inMemory, false, "换脑靠磁盘重附着,升档那一刻必须已落盘");

	// 挂着换脑就不该再发"进入 DO"的简报 —— 那是在骗下一个会话
	assert.ok(
		!pi.calls.followUps.some((m) => m.includes("进入 DO")),
		`升档挂换脑之后不能再发 DO 简报:\n${pi.calls.followUps.join("\n---\n")}`,
	);

	// 升档后 PLAN 相位给的是 mission_write_plan,不再是 quick 的 mission_criterion
	const tools = pi.calls.activeTools.at(-1)!;
	assert.ok(tools.includes("mission_write_plan"), tools.join(","));
	assert.ok(!tools.includes("mission_criterion"), tools.join(","));

	// 卡在 PLAN 就不能再提交 —— 原来的 bug 是它留在 DO,可以一直 submit 空转
	const again = await rt.applyEvent({ type: "SUBMIT", at: Date.now() }, ctx);
	assert.ok(again.error, "PLAN 相位不接受 SUBMIT");

	fs.rmSync(tmp, { recursive: true, force: true });
});

test("quick 人工连判两次不行:升档 standard 并落盘,失败历史不再随换脑蒸发", async () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-missions-smoke-"));
	const pi = mockPi();
	const ctx = mockCtx(tmp, { select: "不通过", input: "CSP 报错,脚本加载不了" });
	const rt = new Runtime(pi, tmp);

	await rt.startQuick(ctx, "调整小组件在卡片里的排布", {
		judge: "human",
		text: "大档卡片里预览完整可见,不出现内容溢出",
	});
	assert.equal(rt.active!.inMemory, true, "quick 起步不落盘");

	// 第 1 次:人说不行 → ACT → 回 DO
	await rt.applyEvent({ type: "SUBMIT", at: Date.now() }, ctx);
	await rt.runCheck(ctx);
	assert.equal(rt.active!.state.phase, "act");
	await rt.applyEvent({ type: "ADJUST_DONE", at: Date.now() }, ctx);
	assert.equal(rt.active!.state.tier, "quick");

	// 第 2 次:人再说不行 → 同签名撞阈值 → 升档而不是 L2
	await rt.applyEvent({ type: "SUBMIT", at: Date.now() }, ctx);
	await rt.runCheck(ctx);

	assert.equal(rt.active!.state.tier, "standard", "quick 的出口是升档,不是回 PLAN 改判据");
	assert.equal(rt.active!.state.phase, "plan");
	assert.equal(rt.active!.state.escalation.level, 1, "升档不是升级:阶梯没动,判定标准是往严了走");
	assert.equal(rt.active!.inMemory, false, "必须落盘 —— 换脑靠磁盘重附着");

	// 换脑之后新会话唯一能读到的东西:LOG 必须已经写下了失败原因
	const log = fs.readFileSync(
		path.join(tmp, "missions/state", rt.active!.state.missionId, "LOG.md"),
		"utf8",
	);
	assert.ok(log.includes("PROMOTE"), log);
	assert.ok(log.includes("CSP 报错"), `失败原因必须落盘,否则换脑那一刻就没了:\n${log}`);

	// 升档后的 PLAN 相位给的是 mission_write_plan(不再是 quick 的 mission_criterion)
	const tools = pi.calls.activeTools.at(-1)!;
	assert.ok(tools.includes("mission_write_plan"), tools.join(","));
	assert.ok(!tools.includes("mission_criterion"), "已经不是 quick 了,别再让它改判据");
});

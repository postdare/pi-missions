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
import { Runtime } from "../src/runtime.ts";

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

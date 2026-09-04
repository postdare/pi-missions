import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseArgs, registerCommands, statusViewOpts } from "../src/commands.ts";
import { initialState } from "../src/core/machine.ts";
import { layout } from "../src/store/paths.ts";
import { MissionRepository } from "../src/store/repository.ts";

test("statusViewOpts:恢复只给 halted/挂起/未附着,中止只给附着中的活动 mission", () => {
	const rt = {
		active: { state: { missionId: "m-live" } },
		checkStateFor: () => null,
		steerVerifier: async () => ({ ok: true }),
	};
	const sent: Array<{ message: string; options?: { expandPromptTemplates?: boolean } }> = [];
	const pi = {
		sendUserMessage: (message: string, options?: { expandPromptTemplates?: boolean }) => {
			sent.push({ message, options });
		},
	};
	const ctx = { ui: { notify: () => {} } };
	const opts = statusViewOpts(pi, ctx, rt as any, "m-live");
	const dataFor = (missionId: string, phase: string, pendingHandoff: string | null = null) =>
		({ state: { missionId, phase, pendingHandoff } }) as any;

	assert.equal(opts.canResume(dataFor("m-live", "check")), false, "本会话正在跑的 mission 没有恢复入口");
	assert.equal(opts.canResume(dataFor("m-live", "do")), false);
	assert.equal(opts.canResume(dataFor("m-live", "halted")), true, "被 halt 的可以恢复");
	assert.equal(opts.canResume(dataFor("m-live", "plan", "换脑")), true, "换脑挂起的可以恢复");
	assert.equal(opts.canResume(dataFor("m-other", "do")), true, "未附着 = 中断的,可以恢复");
	assert.equal(opts.canResume(dataFor("m-other", "done")), false, "done 永远不可恢复");

	assert.equal(opts.canAbort(dataFor("m-live", "check")), true, "中止作用于附着中的活动 mission");
	assert.equal(opts.canAbort(dataFor("m-other", "do")), false, "别把中止留给别的 mission");
	assert.equal(opts.canAbort(dataFor("m-live", "done")), false);
	assert.equal(opts.canAbort(dataFor("m-live", "halted")), false);

	// 面板/状态页的恢复与中止必须分发成 slash 命令,而不是当提示词发给 LLM
	opts.onResume("m-other");
	opts.onAbort();
	assert.deepEqual(sent.map((s) => s.message), ["/mission resume m-other", "/mission abort"]);
	assert.ok(
		sent.every((s) => s.options?.expandPromptTemplates === true),
		"slash 命令文本必须带 expandPromptTemplates,否则会被当成普通用户消息发给 LLM",
	);
});


test("/mission verify 后台启动 CHECK 并立即返回", async () => {
	const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
	let finishCheck!: () => void;
	const pendingCheck = new Promise<void>((resolve) => {
		finishCheck = resolve;
	});
	let checkStarted = false;
	const runtime = {
		active: { state: { phase: "do" } },
		ensureAttached: async () => true,
		applyEvent: async () => ({ error: undefined }),
		startCheck: () => {
			checkStarted = true;
			return pendingCheck;
		},
	};
	const pi = {
		registerCommand: (name: string, command: { handler: (args: string, ctx: any) => Promise<void> }) => {
			commands.set(name, command);
		},
	};
	registerCommands(pi, () => runtime as any);
	const handler = commands.get("mission")!.handler;
	const ctx = { mode: "tui", ui: { notify: () => {} } };

	await handler("verify", ctx);

	assert.equal(checkStarted, true);
	let completed = false;
	pendingCheck.then(() => {
		completed = true;
	});
	await Promise.resolve();
	assert.equal(completed, false, "命令返回时后台 CHECK 仍在执行");
	finishCheck();
	await pendingCheck;
});

test("/mission status:从 v2 snapshot 展示冻结前 mission", async () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-missions-commands-"));
	const missionId = "2026-09-01-mission-orphan";
	const repoLayout = layout(tmp, "missions");
	const state = initialState({ missionId, tier: "standard", taskOrder: [] });
	const repository = new MissionRepository(repoLayout);
	repository.create(
		{
			missionId,
			tier: "standard",
			goal: "验证 v2 状态读取",
			acceptanceCriteria: [],
			milestones: [],
			verifyScript: "",
			createdAt: Date.now(),
		},
		state,
	);

	const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
	const entries: Array<{ type: string; data: { title: string; body: string } }> = [];
	const notifications: string[] = [];
	const pi = {
		registerCommand: (name: string, command: { handler: (args: string, ctx: any) => Promise<void> }) => {
			commands.set(name, command);
		},
		appendEntry: (type: string, data: { title: string; body: string }) => entries.push({ type, data }),
	};
	const runtime = {
		active: null,
		config: { missionsDir: "missions" },
		layout: repoLayout,
		repository,
		checkStateFor: () => null,
	};
	registerCommands(pi, () => runtime as any);

	await commands.get("mission")!.handler(`status ${missionId}`, {
		mode: "tui",
		hasUI: false,
		ui: { notify: (message: string) => notifications.push(message) },
	});

	assert.equal(notifications.length, 0);
	assert.equal(entries.length, 1);
	assert.match(entries[0]!.data.body, /验证 v2 状态读取/);
});

// 全部文档教的都是 /mission new "目标"。剥不掉的话,那对引号会跟着 goal
// 走完全程:MISSION.md、计划评审页、State Card、常驻卡、喂给模型的开场白。
test("parseArgs:整段被引号包住时剥掉一层 —— 文档教的就是这个写法", () => {
	const cases: Array<[string, string]> = [
		['new "把登录鉴权从 session 迁移到 JWT"', "把登录鉴权从 session 迁移到 JWT"],
		["new '把登录鉴权从 session 迁移到 JWT'", "把登录鉴权从 session 迁移到 JWT"],
		["new \u201c从文档里粘出来的弯引号\u201d", "从文档里粘出来的弯引号"],
		["new 不加引号也一样", "不加引号也一样"],
	];
	for (const [input, goal] of cases) {
		assert.equal(parseArgs(input).rest, goal, input);
	}
});

test("parseArgs:正文里的引号不动 —— 剥掉会改变意思", () => {
	assert.equal(parseArgs('new 他说 "算了" 就走了').rest, '他说 "算了" 就走了');
	assert.equal(parseArgs('new "先做 A" 再做 "B"').rest, '"先做 A" 再做 "B"');
	assert.equal(parseArgs('new 只有右边有引号"').rest, '只有右边有引号"');
});

test("parseArgs:剥引号不影响 flag 解析", () => {
	const r = parseArgs('new "重构鉴权" --tier=complex');
	assert.equal(r.sub, "new");
	assert.equal(r.rest, "重构鉴权");
	assert.equal(r.flags.tier, "complex");
});

// 目标文本里出现 --xxx 时不该被当成开关吃掉(BOOL_FLAGS 白名单的理由)
test("parseArgs:非白名单的 --xxx 留在目标正文里", () => {
	assert.equal(parseArgs("new 重构 --legacy 模块").rest, "重构 --legacy 模块");
});

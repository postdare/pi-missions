import { test } from "node:test";
import assert from "node:assert/strict";
import {
	renderVerifierBrief,
	runVerifier,
	VERIFIER_TOOLS,
	type VerifierControl,
	type VerifierProgress,
} from "../src/roles/verifier.ts";

const options = {
	cwd: "/tmp",
	model: { provider: "test", id: "verifier" },
	thinkingLevel: "off",
	brief: "verify",
	timeoutMs: 1000,
	envFingerprint: "fp",
	expectedAcIds: ["AC1"],
};

function submitVerdicts(verdicts: unknown) {
	return async ({ onVerdict }: { onVerdict(value: unknown): void }) => ({
		subscribe: () => () => {},
		prompt: async () => onVerdict(verdicts),
		steer: async () => {},
		abort: async () => {},
		dispose: () => {},
	});
}

test("runVerifier:工具白名单只有只读工具与 mission_verdict", () => {
	// I3 的独立性靠这行白名单:能写文件/能跑 bash,验证者就会变成执行者
	for (const banned of ["bash", "edit", "write"]) {
		assert.ok(!(VERIFIER_TOOLS as readonly string[]).includes(banned), `白名单不应包含 ${banned}`);
	}
	for (const allowed of ["read", "grep", "find", "ls", "mission_verdict"]) {
		assert.ok((VERIFIER_TOOLS as readonly string[]).includes(allowed), `白名单应包含 ${allowed}`);
	}
});

test("runVerifier:会话初始化失败与无效 verdict 都归为 failed,且干净收尾", async () => {
	// 初始化失败(认证/模型不可用等)—— 不抛出,返回 failed 让 Runtime 降级 hard-only
	const initFailure = await runVerifier(options, async () => {
		throw new Error("auth unavailable");
	});
	assert.equal(initFailure.status, "failed");
	if (initFailure.status === "failed") assert.match(initFailure.message, /auth unavailable/);

	// verdict 载荷不合法(缺 acId / 结果不在枚举内)→ 视为未提交,绝不能当成 pass
	const invalid = await runVerifier(options, async ({ onVerdict }) => ({
		subscribe: () => () => {},
		prompt: async () => {
			onVerdict([{ acId: "", result: "pass", rationale: "空 acId" }]);
			onVerdict([{ acId: "AC1", result: "maybe", rationale: "枚举外结果" }]);
		},
		steer: async () => {},
		abort: async () => {},
		dispose: () => {},
	}));
	assert.equal(invalid.status, "failed");
	if (invalid.status === "failed") assert.match(invalid.message, /结构无效/);
});

test("runVerifier:工具执行失败也进进度轨迹", async () => {
	const progress: VerifierProgress[] = [];
	await runVerifier({ ...options, onProgress: (p) => progress.push(p) }, async ({ onVerdict }) => {
		let listener: ((event: any) => void) | null = null;
		return {
			subscribe: (fn) => {
				listener = fn;
				return () => {};
			},
			prompt: async () => {
				listener?.({ type: "tool_execution_start", toolCallId: "1", toolName: "grep", args: { pattern: "x" } });
				listener?.({ type: "tool_execution_end", toolCallId: "1", toolName: "grep", isError: true });
				onVerdict([{ acId: "AC1", result: "inconclusive", rationale: "证据不足" }]);
			},
			steer: async () => {},
			abort: async () => {},
			dispose: () => {},
		};
	});
	assert.ok(progress.some((p) => p.activity.includes("grep 执行失败")));
});

test("runVerifier:verdict 必须与预期 AC 集合精确一致", async () => {
	const unknown = await runVerifier(options, submitVerdicts([{ acId: "AC2", result: "pass", rationale: "x" }]));
	assert.equal(unknown.status, "failed");
	if (unknown.status === "failed") assert.match(unknown.message, /未知 AC:AC2/);

	const duplicate = await runVerifier(
		options,
		submitVerdicts([
			{ acId: "AC1", result: "pass", rationale: "x" },
			{ acId: "AC1", result: "pass", rationale: "y" },
		]),
	);
	assert.equal(duplicate.status, "failed");
	if (duplicate.status === "failed") assert.match(duplicate.message, /重复提交 AC:AC1/);

	const missing = await runVerifier(
		{ ...options, expectedAcIds: ["AC1", "AC2"] },
		submitVerdicts([{ acId: "AC1", result: "pass", rationale: "x" }]),
	);
	assert.equal(missing.status, "failed");
	if (missing.status === "failed") assert.match(missing.message, /漏交 AC:AC2/);
});

test("runVerifier:外部 abort 打断进行中的会话并释放控制句柄", async () => {
	let control: VerifierControl | null = null;
	const running = runVerifier(
		{
			...options,
			onControl: (next) => {
				control = next;
			},
		},
		async () => {
			let abortPrompt!: () => void;
			return {
				subscribe: () => () => {},
				prompt: () =>
					new Promise<void>((resolve) => {
						abortPrompt = resolve;
					}),
				steer: async () => {},
				abort: async () => {
					abortPrompt();
				},
				dispose: () => {},
			};
		},
	);
	while (!control) await new Promise((resolve) => setTimeout(resolve, 0));
	await control!.abort();
	const result = await running;
	// abort 后 prompt 返回但没提交 verdict → failed,由 Runtime 统一走 hard-only 降级
	assert.equal(result.status, "failed");
	assert.equal(control, null, "abort 后清除控制句柄");
});

test("runVerifier:AgentSession verdict 转为结构化 evidence 并统计进度", async () => {
	let disposed = false;
	const progress: VerifierProgress[] = [];
	const result = await runVerifier(
		{ ...options, onProgress: (p) => progress.push(p) },
		async ({ onVerdict }) => {
			let listener: ((event: any) => void) | null = null;
			return {
				subscribe: (fn) => {
					listener = fn;
					return () => {
						listener = null;
					};
				},
				prompt: async () => {
					listener?.({ type: "tool_execution_start", toolCallId: "1", toolName: "read", args: { path: "src/a.ts" } });
					onVerdict([{ acId: "AC1", result: "pass", rationale: "符合要求" }]);
					listener?.({
						type: "message_end",
						message: {
							role: "assistant",
							content: [],
							usage: {
								input: 100,
								output: 20,
								cacheRead: 10,
								cacheWrite: 0,
								cost: { total: 0.01 },
							},
						},
					});
				},
				steer: async () => {},
				abort: async () => {},
				dispose: () => {
					disposed = true;
				},
			};
		},
	);

	assert.equal(result.status, "completed");
	assert.equal(disposed, true);
	assert.ok(progress.some((p) => p.activity.includes("读取 src/a.ts")));
	if (result.status === "completed") {
		assert.equal(result.evidences[0].acId, "AC1");
		assert.equal(result.evidences[0].raw, "符合要求");
		assert.equal(result.usage.turns, 1);
		assert.equal(result.usage.toolCalls, 1);
		assert.equal(result.usage.cost, 0.01);
	}
});

test("runVerifier:区分超时与未提交 verdict,并始终清理 session", async () => {
	let finishPrompt!: () => void;
	let aborted = false;
	let disposed = false;
	const timeout = await runVerifier(
		{ ...options, timeoutMs: 5 },
		async () => ({
			subscribe: () => () => {},
			prompt: () =>
				new Promise<void>((resolve) => {
					finishPrompt = resolve;
				}),
			steer: async () => {},
			abort: async () => {
				aborted = true;
				finishPrompt();
			},
			dispose: () => {
				disposed = true;
			},
		}),
	);
	assert.equal(timeout.status, "timeout");
	assert.equal(aborted, true);
	assert.equal(disposed, true);

	const failed = await runVerifier(
		options,
		async () => ({
			subscribe: () => () => {},
			prompt: async () => {},
			steer: async () => {},
			abort: async () => {},
			dispose: () => {},
		}),
	);
	assert.equal(failed.status, "failed");
	if (failed.status === "failed") assert.match(failed.message, /未提交 verdict/);
});

test("runVerifier:暴露 steer/abort 控制并记录人工指令", async () => {
	let control: VerifierControl | null = null;
	let finishPrompt!: () => void;
	const steers: string[] = [];
	const progress: VerifierProgress[] = [];
	const running = runVerifier(
		{
			...options,
			onProgress: (p) => progress.push(p),
			onControl: (next) => {
				control = next;
			},
		},
		async ({ onVerdict }) => ({
			subscribe: () => () => {},
			prompt: () =>
				new Promise<void>((resolve) => {
					finishPrompt = resolve;
				}),
			steer: async (message) => {
				steers.push(message);
				onVerdict([{ acId: "AC1", result: "pass", rationale: "steer 后确认" }]);
				finishPrompt();
			},
			abort: async () => {
				finishPrompt();
			},
			dispose: () => {},
		}),
	);
	while (!control) await new Promise((resolve) => setTimeout(resolve, 0));
	await control.steer("重点检查边界条件");
	const result = await running;

	assert.deepEqual(steers, ["重点检查边界条件"]);
	assert.equal(result.status, "completed");
	assert.ok(progress.some((p) => p.activity.includes("人工 steer")));
	assert.equal(control, null, "完成后清除控制句柄");
});

// ─────────────── 简报与校验必须同一个 id 命名空间 ───────────────
//
// 真实事故(new-tab 仓库,2026-09-02):简报列的是计划里的 AC1..AC5,
// expectedAcIds 是 verify 分支名 copy/edit/small/drag/regression。
// 验证者交了 "AC3" → validateVerdicts 抛「提交了未知 AC」→ 整份核验丢弃 →
// 降级 hard-only → 三个任务全 PASS,mission done。
// semi 层从未生效,而 LOG 里只有一行 "verifier AgentSession unavailable"。

const AC_PLAN = [
	{ id: "AC1", text: "复制为 markdown 任务列表", verify: "copy" },
	{ id: "AC2", text: "行内编辑支持 Enter 提交", verify: "edit" },
	{ id: "AC3", text: "small 档形态不变", verify: "small" },
	{ id: "AC5", text: "yarn lint 与 yarn build 通过", verify: "regression" },
];

const brief = (expectedAcIds: string[]) =>
	renderVerifierBrief({
		goal: "todo 支持行内编辑与复制",
		taskId: "T3",
		taskTitle: "small 档与回归",
		acceptanceCriteria: AC_PLAN,
		expectedAcIds,
		hardResults: [],
		diff: "",
	});

test("简报里要提交的 id 就是 expectedAcIds,不是计划里的 AC 编号", () => {
	const text = brief(["small", "regression"]);
	assert.ok(text.includes("- small"), "列表项以 verify 分支名开头");
	assert.ok(text.includes("- regression"));
	assert.ok(!/^- AC\d/m.test(text), "绝不能把 AC3 这种计划编号当成要提交的 id");
});

test("简报只列本轮范围内的判据 —— 多列出来会导致'提交了未知 AC'", () => {
	const text = brief(["small", "regression"]);
	assert.ok(!text.includes("复制为 markdown"), "不该出现别的任务的 AC 正文");
	assert.ok(!text.includes("行内编辑支持 Enter"));
	assert.ok(text.includes("small 档形态不变"));
});

test("简报明确告知本轮要交几条、分别是什么", () => {
	const text = brief(["small", "regression"]);
	assert.ok(text.includes("本轮共 2 条"), text.slice(0, 400));
	assert.ok(text.includes("small、regression"));
});

test("计划里查不到正文也照样列出该 id —— 宁可正文缺失,也不能让 id 集合对不上", () => {
	const text = brief(["small", "brand-new-branch"]);
	assert.ok(text.includes("- brand-new-branch"));
	assert.ok(text.includes("计划中没有对应正文"));
});

test("一个分支被多条 AC 覆盖时,正文合并,id 仍只有一个", () => {
	const text = renderVerifierBrief({
		goal: "g",
		taskId: "T1",
		taskTitle: "t",
		acceptanceCriteria: [
			{ id: "AC1", text: "第一条要求", verify: "copy" },
			{ id: "AC2", text: "第二条要求", verify: "copy" },
		],
		expectedAcIds: ["copy"],
		hardResults: [],
		diff: "",
	});
	assert.ok(text.includes("第一条要求 / 第二条要求"));
	assert.equal((text.match(/^- copy/gm) ?? []).length, 1);
});

// ─────────────── provider 报错(真实事故:400 伪装成"没提交 verdict") ───────────────

/** provider 拒绝这一轮:pi 不抛异常,只发一条 stopReason=error 的空 assistant 消息 */
function providerRejects(errorMessage: string) {
	return async () => {
		let listener: ((event: any) => void) | null = null;
		return {
			subscribe: (fn: (event: any) => void) => {
				listener = fn;
				return () => {};
			},
			prompt: async () => {
				listener?.({
					type: "message_end",
					message: { role: "assistant", content: [], stopReason: "error", errorMessage },
				});
			},
			steer: async () => {},
			abort: async () => {},
			dispose: () => {},
		};
	};
}

test("runVerifier:provider 报错的原文必须进 message —— 报'未提交 verdict'是报后果不是报原因", async () => {
	const r = await runVerifier(
		{ ...options, thinkingLevel: "medium" },
		providerRejects('400 invalid_request_error: model xyz is not available'),
	);
	assert.equal(r.status, "failed");
	if (r.status === "failed") {
		assert.match(r.message, /400 invalid_request_error/);
		assert.match(r.message, /not available/);
	}
});

test("runVerifier:模型强制开思考时,thinking=off 自动降档重试一次", async () => {
	const levels: string[] = [];
	const r = await runVerifier(options, async (input) => {
		levels.push(input.options.thinkingLevel);
		if (input.options.thinkingLevel === "off") {
			return providerRejects('400 (glm-5.3-flash always reasons; thinking.type must be "enabled")')();
		}
		return submitVerdicts([{ acId: "AC1", result: "pass", rationale: "ok" }])(input);
	});
	assert.deepEqual(levels, ["off", "low"]);
	assert.equal(r.status, "completed");
	assert.ok(r.trace.some((line) => line.includes("thinking=off 被 provider 拒绝")));
});

test("runVerifier:与 thinking 无关的 provider 报错不重试 —— 重试只是白烧一遍钱", async () => {
	const levels: string[] = [];
	const r = await runVerifier(options, async (input) => {
		levels.push(input.options.thinkingLevel);
		return providerRejects("429 rate limit exceeded")();
	});
	assert.deepEqual(levels, ["off"]);
	assert.equal(r.status, "failed");
	if (r.status === "failed") assert.match(r.message, /429/);
});

test("runVerifier:降档重试后仍失败时,两轮的 usage 都要记账", async () => {
	const usageEvent = (output: number) => ({
		type: "message_end",
		message: { role: "assistant", content: [], usage: { input: 10, output } },
	});
	const r = await runVerifier(options, async (input) => {
		let listener: ((event: any) => void) | null = null;
		return {
			subscribe: (fn: (event: any) => void) => {
				listener = fn;
				return () => {};
			},
			prompt: async () => {
				listener?.(usageEvent(input.options.thinkingLevel === "off" ? 5 : 7));
				listener?.({
					type: "message_end",
					message: {
						role: "assistant",
						content: [],
						stopReason: "error",
						errorMessage: 'thinking.type must be "enabled"',
					},
				});
			},
			steer: async () => {},
			abort: async () => {},
			dispose: () => {},
		};
	});
	assert.equal(r.status, "failed");
	assert.equal(r.usage.input, 20);
	assert.equal(r.usage.output, 12);
});

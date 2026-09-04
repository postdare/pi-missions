import { test } from "node:test";
import assert from "node:assert/strict";
import {
	runVerifier,
	VERIFIER_TOOLS,
	type VerifierControl,
	type VerifierProgress,
	type VerifierSubject,
} from "../src/roles/verifier.ts";

function frozenSubject(verifyBranches: readonly string[] = ["AC1"]): Extract<VerifierSubject, { kind: "frozen-ac" }> {
	return {
		kind: "frozen-ac",
		goal: "verify",
		task: { id: "T1", title: "核验任务" },
		verifyBranches,
		acceptanceCriteria: verifyBranches.map((verify, index) => ({
			id: `PLAN-${index + 1}`,
			text: `${verify} 的验收正文`,
			verify,
		})),
		hardResults: [],
		changes: { diff: "", files: [] },
	};
}

const options = {
	cwd: "/tmp",
	model: { provider: "test", id: "verifier" },
	thinkingLevel: "off",
	subject: frozenSubject(),
	budget: { idleMs: 1000, ceilingMs: 10_000 },
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
		{ ...options, subject: frozenSubject(["AC1", "AC2"]) },
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
		{ ...options, budget: { idleMs: 5, ceilingMs: 50 } },
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
// 校验集合却是 verify 分支名 copy/edit/small/drag/regression。
// 验证者交了 "AC3" → validateVerdicts 抛「提交了未知 AC」→ 整份核验丢弃 →
// 降级 hard-only → 三个任务全 PASS,mission done。
// semi 层从未生效,而 LOG 里只有一行 "verifier AgentSession unavailable"。

const AC_PLAN = [
	{ id: "AC1", text: "复制为 markdown 任务列表", verify: "copy" },
	{ id: "AC2", text: "行内编辑支持 Enter 提交", verify: "edit" },
	{ id: "AC3", text: "small 档形态不变", verify: "small" },
	{ id: "AC5", text: "yarn lint 与 yarn build 通过", verify: "regression" },
];

function planSubject(verifyBranches: readonly string[]): VerifierSubject {
	return {
		kind: "frozen-ac",
		goal: "todo 支持行内编辑与复制",
		task: { id: "T3", title: "small 档与回归" },
		verifyBranches,
		acceptanceCriteria: AC_PLAN,
		hardResults: [],
		changes: { diff: "", files: [] },
	};
}

function idsFromFrozenPrompt(prompt: string): string[] {
	const criteria = prompt.match(/# 冻结的验收标准\(逐条核对\)\n([\s\S]*?)\n\n提交 mission_verdict/)?.[1] ?? "";
	return criteria.split("\n").flatMap((line) => {
		const match = line.match(/^- ([^\s:]+)(?: \(计划里的 [^)]+\))?:/);
		return match ? [match[1]] : [];
	});
}

async function exerciseSubject(
	subject: VerifierSubject,
	verdictsFromPrompt: (prompt: string) => unknown = (prompt) =>
		idsFromFrozenPrompt(prompt).map((acId) => ({ acId, result: "pass", rationale: `已核对 ${acId}` })),
) {
	let captured = "";
	const result = await runVerifier({ ...options, subject }, async ({ onVerdict }) => ({
		subscribe: () => () => {},
		prompt: async (prompt) => {
			captured = prompt;
			onVerdict(verdictsFromPrompt(prompt));
		},
		steer: async () => {},
		abort: async () => {},
		dispose: () => {},
	}));
	return { prompt: captured, result };
}

test("runVerifier interface:prompt 的 verify 分支原样成为最终 evidence 身份", async () => {
	// fake 只从真实 prompt 读身份再原样提交;测试没有第二份 expectedAcIds。
	const { prompt, result } = await exerciseSubject(planSubject(["small", "regression"]));
	assert.deepEqual(idsFromFrozenPrompt(prompt), ["small", "regression"]);
	assert.ok(!/^- AC\d/m.test(prompt), "计划 AC 编号绝不能成为提交身份");
	assert.match(prompt, /本轮共 2 条:small、regression/);
	assert.equal(result.status, "completed");
	if (result.status === "completed") {
		assert.deepEqual(result.evidences.map((e) => e.acId), ["small", "regression"]);
	}
});

test("runVerifier interface:prompt 只合并本轮分支正文,缺正文也保留身份", async () => {
	const merged: VerifierSubject = {
		kind: "frozen-ac",
		goal: "g",
		task: { id: "T1", title: "t" },
		verifyBranches: ["copy", "brand-new-branch"],
		acceptanceCriteria: [
			...AC_PLAN,
			{ id: "AC6", text: "复制后保留层级", verify: "copy" },
		],
		hardResults: [],
		changes: { diff: "", files: [] },
	};
	const { prompt } = await exerciseSubject(merged);
	assert.match(prompt, /复制为 markdown 任务列表 \/ 复制后保留层级/);
	assert.equal((prompt.match(/^- copy/gm) ?? []).length, 1);
	assert.match(prompt, /- brand-new-branch: \(计划中没有对应正文/);
	assert.ok(!prompt.includes("行内编辑支持 Enter"), "不能混入本轮之外的正文");
});

test("runVerifier interface:frozen scope 输入无效时不创建 AgentSession", async () => {
	const hard = (acId: string) => ({ acId, pass: true, outputTail: "ok" });
	const cases: Array<{ subject: VerifierSubject; message: RegExp }> = [
		{ subject: frozenSubject([]), message: /verifyBranches 不能为空/ },
		{ subject: frozenSubject([""]), message: /含空分支/ },
		{ subject: frozenSubject([" copy"]), message: /首尾空格/ },
		{ subject: frozenSubject(["copy", "copy"]), message: /重复分支:copy/ },
		{
			subject: { ...frozenSubject(["copy"]), hardResults: [hard("other")] },
			message: /hardResults 身份越界:other/,
		},
		{
			subject: { ...frozenSubject(["copy"]), hardResults: [hard("copy"), hard("copy")] },
			message: /hardResults 身份重复:copy/,
		},
	];
	let sessions = 0;
	for (const entry of cases) {
		const result = await runVerifier({ ...options, subject: entry.subject }, async () => {
			sessions += 1;
			throw new Error("不应创建会话");
		});
		assert.equal(result.status, "failed");
		if (result.status === "failed") assert.match(result.message, entry.message);
		assert.deepEqual(result.usage, {
			turns: 0,
			toolCalls: 0,
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: 0,
		});
	}
	assert.equal(sessions, 0);
});

test("runVerifier interface:quick-ai 与 spike 身份固定且不能由调用者指定", async () => {
	const quick: VerifierSubject = {
		kind: "quick-ai",
		goal: "修复按钮",
		taskId: "quick-task",
		criterion: "点击后提示成功",
		changes: { diff: "+ fixed", files: ["src/button.ts"] },
	};
	const wrongQuick = await exerciseSubject(quick, () => [{ acId: "other", result: "pass", rationale: "x" }]);
	assert.match(wrongQuick.prompt, /- quick: 点击后提示成功/);
	assert.equal(wrongQuick.result.status, "failed");
	if (wrongQuick.result.status === "failed") assert.match(wrongQuick.result.message, /未知 AC:other/);
	const quickPass = await runVerifier(
		{ ...options, subject: quick },
		submitVerdicts([{ acId: "quick", result: "pass", rationale: "ok" }]),
	);
	assert.equal(quickPass.status, "completed");

	const spike: VerifierSubject = {
		kind: "spike",
		goal: "定位瓶颈",
		taskId: "S1",
		question: "瓶颈在哪一层?",
		report: "采样表明瓶颈在存储层。",
		diff: "",
	};
	const wrongSpike = await exerciseSubject(spike, () => [{ acId: "other", result: "pass", rationale: "x" }]);
	assert.match(wrongSpike.prompt, /acId 用 "spike"/);
	assert.equal(wrongSpike.result.status, "failed");
	if (wrongSpike.result.status === "failed") assert.match(wrongSpike.result.message, /未知 AC:other/);
	const spikePass = await runVerifier(
		{ ...options, subject: spike },
		submitVerdicts([{ acId: "spike", result: "pass", rationale: "ok" }]),
	);
	assert.equal(spikePass.status, "completed");
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
	const prompts: string[] = [];
	const r = await runVerifier(options, async (input) => {
		levels.push(input.options.thinkingLevel);
		let listener: ((event: any) => void) | null = null;
		return {
			subscribe: (fn: (event: any) => void) => {
				listener = fn;
				return () => {};
			},
			prompt: async (prompt: string) => {
				prompts.push(prompt);
				if (input.options.thinkingLevel === "off") {
					listener?.({
						type: "message_end",
						message: {
							role: "assistant",
							content: [],
							stopReason: "error",
							errorMessage: '400 (glm-5.3-flash always reasons; thinking.type must be "enabled")',
						},
					});
					return;
				}
				input.onVerdict([{ acId: "AC1", result: "pass", rationale: "ok" }]);
			},
			steer: async () => {},
			abort: async () => {},
			dispose: () => {},
		};
	});
	assert.deepEqual(levels, ["off", "low"]);
	assert.equal(prompts.length, 2);
	assert.equal(prompts[1], prompts[0], "thinking 重试必须复用同一份 compiled brief");
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

// diff 会被截断(DIFF_TAIL = 12000),文件清单不会 —— 这正是清单存在的理由。
// 真机上 diff 被截断的那一次,恰好是验证者调用最多、唯一超时的一次。
test("runVerifier interface:diff 截断时仍给完整文件清单与说明", async () => {
	const subject = frozenSubject(["ac1"]);
	subject.changes = {
		diff: "（此处 diff 已被截断）",
		files: ["新增 internal/schema/envelope.go", "修改 internal/storage/storage.go"],
	};
	const { prompt } = await exerciseSubject(subject);
	assert.match(prompt, /internal\/schema\/envelope\.go/);
	assert.match(prompt, /internal\/storage\/storage\.go/);
	assert.match(prompt, /完整清单/, "要让验证者知道这份清单可以直接照着读");
	assert.match(prompt, /可能因过长被截断/, "也要让它知道 diff 不可信,清单才可信");
});

test("runVerifier interface:没有文件改动时不留空段", async () => {
	const { prompt } = await exerciseSubject(frozenSubject(["ac1"]));
	assert.match(prompt, /git 报告没有文件改动/, "空清单要说出来,空标题会被读成'系统没查'");
});

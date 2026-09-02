/**
 * pi-missions · roles/verifier
 *
 * 进程内 Verifier Agent(I3 · 判定上下文外置)。
 * 使用 pi SDK 创建独立的 in-memory AgentSession,不继承 DO 对话,
 * 只开放只读工具与结构化 mission_verdict。
 */

import {
	createAgentSession,
	createExtensionRuntime,
	defineTool,
	type AgentSessionEvent,
	type ResourceLoader,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Evidence } from "../core/types.ts";

/** 只读工具白名单:没有 edit/write/bash,Verifier 无法修改工作区。导出供测试锁定。 */
export const VERIFIER_TOOLS = ["read", "grep", "find", "ls", "mission_verdict"] as const;
const VERDICT_RESULTS = new Set(["pass", "fail", "inconclusive"]);

export interface VerifierOptions {
	cwd: string;
	/** 已解析的实际模型。配置缺失或不可用时由 Runtime 传当前会话模型 */
	model: any;
	thinkingLevel: string;
	brief: string;
	timeoutMs: number;
	signal?: AbortSignal;
	envFingerprint: string;
	/** 本轮必须逐条提交且只能提交这些 AC */
	expectedAcIds: string[];
	onProgress?: (progress: VerifierProgress) => void;
	onControl?: (control: VerifierControl | null) => void;
}

export type VerifierRunResult =
	| { status: "completed"; evidences: Evidence[]; usage: VerifierUsage; trace: string[] }
	| { status: "timeout" | "failed"; evidences: null; message: string; usage: VerifierUsage; trace: string[] };

export interface VerifierUsage {
	turns: number;
	toolCalls: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

export interface VerifierProgress extends VerifierUsage {
	activity: string;
	trace: string[];
}

export interface VerifierControl {
	steer(message: string): Promise<void>;
	abort(): Promise<void>;
}

interface AgentSessionLike {
	subscribe(listener: (event: AgentSessionEvent) => void): () => void;
	prompt(text: string): Promise<void>;
	steer(text: string): Promise<void>;
	abort(): Promise<void>;
	dispose(): void;
}

interface CreateVerifierSessionInput {
	options: VerifierOptions;
	systemPrompt: string;
	onVerdict(verdicts: unknown): void;
}

type CreateVerifierSession = (input: CreateVerifierSessionInput) => Promise<AgentSessionLike>;

const ZERO_USAGE: VerifierUsage = {
	turns: 0,
	toolCalls: 0,
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	cost: 0,
};

function emptyResourceLoader(systemPrompt: string): ResourceLoader {
	return {
		getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => systemPrompt,
		getSystemPromptSource: () => undefined,
		getAppendSystemPrompt: () => [],
		getAppendSystemPromptSources: () => [],
		extendResources: () => {},
		reload: async () => {},
	};
}

const createSdkVerifierSession: CreateVerifierSession = async ({ options, systemPrompt, onVerdict }) => {
	const verdictTool = defineTool({
		name: "mission_verdict",
		label: "提交核验结论",
		description: "提交逐条 AC 的最终核验结论。每条必须包含 acId、result 和具体依据。",
		parameters: Type.Object({
			verdicts: Type.Array(
				Type.Object({
					acId: Type.String(),
					result: Type.Union([
						Type.Literal("pass"),
						Type.Literal("fail"),
						Type.Literal("inconclusive"),
					]),
					rationale: Type.String(),
				}),
			),
		}),
		async execute(_id, params) {
			onVerdict(params.verdicts);
			return { content: [{ type: "text", text: "核验结论已提交。" }], details: {} };
		},
	});
	const settingsManager = SettingsManager.inMemory({
		compaction: { enabled: false },
		retry: { enabled: true, maxRetries: 1 },
	});
	const { session } = await createAgentSession({
		cwd: options.cwd,
		model: options.model,
		thinkingLevel: options.thinkingLevel as never,
		tools: [...VERIFIER_TOOLS],
		customTools: [verdictTool],
		resourceLoader: emptyResourceLoader(systemPrompt),
		sessionManager: SessionManager.inMemory(options.cwd),
		settingsManager,
	});
	return session;
};

/**
 * 跑独立 AgentSession 并保留明确的结束原因。
 * 初始化失败/超时/未提交 verdict 时由 Runtime 降级为 hard-only。
 */
export async function runVerifier(
	opts: VerifierOptions,
	createSession: CreateVerifierSession = createSdkVerifierSession,
): Promise<VerifierRunResult> {
	let submitted: unknown = null;
	let session: AgentSessionLike | null = null;
	let unsubscribe: (() => void) | null = null;
	let timedOut = false;
	const usage: VerifierUsage = { ...ZERO_USAGE };
	const trace: string[] = [];
	const emit = (activity: string) => {
		if (trace[trace.length - 1] !== activity) {
			trace.push(activity);
			if (trace.length > 30) trace.shift();
		}
		opts.onProgress?.({ ...usage, activity, trace: [...trace] });
	};
	const abort = async () => {
		if (session) await session.abort();
	};
	const onExternalAbort = () => {
		void abort();
	};
	const timer = setTimeout(() => {
		timedOut = true;
		void abort();
	}, opts.timeoutMs);
	timer.unref();

	try {
		if (!opts.model) throw new Error("Verifier 无可用模型");
		if (opts.signal?.aborted) timedOut = true;
		opts.signal?.addEventListener("abort", onExternalAbort, { once: true });
		emit("初始化独立 AgentSession");
		session = await createSession({
			options: opts,
			systemPrompt: verifierSystemPrompt(),
			onVerdict: (value) => {
				submitted = value;
				emit("提交结构化核验结论");
			},
		});
		opts.onControl?.({
			steer: async (message) => {
				emit(`人工 steer: ${message.replace(/\s+/g, " ").slice(0, 100)}`);
				await session!.steer(message);
			},
			abort,
		});
		unsubscribe = session.subscribe((event) => {
			updateProgress(event, usage, emit);
		});
		if (timedOut || opts.signal?.aborted) {
			await abort();
		} else {
			emit("分析冻结验收标准");
			await session.prompt(opts.brief);
		}
	} catch (error) {
		return {
			status: timedOut || opts.signal?.aborted ? "timeout" : "failed",
			evidences: null,
			message: error instanceof Error ? error.message : String(error),
			usage,
			trace,
		};
	} finally {
		clearTimeout(timer);
		opts.signal?.removeEventListener("abort", onExternalAbort);
		opts.onControl?.(null);
		unsubscribe?.();
		session?.dispose();
	}

	if (timedOut || opts.signal?.aborted) {
		return {
			status: "timeout",
			evidences: null,
			message: `超过 ${opts.timeoutMs}ms 或被中止`,
			usage,
			trace,
		};
	}
	try {
		const verdicts = validateVerdicts(submitted, opts.expectedAcIds);
		return {
			status: "completed",
			evidences: verdicts.map((v) => ({
				level: "semi" as const,
				acId: v.acId,
				result: v.result,
				raw: v.rationale,
				envFingerprint: opts.envFingerprint,
			})),
			usage,
			trace,
		};
	} catch (error) {
		return {
			status: "failed",
			evidences: null,
			message: error instanceof Error ? error.message : "verdict 校验失败",
			usage,
			trace,
		};
	}
}

function verifierSystemPrompt(): string {
	return `你是独立代码核验 Agent。只核对提供的任务与冻结验收标准,不继承执行者对话。
你只能使用只读工具查看仓库,不能修改文件或自行扩展验收标准。
核对完成后必须调用 mission_verdict 一次提交逐条结论,然后结束。`;
}

function validateVerdicts(value: unknown, expectedAcIds: string[]): Array<{
	acId: string;
	result: "pass" | "fail" | "inconclusive";
	rationale: string;
}> {
	if (!Array.isArray(value) || value.length === 0) throw new Error("Verifier 未提交 verdict");
	const verdicts = value.map((item, index) => {
		if (
			typeof item !== "object" ||
			item === null ||
			typeof (item as any).acId !== "string" ||
			!(item as any).acId.trim() ||
			!VERDICT_RESULTS.has((item as any).result) ||
			typeof (item as any).rationale !== "string" ||
			!(item as any).rationale.trim()
		) {
			throw new Error(`Verifier verdict[${index}] 结构无效`);
		}
		return {
			acId: (item as any).acId.trim(),
			result: (item as any).result,
			rationale: (item as any).rationale,
		};
	});
	const expected = new Set(expectedAcIds);
	const actual = new Set<string>();
	for (const verdict of verdicts) {
		if (!expected.has(verdict.acId)) throw new Error(`Verifier 提交了未知 AC:${verdict.acId}`);
		if (actual.has(verdict.acId)) throw new Error(`Verifier 重复提交 AC:${verdict.acId}`);
		actual.add(verdict.acId);
	}
	const missing = expectedAcIds.filter((id) => !actual.has(id));
	if (missing.length > 0) throw new Error(`Verifier 漏交 AC:${missing.join(",")}`);
	return verdicts;
}

function updateProgress(
	event: AgentSessionEvent,
	usage: VerifierUsage,
	emit: (activity: string) => void,
): void {
	if (event.type === "tool_execution_start") {
		usage.toolCalls += 1;
		emit(describeTool(event.toolName, event.args));
		return;
	}
	if (event.type === "tool_execution_end" && event.isError) {
		emit(`${event.toolName} 执行失败`);
		return;
	}
	if (event.type !== "message_end" || event.message.role !== "assistant") return;
	usage.turns += 1;
	const u = event.message.usage;
	usage.input += u?.input ?? 0;
	usage.output += u?.output ?? 0;
	usage.cacheRead += u?.cacheRead ?? 0;
	usage.cacheWrite += u?.cacheWrite ?? 0;
	usage.cost += u?.cost?.total ?? 0;
	emit(`完成第 ${usage.turns} 轮核验`);
}

function describeTool(name: string, args: any): string {
	const file = String(args?.file_path ?? args?.path ?? "").trim();
	if (name === "read") return file ? `读取 ${file}` : "读取文件";
	if (name === "grep") return `搜索 ${String(args?.pattern ?? "").slice(0, 80) || "代码"}`;
	if (name === "find") return `查找 ${String(args?.pattern ?? "").slice(0, 80) || "文件"}`;
	if (name === "ls") return file ? `浏览 ${file}` : "浏览目录";
	if (name === "mission_verdict") return "提交结构化核验结论";
	return `调用 ${name}`;
}

export function renderVerifierBrief(input: {
	goal: string;
	taskId: string;
	taskTitle: string;
	acceptanceCriteria: Array<{ id: string; text: string; verify: string }>;
	hardResults: Array<{ acId: string; pass: boolean; outputTail: string }>;
	diff: string;
}): string {
	const acs = input.acceptanceCriteria
		.map((ac) => `- ${ac.id} (verify: ${ac.verify}): ${ac.text}`)
		.join("\n");
	const hard = input.hardResults
		.map((h) => `- ${h.acId}: ${h.pass ? "PASS" : "FAIL"}\n  输出尾部:\n${indent(h.outputTail)}`)
		.join("\n");
	return `你是独立验证者,正在核对一个 coding mission 的当前改动。你不能写文件(只读工具:read/grep/find/ls),也不能执行命令;自动化验证已由系统跑完并附在下面,核对语义后调用 mission_verdict 提交结论。

# Mission 目标
${input.goal}

# 当前任务
${input.taskId}: ${input.taskTitle}

# 冻结的验收标准(逐条核对)
${acs}

# 自动化验证结果(hard 证据,已由系统执行)
${hard}

# 当前改动(git diff)
${input.diff}

# 规则
- 逐条 AC 给出 pass / fail / inconclusive(证据不足就 inconclusive,不要猜)
- 关注:改动是否真的满足 AC 的语义,而不是仅仅让测试变绿(比如被改弱的断言)
- 核对完调用 mission_verdict,然后结束`;
}

/**
 * 探针的核对简报。判的不是"改动对不对"(探针不该有改动),
 * 而是"这份结论有没有真的回答那个问题"。
 */
export function renderSpikeVerifierBrief(input: {
	goal: string;
	taskId: string;
	question: string;
	report: string;
	diff: string;
}): string {
	return `你是独立验证者,正在核对一次探针任务(spike)的结论。你不能写文件(只读工具:read/grep/find/ls),也不能执行命令;核对后调用 mission_verdict 提交结论。

# Mission 目标
${input.goal}

# 探针要回答的问题(${input.taskId})
${input.question}

# 执行者交出的结论
${input.report}

# 工作区改动(探针不该改实现,有改动就是越界)
${input.diff || "(无)"}

# 规则
- 只判一条,acId 用 "spike"
- pass 的条件:结论**正面回答了上面那个问题**,且给出了它依据的事实(文件、数量、报错、测量值)
- fail 的条件:答非所问、只有"需要进一步调研"这类空话、或结论与仓库里能读到的事实矛盾;
  探针改了实现代码也判 fail
- 证据不足以判断就给 inconclusive,不要猜
- 你可以自己 read / grep / find / ls 去抽查结论里的关键事实
- 核对完调用 mission_verdict,然后结束`;
}

function indent(s: string): string {
	return s
		.split("\n")
		.map((l) => `  ${l}`)
		.join("\n");
}

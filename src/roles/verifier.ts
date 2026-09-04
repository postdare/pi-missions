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
import type { Evidence, FailureCategory } from "../core/types.ts";
import { budgetReason, checkVerifierBudget, type VerifierBudget } from "../core/verifier-budget.ts";

/** 只读工具白名单:没有 edit/write/bash,Verifier 无法修改工作区。导出供测试锁定。 */
export const VERIFIER_TOOLS = ["read", "grep", "find", "ls", "mission_verdict"] as const;
const VERDICT_RESULTS = new Set(["pass", "fail", "inconclusive"]);
/** 失败类别。熔断签名用它算 —— 见 core/types.ts 的 FailureCategory */
const FAILURE_TAGS = new Set<FailureCategory>(["missing", "incorrect", "regression"]);

export interface VerifierOptions {
	cwd: string;
	/** 已解析的实际模型。配置缺失或不可用时由 Runtime 传当前会话模型 */
	model: any;
	thinkingLevel: string;
	brief: string;
	/** 静默/总时长两条预算,判定在 core/verifier-budget.ts */
	budget: VerifierBudget;
	signal?: AbortSignal;
	/** 本轮必须逐条提交且只能提交这些 AC */
	expectedAcIds: string[];
	onProgress?: (progress: VerifierProgress) => void;
	onControl?: (control: VerifierControl | null) => void;
}

export type VerifierRunResult =
	| { status: "completed"; evidences: Evidence[]; usage: VerifierUsage; trace: string[] }
	| {
			status: "timeout" | "failed";
			evidences: null;
			message: string;
			usage: VerifierUsage;
			trace: string[];
			/**
			 * provider/网关直接把这一轮打回来了(HTTP 4xx/5xx),模型根本没开口。
			 * 与"模型跑完了但没调 mission_verdict"是两码事:前者是配置或服务问题,
			 * 后者才是模型不听话。混成一句话就等于把真正的病根丢掉(见 runVerifier)。
			 */
			providerError?: string;
	  };

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
					rationale: Type.String({ description: "具体依据。判 fail 时说清你找到的反证是什么" }),
					failureTag: Type.Optional(
						Type.Union([Type.Literal("missing"), Type.Literal("incorrect"), Type.Literal("regression")], {
							description:
								"result=fail 时必填:missing=该做的没做(含只做一半);incorrect=做了但行为不对;" +
								"regression=把本来正常的东西改坏了。系统用它判断'是不是同一个病根在反复出现'," +
								"措辞可以变,类别不能随便变。",
						}),
					),
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
 * 跑一次独立核验,失败时按 provider 报错的内容决定要不要换个 thinking 档再来一次。
 *
 * 为什么要重试:verifier 的默认 thinking 是 off(便宜),而有些推理模型**强制**开思考,
 * 关掉就是一个 400。这类模型在 pi 里不抛异常,只回一条空的 assistant 消息 ——
 * 于是"模型报错"一路伪装成"没提交 verdict" → 降级 hard-only → quick 档没了唯一证据源
 * → 判无结论 → 三轮空转后停机,提示还写着"环境可能漂移"(真实事故)。
 * 便宜是优化项,核验能不能跑是正确性项,冲突时让前者让路。
 */
export async function runVerifier(
	opts: VerifierOptions,
	createSession: CreateVerifierSession = createSdkVerifierSession,
): Promise<VerifierRunResult> {
	const first = await runVerifierOnce(opts, createSession);
	if (first.status === "completed") return first;
	const retryThinking = thinkingRetryLevel(opts.thinkingLevel, first.providerError);
	if (!retryThinking) return first;
	const second = await runVerifierOnce({ ...opts, thinkingLevel: retryThinking }, createSession);
	const usage = mergeUsage(first.usage, second.usage);
	const trace = [`thinking=${opts.thinkingLevel} 被 provider 拒绝,改用 ${retryThinking} 重试`, ...second.trace];
	if (second.status === "completed") return { ...second, usage, trace };
	return {
		...second,
		usage,
		trace,
		message: `${second.message}(已用 thinking=${retryThinking} 重试过一次;首轮:${first.message})`,
	};
}

/**
 * provider 明说了"这个模型必须开思考"时,把 off 换成一个最省的可用档位。
 * 只认这一种错 —— 别的 400(模型不存在、没额度、上下文超限)重试都是白烧钱。
 */
function thinkingRetryLevel(current: string, providerError?: string): string | null {
	if (current !== "off" || !providerError) return null;
	const text = providerError.toLowerCase();
	const mustThink =
		(text.includes("thinking") || text.includes("reasoning")) &&
		(text.includes("enabled") || text.includes("always") || text.includes("must") || text.includes("required"));
	return mustThink ? "low" : null;
}

function mergeUsage(a: VerifierUsage, b: VerifierUsage): VerifierUsage {
	return {
		turns: a.turns + b.turns,
		toolCalls: a.toolCalls + b.toolCalls,
		input: a.input + b.input,
		output: a.output + b.output,
		cacheRead: a.cacheRead + b.cacheRead,
		cacheWrite: a.cacheWrite + b.cacheWrite,
		cost: a.cost + b.cost,
	};
}

/**
 * 跑独立 AgentSession 并保留明确的结束原因。
 * 初始化失败/超时/未提交 verdict 时由 Runtime 降级为 hard-only。
 */
async function runVerifierOnce(
	opts: VerifierOptions,
	createSession: CreateVerifierSession,
): Promise<VerifierRunResult> {
	let submitted: unknown = null;
	let session: AgentSessionLike | null = null;
	let unsubscribe: (() => void) | null = null;
	let timedOut = false;
	let providerError: string | undefined;
	const usage: VerifierUsage = { ...ZERO_USAGE };
	const trace: string[] = [];
	const emit = (activity: string) => {
		if (trace[trace.length - 1] !== activity) {
			trace.push(activity);
			if (trace.length > 30) trace.shift();
		}
		// 有动静就把静默计时归零。这一行是整套机制的支点:干活的核验
		// 每次工具调用都会走到这里,于是永远不会被静默判定掐掉。
		lastActivityAt = Date.now();
		opts.onProgress?.({ ...usage, activity, trace: [...trace] });
	};
	const abort = async () => {
		if (session) await session.abort();
	};
	const onExternalAbort = () => {
		void abort();
	};
	// 按**静默**掐,不按总时长 —— 理由见 core/verifier-budget.ts 的文件头。
	// 轮询间隔跟着静默口径走:生产上(120s)就是 5 秒一查,足够细又不空转;
	// 测试里把口径调到毫秒级时它也跟着变细,不必为了等一个固定间隔而让用例跑满 5 秒。
	let lastActivityAt = Date.now();
	let timedOutReason: string | null = null;
	const startedAt = lastActivityAt;
	const timer = setInterval(() => {
		const verdict = checkVerifierBudget(
			{ startedAt, lastActivityAt, now: Date.now() },
			opts.budget,
		);
		if (verdict === "running") return;
		timedOut = true;
		timedOutReason = budgetReason(verdict, opts.budget);
		void abort();
	}, Math.min(5_000, Math.max(50, Math.floor(opts.budget.idleMs / 4))));
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
			const failed = providerErrorOf(event);
			if (failed) {
				providerError = failed;
				emit(`provider 拒绝了请求:${failed.replace(/\s+/g, " ").slice(0, 120)}`);
			}
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
			providerError,
		};
	} finally {
		clearInterval(timer);
		opts.signal?.removeEventListener("abort", onExternalAbort);
		opts.onControl?.(null);
		unsubscribe?.();
		session?.dispose();
	}

	if (timedOut || opts.signal?.aborted) {
		return {
			status: "timeout",
			evidences: null,
			message: timedOutReason ?? "被中止",
			usage,
			trace,
			providerError,
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
				failureTag: v.failureTag,
			})),
			usage,
			trace,
		};
	} catch (error) {
		// provider 报错时,"未提交 verdict" 只是它的**后果**,不是原因。
		// 报后果会让看 LOG 的人以为是模型不听话,而真正要改的是 models.json 里的配置
		// (真实事故:glm 强制 reasoning,thinking=off 直接 400,LOG 里只有"未提交 verdict")。
		const fallback = error instanceof Error ? error.message : "verdict 校验失败";
		return {
			status: "failed",
			evidences: null,
			message: providerError ? `${providerError}(因此 ${fallback})` : fallback,
			usage,
			trace,
			providerError,
		};
	}
}

/**
 * 从会话事件里捞出 provider 拒绝请求的原文。
 *
 * pi 在 provider 报错时**不抛异常**:它产出一条 stopReason==="error"、content 为空的
 * assistant 消息,prompt() 照常 resolve。不看这个字段,错误就彻底消失了。
 */
function providerErrorOf(event: AgentSessionEvent): string | undefined {
	if (event.type !== "message_end") return undefined;
	const message = event.message as { stopReason?: string; errorMessage?: string };
	if (message.stopReason !== "error") return undefined;
	return (message.errorMessage ?? "provider 返回错误(无详情)").replace(/\s+/g, " ").trim();
}

/**
 * 独立验证者的系统提示词。**这里是它唯一的行为规范来源。**
 *
 * 它跑在 emptyResourceLoader 上(不加载扩展、skill、prompt、context file),
 * 所以 `missions/phases/check.md` 对它完全无效 —— 那是注入**主会话**的。
 * 迁到进程内 AgentSession 之前,验证者是个独立 pi 进程、确实读得到脚手架;
 * check.md 里那段"如果你是独立验证者……"就是那个时代的遗留,已经删掉。
 * 要调验证者的行为,改这里和 renderVerifierBrief(),不要去改 check.md。
 */
function verifierSystemPrompt(): string {
	// 提问方向是刻意反过来的:「找出不满足的理由,找不到才判 pass」。
	// 正向核对("这条 AC 满足了吗")在同源模型上会系统性偏向 pass ——
	// 「我看这个 diff,它确实做了 X」和「我写这个 diff 时认为做了 X 就够了」
	// 是同一个认知。这不是能力问题,是两个裁判的错误相关。
	return `你是独立代码核验 Agent。只核对提供的任务与冻结验收标准,不继承执行者对话。
你只能使用只读工具查看仓库,不能修改文件或自行扩展验收标准。

核对方式:对每一条验收标准,**先尽力找出它不满足的理由** —— 漏掉的分支、没覆盖的输入、
只改了表面没改根因、边界条件、被这次改动带坏的旧行为。找遍了都找不到反证,才判 pass。
不要从"它看起来做了"出发,要从"它哪里还没做到"出发。

判 fail 时必须给 failureTag(missing/incorrect/regression):系统用它判断同一个病根是不是
在反复出现,从而决定要不要停止微调、升级方案。理由怎么写都行,但类别要如实。
核对完成后必须调用 mission_verdict 一次提交逐条结论,然后结束。`;
}

function validateVerdicts(value: unknown, expectedAcIds: string[]): Array<{
	acId: string;
	result: "pass" | "fail" | "inconclusive";
	rationale: string;
	failureTag?: FailureCategory;
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
		const tag = (item as any).failureTag;
		// 判 fail 却没给类别:不报错,退化成固定串(canonicalOf 里兜着)。
		// 宁可粒度粗一点,也不能因为缺一个标签就把整份核验作废 —— 那是更糟的失败模式。
		return {
			acId: (item as any).acId.trim(),
			result: (item as any).result,
			rationale: (item as any).rationale,
			failureTag: FAILURE_TAGS.has(tag) ? (tag as FailureCategory) : undefined,
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

/**
 * 核验简报。
 *
 * **列表由 expectedAcIds 生成,而不是由 plan.acceptanceCriteria 生成** —— 这两处
 * 一旦各自取数就会漂,而漂了是静默的:validateVerdicts 抛错 → 整份核验被丢弃 →
 * 降级 hard-only → mission 照常 PASS。真实事故:简报列的是 AC1..AC5(计划里的
 * AC id),校验要的是 copy/edit/small(verify 分支名,I9 说它才是 AC 的可执行 id),
 * 验证者老老实实交了 "AC3",被判"提交了未知 AC",连着三个任务的 semi 证据全丢,
 * 整条 I3(判定权外置)在账面上存在、实际从未生效。
 *
 * 所以这里只认一个 id 命名空间:**expectedAcIds**。正文从计划里按 verify 分支反查,
 * 查不到也照样列出这一条 —— 宁可正文缺失,也不能让 id 集合对不上。
 */
export function renderVerifierBrief(input: {
	goal: string;
	taskId: string;
	taskTitle: string;
	acceptanceCriteria: Array<{ id: string; text: string; verify: string }>;
	/** 本轮必须逐条提交、且只能提交这些 id。与 runVerifier 的 expectedAcIds 同源 */
	expectedAcIds: string[];
	hardResults: Array<{ acId: string; pass: boolean; outputTail: string }>;
	diff: string;
}): string {
	const acs = input.expectedAcIds
		.map((acId) => {
			const matched = input.acceptanceCriteria.filter((ac) => ac.verify === acId);
			const text = matched.map((ac) => ac.text).join(" / ");
			const planIds = matched.map((ac) => ac.id).join("/");
			return `- ${acId}${planIds ? ` (计划里的 ${planIds})` : ""}: ${text || "(计划中没有对应正文,按目标与任务标题核对)"}`;
		})
		.join("\n");
	// hardResults 为空是 quick 档的常态(那一档没有 verify.sh)。留一个空标题最糟:
	// 「自动化验证结果」下面什么都没有,既可能被读成"跑过了没问题",也可能被读成
	// "系统跳过了验证,我可以松一点"。这一档 semi 是**唯一**证据源,必须说明白。
	const hard =
		input.hardResults.length > 0
			? input.hardResults
					.map((h) => `- ${h.acId}: ${h.pass ? "PASS" : "FAIL"}\n  输出尾部:\n${indent(h.outputTail)}`)
					.join("\n")
			: "(本轮没有可执行的自动化验证 —— 这个 mission 不带 verify.sh。\n" +
				"你的核对是唯一的判定依据,请按下面的规则逐条查证,不要因为缺少测试结果就放宽标准。)";
	return `你是独立验证者,正在核对一个 coding mission 的当前改动。你不能写文件(只读工具:read/grep/find/ls),也不能执行命令;自动化验证已由系统跑完并附在下面,核对语义后调用 mission_verdict 提交结论。

# Mission 目标
${input.goal}

# 当前任务
${input.taskId}: ${input.taskTitle}

# 冻结的验收标准(逐条核对)
${acs}

提交 mission_verdict 时,acId **原样使用上面每条开头的那个标识**
(本轮共 ${input.expectedAcIds.length} 条:${input.expectedAcIds.join("、")}),
不多不少、不要改写、不要用计划里的 AC 编号 —— 对不上的会被整份丢弃。

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

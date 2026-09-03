/**
 * pi-missions · roles/scout
 *
 * PLAN 相位的只读侦查子 agent。一路一个进程内 AgentSession,N 路并行。
 *
 * 判据与纪律在 core/scout.ts 的文件头(为什么它踩在 8.7 的判据上、
 * 为什么它不是第二个 spike、为什么要有额度)。这里只写执行侧的三条:
 *
 * 1. **工具集是 READONLY,没有 bash。** 与 Verifier 同一份名单。
 *    能跑任意命令就能写文件,而子 agent 的写入不经过宿主会话的 tool_call 钩子 ——
 *    I2 的冻结件闸门、I7 的 touchedFiles 记账、编辑级增量反馈三条同时失效。
 *    "只读"必须是机械的,不能是提示词里嘱咐它别写。
 *
 * 2. **一路失败不拖累其他路。** N 路各自 try/catch,聚合用 Promise.all 包一层
 *    永不 reject 的包装。一路超时只让那一个问题变成"未查明,沿用假设",
 *    planner 照样能写计划 —— 扇出的价值就在于此,一路挂掉全轮作废等于没并行。
 *
 * 3. **采信与否不在这里判。** 子 agent 交回来的东西一律交给 core 的
 *    `interpretFinding()` 定性(没出处的结论会被降级成"未查明")——
 *    "这条结论算不算数"是判定,判定只能在 core 的纯函数里(CLAUDE.md 第 1 条)。
 *    本文件只负责把子 agent 起起来、把它交的东西原样递过去。
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
import { interpretFinding, unansweredFinding, type ScoutFinding, type ScoutQuestion } from "../core/scout.ts";

/** 只读工具白名单。与 VERIFIER_TOOLS 同源:没有 bash、没有 edit/write。导出供测试锁定 */
export const SCOUT_TOOLS = ["read", "grep", "find", "ls", "mission_finding"] as const;

export interface ScoutUsage {
	turns: number;
	toolCalls: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

const ZERO_USAGE: ScoutUsage = {
	turns: 0,
	toolCalls: 0,
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	cost: 0,
};

export interface ScoutOptions {
	cwd: string;
	/** 已解析的实际模型。配置缺失时由 Runtime 传当前会话模型 */
	model: any;
	thinkingLevel: string;
	/** 单路超时。扇出是并行的,所以这是整轮的墙钟上限,不是 N 倍 */
	timeoutMs: number;
	signal?: AbortSignal;
	/** mission 目标,给子 agent 一点上下文 —— 但它只回答自己那一个问题 */
	goal: string;
	questions: ScoutQuestion[];
	onProgress?: (p: ScoutFanoutProgress) => void;
}

/** 扇出整体进度。按路汇报 —— 谁在跑、谁回来了 */
export interface ScoutFanoutProgress {
	/** 已完成路数(含失败) */
	done: number;
	total: number;
	/** 每一路当前在干什么,按问题 id */
	activity: Record<string, string>;
	usage: ScoutUsage;
}

export interface ScoutFanoutResult {
	/** 每个问题一条,顺序与入参一致。未答成的那几路 status="unanswered" */
	findings: ScoutFinding[];
	/** 全部路数合计 */
	usage: ScoutUsage;
	/** 人类可读的失败说明,按问题 id。用于 LOG 与信封 —— 不能只是"未查明" */
	failures: Record<string, string>;
}

interface AgentSessionLike {
	subscribe(listener: (event: AgentSessionEvent) => void): () => void;
	prompt(text: string): Promise<void>;
	abort(): Promise<void>;
	dispose(): void;
}

interface CreateScoutSessionInput {
	options: ScoutOptions;
	systemPrompt: string;
	onFinding(value: unknown): void;
}

export type CreateScoutSession = (input: CreateScoutSessionInput) => Promise<AgentSessionLike>;

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

const createSdkScoutSession: CreateScoutSession = async ({ options, systemPrompt, onFinding }) => {
	const findingTool = defineTool({
		name: "mission_finding",
		label: "提交侦查结论",
		description: "提交这一路侦查的结论。查明与没查明都用它提交 —— 沉默等于这一路白跑。",
		parameters: Type.Object({
			found: Type.Boolean({
				description:
					"是否真的查明了。查不到就填 false 并在 answer 里说明你查过哪些地方 —— " +
					"如实说没查到是有用的输出,编一个像样的答案是最坏的输出。",
			}),
			answer: Type.String({
				description:
					"结论,一到三句话,直接回答被问的那个问题。带上具体的数字、路径、标识符。" +
					"found=false 时写你查了哪里、为什么判断查不到。",
			}),
			citations: Type.Array(Type.String(), {
				description:
					"出处:文件路径,能定位到行就写 path:line。found=true 时**必填且不能为空** —— " +
					"没有出处的结论会被系统降级为「未查明」。",
			}),
		}),
		async execute(_id, params) {
			onFinding(params);
			return { content: [{ type: "text", text: "侦查结论已提交。" }], details: {} };
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
		tools: [...SCOUT_TOOLS],
		customTools: [findingTool],
		resourceLoader: emptyResourceLoader(systemPrompt),
		sessionManager: SessionManager.inMemory(options.cwd),
		settingsManager,
	});
	return session;
};

export function scoutSystemPrompt(): string {
	return [
		"你是一个只读侦查员(scout)。有人正在为一次改动写计划,卡在一个关于**这个仓库**的事实问题上,",
		"你的唯一工作是去代码里把它查清楚,然后调用 `mission_finding` 交回来。",
		"",
		"纪律:",
		"1. 只回答被问的那一个问题。不要顺带评价代码、不要提改进建议、不要设计方案 —— 那是提问者的活。",
		"2. 每条结论都要有出处(文件路径,能定位到行就写 path:line)。没有出处的结论会被系统丢弃。",
		"3. 提问者会告诉你他现在的假设。**你的价值在于证实或推翻它** ——",
		"   顺着假设找证据是这份工作最容易犯的错,先去找它不成立的地方。",
		"4. 查不到就如实交 found=false,并说明你查过哪里。如实说没查到是有用的输出;",
		"   编一个听起来合理的答案是最坏的输出 —— 它会被当成核实过的事实写进验收标准。",
		"5. 你只有只读工具(read/grep/find/ls),没有 shell,也不能改任何文件。这是设计,不是故障。",
		"",
		"查完就交,不要反复确认。一路侦查值不了太多钱。",
	].join("\n");
}

export function renderScoutBrief(goal: string, q: ScoutQuestion): string {
	return [
		`这次改动的目标:${goal}`,
		"",
		`要查清的问题(${q.id}):${q.text}`,
		`这个答案会影响:${q.why}`,
		`提问者现在的假设:${q.assume}`,
		"",
		"去查。查完调用 mission_finding 提交结论 —— 先去找这个假设不成立的地方。",
	].join("\n");
}

/**
 * 扇出一轮侦查。N 路并行,一路失败不影响其他路。
 *
 * 返回的 findings 与 opts.questions **等长且同序** —— 调用方据此逐条对应,
 * 不必再做 id 匹配。未答成的那几路也在里面(status="unanswered"),
 * 因为"这个问题没查明"本身就是 planner 必须知道的事(见 ScoutFinding.status)。
 */
export async function runScouts(
	opts: ScoutOptions,
	createSession: CreateScoutSession = createSdkScoutSession,
): Promise<ScoutFanoutResult> {
	const total = opts.questions.length;
	const activity: Record<string, string> = {};
	const usage: ScoutUsage = { ...ZERO_USAGE };
	let done = 0;
	const report = () => opts.onProgress?.({ done, total, activity: { ...activity }, usage: { ...usage } });

	for (const q of opts.questions) activity[q.id] = "排队中";
	report();

	const results = await Promise.all(
		opts.questions.map(async (q) => {
			const r = await runScoutOnce(opts, q, createSession, (act) => {
				activity[q.id] = act;
				report();
			}, usage);
			done += 1;
			activity[q.id] = r.finding.status === "answered" ? "已交回结论" : "未查明";
			report();
			return r;
		}),
	);

	const failures: Record<string, string> = {};
	for (const r of results) if (r.failure) failures[r.finding.id] = r.failure;
	return { findings: results.map((r) => r.finding), usage, failures };
}

async function runScoutOnce(
	opts: ScoutOptions,
	q: ScoutQuestion,
	createSession: CreateScoutSession,
	emit: (activity: string) => void,
	usage: ScoutUsage,
): Promise<{ finding: ScoutFinding; failure?: string }> {
	let submitted: unknown = null;
	let session: AgentSessionLike | null = null;
	let unsubscribe: (() => void) | null = null;
	let timedOut = false;
	const abort = async () => {
		if (session) await session.abort();
	};
	const onExternalAbort = () => void abort();
	const timer = setTimeout(() => {
		timedOut = true;
		void abort();
	}, opts.timeoutMs);
	timer.unref();

	try {
		if (!opts.model) throw new Error("scout 无可用模型");
		if (opts.signal?.aborted) timedOut = true;
		opts.signal?.addEventListener("abort", onExternalAbort, { once: true });
		emit("初始化");
		session = await createSession({
			options: opts,
			systemPrompt: scoutSystemPrompt(),
			onFinding: (value) => {
				submitted = value;
				emit("提交结论");
			},
		});
		unsubscribe = session.subscribe((event) => updateProgress(event, usage, emit));
		if (timedOut || opts.signal?.aborted) {
			await abort();
		} else {
			emit("查证中");
			await session.prompt(renderScoutBrief(opts.goal, q));
		}
	} catch (error) {
		const why = error instanceof Error ? error.message : String(error);
		return { finding: unansweredFinding(q, why), failure: why };
	} finally {
		clearTimeout(timer);
		opts.signal?.removeEventListener("abort", onExternalAbort);
		unsubscribe?.();
		session?.dispose();
	}

	if (timedOut || opts.signal?.aborted) {
		const why = `超过 ${Math.round(opts.timeoutMs / 1000)}s 或被中止`;
		return { finding: unansweredFinding(q, why), failure: why };
	}
	return interpretFinding(q, submitted);
}

function updateProgress(event: AgentSessionEvent, usage: ScoutUsage, emit: (a: string) => void): void {
	if (event.type === "tool_execution_start") {
		usage.toolCalls += 1;
		emit(describeTool(event.toolName, event.args));
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
}

function describeTool(name: string, args: any): string {
	const file = String(args?.file_path ?? args?.path ?? "").trim();
	if (name === "read") return file ? `读 ${file}` : "读文件";
	if (name === "grep") return `搜 ${String(args?.pattern ?? "").slice(0, 40) || "代码"}`;
	if (name === "find") return `找 ${String(args?.pattern ?? "").slice(0, 40) || "文件"}`;
	if (name === "ls") return file ? `列 ${file}` : "列目录";
	if (name === "mission_finding") return "提交结论";
	return name;
}

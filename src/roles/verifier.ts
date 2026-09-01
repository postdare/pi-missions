/**
 * pi-missions · roles/verifier
 *
 * 子进程 Check worker(I3 · 判定权外置)。
 * 它不需要回程:只输出一个 verdict,不需要继续对话,也不需要 DO 的历史 ——
 * 这让它成为最干净的一次隔离。启动命令:
 *
 *   pi -p --mode json --no-extensions -e <verifier-tools.ts> [--model m] <brief>
 *
 * --no-extensions 防止递归加载 pi-missions 自身。
 * 结论经 mission_verdict 工具以 MISSION_VERDICT::<base64> 标记行回传。
 */

import type { Evidence } from "../core/types.ts";

type Exec = (
	cmd: string,
	args: string[],
	opts?: { cwd?: string; timeout?: number; signal?: AbortSignal },
) => Promise<{ code: number; stdout: string; stderr: string; killed: boolean }>;

const VERDICT_MARK = /MISSION_VERDICT::([A-Za-z0-9+/=]+)/;

export interface VerifierOptions {
	cwd: string;
	toolsPath: string;
	/** models.json 的 verifier.provider/model;缺省用 pi 默认模型 */
	provider?: string;
	model?: string;
	brief: string;
	timeoutMs: number;
	signal?: AbortSignal;
	envFingerprint: string;
}

/**
 * 跑独立验证者,返回 semi 证据列表。
 * 启动失败/超时/解析失败 → 返回 null(判定退化为只用 hard 证据,理由里注明)。
 */
export async function runVerifier(exec: Exec, opts: VerifierOptions): Promise<Evidence[] | null> {
	const args = ["-p", "--mode", "json", "--no-extensions", "-e", opts.toolsPath];
	if (opts.provider && opts.model) args.push("--model", `${opts.provider}/${opts.model}`);
	else if (opts.model) args.push("--model", opts.model);
	args.push(opts.brief);

	let out: { code: number; stdout: string; stderr: string };
	try {
		out = await exec("pi", args, { cwd: opts.cwd, timeout: opts.timeoutMs, signal: opts.signal });
	} catch {
		return null;
	}

	const m = out.stdout.match(VERDICT_MARK);
	if (!m) return null;
	try {
		const verdicts = JSON.parse(Buffer.from(m[1], "base64").toString("utf8")) as Array<{
			acId: string;
			result: "pass" | "fail" | "inconclusive";
			rationale: string;
		}>;
		return verdicts.map((v) => ({
			level: "semi" as const,
			acId: v.acId,
			result: v.result,
			raw: v.rationale,
			envFingerprint: opts.envFingerprint,
		}));
	} catch {
		return null;
	}
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
	return `你是独立验证者,正在核对一个 coding mission 的当前改动。你不能写文件(没有写工具),只能 read + bash 核对,然后调用 mission_verdict 提交结论。

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
	return `你是独立验证者,正在核对一次探针任务(spike)的结论。你不能写文件(没有写工具),只能 read + bash 核对,然后调用 mission_verdict 提交结论。

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
- 你可以自己 grep / 跑只读命令去抽查结论里的关键事实
- 核对完调用 mission_verdict,然后结束`;
}

function indent(s: string): string {
	return s
		.split("\n")
		.map((l) => `  ${l}`)
		.join("\n");
}

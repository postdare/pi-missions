/**
 * pi-missions · core/scout
 *
 * PLAN 相位的**只读侦查扇出**(scout)。一次并行起 N 个只读 AgentSession,
 * 每个只回答一个关于本仓库的事实问题,结论经结构化工具回到 L0。
 *
 * ── 为什么允许它存在(它踩在 8.7 的判据上,不是绕过) ──
 *
 * ARCHITECTURE 8.7 的判据是一条,不是"支不支持 sub-agent":
 *   **能写工作区的 sub-agent 一律不做;只读、且结论经结构化工具回到 L0 的安全** ——
 *   它退化成一次函数调用,判定权仍在 judge()。
 *
 * scout 是照这个模子做的第二个实例(第一个是 4.7 的 Verifier):工具集里没有
 * edit/write,**也没有 bash** —— Verifier 也没有。这一条不能松:能跑任意命令
 * 就能写文件,而它的写入不经过宿主会话的 tool_call 钩子,I2 的冻结件闸门、
 * I7 的 touchedFiles 记账、编辑级增量反馈三条同时失效(8.7 的那张表)。
 * "只读"必须是机械的只读,不是提示词里嘱咐它别写。
 *
 * ── 它和 spike 不是一件事 ──
 *
 * 两者都在回答"答案在代码里,问人没用"这类问题,但形状完全不同:
 *
 *              spike                      scout
 *   时机       计划已冻结,作为任务跑      计划冻结之前,PLAN 相位内
 *   执行者     宿主会话的执行者(带闸门)  独立只读 AgentSession
 *   产物       结论文件 + 换脑 + 重写计划  结构化 findings,注入 planner
 *   并行       不可能(它是一个任务)      N 路同时
 *   代价       一整轮                     一次工具调用的时延
 *
 * 所以 spike 留给"要动手量一量、而且结论可能推翻整个方案"的情况(它以重写 PLAN
 * 结尾正是为此);scout 处理的是"我有几个互相独立的事实问题,不知道就写不出
 * 任务分解和 verify 分支"。用 scout 替代 spike 是错的,反过来也是 ——
 * 拿一整轮换脑去查"这个私有 API 用在几处"太贵了。
 *
 * ── 为什么要有额度和结账判据 ──
 *
 * 扇出便宜是相对的:N 路并行意味着 N 份 token,而"再查一轮"的诱惑和 DEFINE
 * 里"再问一轮"完全同构 —— 都可以无限期推迟动手,而且每一轮都显得很有道理。
 * 所以这里的四条规则与 define.ts 的 evaluateAsk 是同一套骨架(轮次上限 + 每轮
 * 条数上限 + 每题必须带默认答案 + 结账),只是把"推荐答案"换成了"当前假设",
 * 把"settled 必须增长"换成了"追问必须挂在上一轮的某个问题上"。
 *
 * 强制 assume(你现在假设答案是什么)有两个作用,都不是形式主义:
 *   1. 它是这一路 scout 的**默认答案** —— 超时/失败时 planner 不至于卡死,
 *      拿着自己的假设继续规划,只是知道它未经证实(见 runtime 的信封)。
 *   2. 假设与结论的**差值**才是这次侦查真正买到的东西,它可审计、可入 LOG。
 *      假设全中的一轮 scout 说明这个扇出本来不必发 —— 这是下次该收敛的信号。
 * 连假设都写不出的问题是懒问题("这个项目是怎么组织的?"),直接拒绝。
 */

import type { Tier } from "./types.ts";

/** 一轮最多扇出几路。再多就不是"有几个具体问题",而是让子 agent 替你读整个仓库 */
export const SCOUT_FANOUT_CAP = 4;

/**
 * 档位 → 侦查轮次上限。
 *
 * quick 给 0:它的 PLAN 相位只产出一条判据(见 core/criterion.ts),工具集里
 * 连 mission_write_plan 都没有。为一条一句话判据起并行子 agent,是把最便宜的
 * 那一档做成最贵的。
 *
 * standard 1 轮:它的方案只有一层,问题之间基本互相独立,一轮扇出够了。
 * complex 2 轮:里程碑展开是有依赖的,第一轮的答案会打开第二轮才问得出的问题
 * (与 define.ts 放宽轮次的理由同源)。
 */
const ROUND_CAP: Record<Tier, number> = { quick: 0, standard: 1, complex: 2 };

export function scoutRoundCapFor(tier: Tier): number {
	return ROUND_CAP[tier];
}

export interface ScoutQuestion {
	/** 问题 id,如 S1。第二轮的 follows 用它指代上一轮的问题 */
	id: string;
	/** 要查清的那一个事实。具体到能被 read/grep 回答 */
	text: string;
	/** 必填:这个答案会改变计划里的什么(哪条 AC、哪个 verify 分支、怎么分任务) */
	why: string;
	/** 必填:你现在假设答案是什么。它同时是超时兜底和"差值即收益"的基准 */
	assume: string;
	/** 第二轮起必填:这一问追的是上一轮哪个问题的答案 */
	follows?: string;
}

/** 一路 scout 的结论。落盘 —— 换脑之后 planner 照这个写计划,不能只活在上下文里 */
export interface ScoutFinding {
	/** 对应 ScoutQuestion.id */
	id: string;
	question: string;
	/** 模型当时的假设,原样留存 —— 没有它就看不出这次侦查买到了什么 */
	assume: string;
	/**
	 * 结论。**未答成时也有值**:这里放的是"未查明,沿用假设:<assume>",
	 * 而不是空串或 null。理由见 status 字段。
	 */
	answer: string;
	/**
	 * answered = 子 agent 交回了结论;unanswered = 超时/报错/没调工具。
	 *
	 * 两者绝不能混:把"没查到"渲染成一条结论,planner 会拿一个它以为经过核实的
	 * 假设去写 AC —— 那正是 scout 想消除的东西,而且伪装得更好。
	 * (同形的事故:verifier 报错被当成"没提交 verdict",见 roles/verifier.ts)
	 */
	status: "answered" | "unanswered";
	/** 结论的出处(file / file:line / 命令输出摘要)。空数组 = 子 agent 没给出处 */
	citations: string[];
	/** answered 且结论与 assume 实质不同 —— 这一路买到了东西 */
	surprised: boolean;
}

export interface ScoutInput {
	tier: Tier;
	/** 本 mission 已经扇出过几轮 */
	askedRounds: number;
	/** 前几轮问过的问题(id + text)。用于查重与 follows 校验 */
	asked: { id: string; text: string }[];
	questions: ScoutQuestion[];
}

export type ScoutVerdict = { ok: true; questions: ScoutQuestion[] } | { ok: false; reason: string };

/**
 * 查重用的归一化:抹掉空白与标点,英文转小写。
 * 中日韩字符原样保留(它们没有大小写,而按码位比较就够了)。
 */
function normText(s: string): string {
	return s
		.toLowerCase()
		.replace(/[\s\p{P}\p{S}]+/gu, "")
		.trim();
}

function normalize(questions: ScoutQuestion[]): ScoutQuestion[] {
	return questions
		.map((q) => ({
			id: (q.id ?? "").trim(),
			text: (q.text ?? "").trim(),
			why: (q.why ?? "").trim(),
			assume: (q.assume ?? "").trim(),
			follows: q.follows?.trim() || undefined,
		}))
		.filter((q) => q.text);
}

/**
 * 纯函数:这一轮扇出是否放行。五条规则,全部机械可测。
 *
 * 顺序是有讲究的:先挡"这一档根本没有这个环节"和"额度用完",再挡单题质量。
 * 反过来的话,quick 档会先收到三条关于 assume 怎么写的指导,然后才被告知
 * 它压根没有侦查环节 —— 那是让模型照着改一遍再撞一次墙。
 */
export function evaluateScout(input: ScoutInput): ScoutVerdict {
	const questions = normalize(input.questions);
	const cap = scoutRoundCapFor(input.tier);

	if (cap === 0) {
		return {
			ok: false,
			reason:
				`${input.tier} 档没有侦查环节。这一档的 PLAN 只产出一条判据,` +
				"用只读工具自己看几眼相关代码就够 —— 为一条一句话判据起并行子 agent 不划算。",
		};
	}
	if (input.askedRounds >= cap) {
		return {
			ok: false,
			reason:
				`${input.tier} 档的侦查轮次已经用完(上限 ${cap} 轮)。` +
				"拿现有结论去写计划;真需要动手量一量才知道的,在计划里排一个 spike 任务" +
				"(它以重写计划结尾,是为这种情况准备的);连问题定义都错了才走 L3。",
		};
	}
	if (questions.length === 0) {
		return { ok: false, reason: "没有实际问题。不需要侦查就直接写计划。" };
	}
	if (questions.length > SCOUT_FANOUT_CAP) {
		return {
			ok: false,
			reason:
				`一轮最多扇出 ${SCOUT_FANOUT_CAP} 路,你给了 ${questions.length} 个。` +
				"挑出真正'不知道就写不出任务分解或 verify 分支'的那几个 —— " +
				"超过这个数说明你在让子 agent 替你读整个仓库,而不是在查几个具体事实。",
		};
	}

	const dupIds = new Set<string>();
	const seen = new Set<string>();
	for (const q of questions) {
		if (!q.id) return { ok: false, reason: "每个问题都要有 id(如 S1) —— 追问和结论都靠它对应。" };
		if (seen.has(q.id)) dupIds.add(q.id);
		seen.add(q.id);
	}
	if (dupIds.size > 0) {
		return { ok: false, reason: `同一轮里 id 重复:${[...dupIds].join(" / ")}。` };
	}

	const noWhy = questions.filter((q) => !q.why).map((q) => q.id);
	if (noWhy.length > 0) {
		return {
			ok: false,
			reason:
				`这些问题没写清影响:${noWhy.join(" / ")}。` +
				"说明这个答案会改变计划里的什么(哪条 AC、哪个 verify 分支、任务怎么拆)。" +
				"改变不了计划的问题不值得花一路子 agent 去查。",
		};
	}

	const noAssume = questions.filter((q) => !q.assume).map((q) => q.id);
	if (noAssume.length > 0) {
		return {
			ok: false,
			reason:
				`这些问题没给当前假设(assume):${noAssume.join(" / ")}。` +
				"每个问题必须写下你现在假设答案是什么 —— 它是这一路超时时的兜底," +
				"而假设与结论的差值才是这次侦查真正买到的东西。" +
				"连假设都写不出的问题太笼统了,先把它拆成具体的事实问题。",
		};
	}

	// 查重:与前几轮问过的题目撞车,直接拒。原地打转的最常见形态就是换个措辞再问一遍。
	const askedNorm = new Map(input.asked.map((a) => [normText(a.text), a.id]));
	const dups = questions
		.map((q) => ({ q, hit: askedNorm.get(normText(q.text)) }))
		.filter((x) => x.hit)
		.map((x) => `${x.q.id}(与上一轮 ${x.hit} 实质相同)`);
	if (dups.length > 0) {
		return {
			ok: false,
			reason:
				`这些问题前面已经查过了:${dups.join(" / ")}。` +
				"上一轮的结论就在 State Card 里,直接用。若结论是'未查明'," +
				"那是子 agent 查不到 —— 换个措辞再问一遍不会有新答案,把它当作未知写进计划的风险项。",
		};
	}

	// 结账:第二轮起,每一问都必须挂在上一轮某个问题上。
	// 这与 evaluateAsk 的"settled 必须增长"、breaker 的"同签名连续计数"是同一个判据 ——
	// 这个循环是在收敛,还是在原地打转?挂不上的问题说明它与上一轮无关,
	// 那它本来就该在第一轮问,而不是用掉第二轮的额度。
	if (input.askedRounds > 0) {
		const askedIds = new Set(input.asked.map((a) => a.id));
		const stray = questions
			.filter((q) => !q.follows || !askedIds.has(q.follows))
			.map((q) => (q.follows ? `${q.id}(follows="${q.follows}" 不存在)` : `${q.id}(没给 follows)`));
		if (stray.length > 0) {
			return {
				ok: false,
				reason:
					`第 ${input.askedRounds + 1} 轮的每个问题都要用 follows 指明它追的是上一轮哪个问题:` +
					`${stray.join(" / ")}。可用的 id:${[...askedIds].join("、")}。` +
					"挂不上任何一条的问题,本来就该在第一轮问 —— 它不是上一轮答案打开的新问题。",
			};
		}
	}

	return { ok: true, questions };
}

/**
 * 纯函数:结论与假设是否实质不同(surprised)。
 *
 * 归一化后不相等即算不同 —— 宁可多报几条"有出入",也不能把"其实猜错了"
 * 显示成"假设已确认":后者会让 planner 更信任一个错假设,比没查更糟。
 */
export function isSurprise(assume: string, answer: string): boolean {
	const a = normText(assume);
	const b = normText(answer);
	if (!a || !b) return false;
	return !(b.includes(a) || a.includes(b));
}

/**
 * 未答成时的兜底结论。**answer 里必须带上假设** —— planner 要拿它继续规划,
 * 而一条空的"未查明"对它没有任何用处。
 */
export function unansweredFinding(q: ScoutQuestion, why: string): ScoutFinding {
	return {
		id: q.id,
		question: q.text,
		assume: q.assume,
		answer: `未查明(${why})。沿用假设:${q.assume}`,
		status: "unanswered",
		citations: [],
		surprised: false,
	};
}

/**
 * 纯函数:子 agent 交回来的东西算不算一条结论。
 *
 * **这是判定,所以在 core,不在 roles** —— 子 agent 说了不算,尤其是"有没有给出处"。
 * 三条降级规则,每条都对应一个具体的坏结局:
 *
 *   · 没调工具 / 空结论 / 载荷不是对象 → 未查明。
 *     沉默不能被当成"查过了没问题"(与 verifier 那条"没提交 verdict 不等于 pass"同源)。
 *   · 子 agent 自报 found=false → 未查明,但**保留它 answer 里"我查了哪里"**,
 *     那能省掉下一轮的重复劳动。
 *   · found=true 但 citations 为空 → 一律降级。没有出处的自然语言结论不可证伪,
 *     它对下游的唯一作用是让 planner 更自信地写错 AC。有没有给出处是机械可测的(I7),
 *     所以这条不交给模型自评置信度。
 */
export function interpretFinding(
	q: ScoutQuestion,
	submitted: unknown,
): { finding: ScoutFinding; failure?: string } {
	if (!submitted || typeof submitted !== "object") {
		const why = "没有调用 mission_finding";
		return { finding: unansweredFinding(q, why), failure: why };
	}
	const v = submitted as { found?: unknown; answer?: unknown; citations?: unknown };
	const answer = typeof v.answer === "string" ? v.answer.trim() : "";
	const citations = Array.isArray(v.citations) ? v.citations.map((c) => String(c).trim()).filter(Boolean) : [];
	if (!answer) {
		const why = "交回了空结论";
		return { finding: unansweredFinding(q, why), failure: why };
	}
	if (v.found !== true) {
		return {
			finding: {
				...unansweredFinding(q, "子 agent 报告未查到"),
				answer: `未查明:${answer}。沿用假设:${q.assume}`,
			},
		};
	}
	if (citations.length === 0) {
		const why = "结论没有出处";
		return {
			finding: {
				...unansweredFinding(q, why),
				answer: `未采信(无出处):${answer}。沿用假设:${q.assume}`,
			},
			failure: why,
		};
	}
	return {
		finding: {
			id: q.id,
			question: q.text,
			assume: q.assume,
			answer,
			status: "answered",
			citations,
			surprised: isSurprise(q.assume, answer),
		},
	};
}

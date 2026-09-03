/**
 * pi-missions · core/define
 *
 * DEFINE 相位的提问闸门。
 *
 * DEFINE 存在的理由:AC 必须在 PLAN 冻结,而需求模糊时根本写不出 AC ——
 * 系统的入口条件不成立。此时 agent 的行为是可预测的:它会编一条 AC 出来凑格式
 * ("AC1: 用户体验良好"),然后整套判定建立在一条假标准上。DEFINE 把"改问题定义"
 * (升级阶梯的 L3)提到最前面,先把目标问清楚再进 PLAN。
 *
 * 关于退出条件要诚实:DEFINE 的产出是一句话,不是可执行的东西,**没有**机械判据
 * 能证明"这个目标已经足够清楚"。真正的过滤器仍然在下游 —— PLAN 的 validatePlan、
 * 冻结基线,以及 core/coverage.ts 的完成条件覆盖校验。
 *
 * ── 为什么不是"一轮 3 个问题"了 ──
 *
 * 决策是有依赖的:"要不要独立服务"没定之前,"数据放哪张表"根本问不出来。
 * 一轮问答在结构上只能覆盖设计树的第一层,再深一层模型只能自己猜,
 * 而猜错的代价要到 L2/L3 才显现。
 *
 * 放宽轮次的前提是**把一轮的成本压下去**:每个问题强制带一个推荐答案,
 * 推荐项在问答页里选中高亮,人确认或改选即可,Esc 则整轮中断。
 * 没有推荐答案的问题是懒问题,直接拒绝。
 *
 * 放宽之后靠一条新判据收敛:**每一轮都要结账** —— 第 N+1 轮要求已落定的决策数
 * 严格增长,上一轮问完什么都没定下来就不给下一轮。这与 breaker.ts 数"同一失败
 * 签名连续出现"是同构的,只是把签名换成了"提问没有推进决策":两者都在回答同一个
 * 问题 —— 这个循环是在收敛,还是在原地打转?
 */

import type { Tier } from "./types.ts";

/** 一轮最多几个问题 */
export const DEFINE_QUESTION_CAP = 3;

/** 档位 → 提问轮次上限。quick 不进 DEFINE,给 0 */
const ROUND_CAP: Record<Tier, number> = { quick: 0, standard: 2, complex: 3 };

export function roundCapFor(tier: Tier): number {
	return ROUND_CAP[tier];
}

/** 一个选项:纯字符串(旧形状,无预览)或带 ASCII 示意图的对象 */
export type AskOption = string | { label: string; preview?: string };

/** 取选项的展示文案 —— 字符串即文案本身,对象取 label */
export function optionLabel(o: AskOption): string {
	return typeof o === "string" ? o : o.label;
}

/** 取选项的 ASCII 示意图(若有) */
export function optionPreview(o: AskOption): string | undefined {
	return typeof o === "string" ? undefined : o.preview?.trim() || undefined;
}

export interface AskQuestion {
	id: string;
	text: string;
	/** 可选项。给选项永远优于开放式提问;选项可带 ASCII 示意图,选中时在盒内下半区展示 */
	options?: AskOption[];
	/** 强制:你倾向的答案。人可以直接说"用你的",这是多轮付得起的前提 */
	recommend: string;
	/** 这个答案会改变什么(哪条完成条件、哪个方案分支) */
	impact: string;
}

export interface AskInput {
	tier: Tier;
	/** 本 mission 已经问过几轮 */
	askedRounds: number;
	/** 到本轮为止已经落定的决策 id */
	settled: string[];
	/** 上一轮提问时记下的 settled 快照 */
	prevSettled: string[];
	questions: AskQuestion[];
}

export type AskVerdict = { ok: true; questions: AskQuestion[] } | { ok: false; reason: string };

/** 人对单个问题的回答:选了某个选项 / 敲了自定义文本 / 什么都没选(回落推荐) */
export type AskAnswer =
	| { kind: "option"; value: string }
	| { kind: "custom"; value: string }
	| { kind: "none" };

/** 单个问题的 UI 答案规整成 (q, a) 对。纯函数:未答回落推荐答案,自由文本原样保留 */
export function normalizeAskAnswers(questions: AskQuestion[], answers: (AskAnswer | undefined)[]): {
	q: string;
	a: string;
	/** true = 人没作答,落到了推荐答案上 —— mission_define 的 resolved 靠这个字段区分"人确认"与"人没看" */
	fallback: boolean;
}[] {
	return questions.map((q, i) => {
		const ans = answers[i];
		if (!ans || ans.kind === "none") return { q: q.text, a: q.recommend, fallback: true };
		if (ans.kind === "option") {
			const label = ans.value.trim();
			// 推荐/同意类选项按"采用推荐"记,不把界面话术抄进 resolved
			if (label === q.recommend) return { q: q.text, a: q.recommend, fallback: false };
			return { q: q.text, a: label, fallback: false };
		}
		const text = ans.value.trim();
		if (!text) return { q: q.text, a: q.recommend, fallback: true };
		return { q: q.text, a: text, fallback: false };
	});
}

/** 去掉空白项;text/recommend/impact 一并 trim;选项的 label/preview 逐一 trim */
function normalizeOption(o: AskOption): AskOption | undefined {
	if (typeof o === "string") {
		const s = o.trim();
		return s || undefined;
	}
	const label = o.label?.trim();
	if (!label) return undefined;
	return { label, preview: o.preview?.trim() || undefined };
}

function normalize(questions: AskQuestion[]): AskQuestion[] {
	return questions
		.map((q) => ({
			...q,
			id: (q.id ?? "").trim(),
			text: (q.text ?? "").trim(),
			recommend: (q.recommend ?? "").trim(),
			impact: (q.impact ?? "").trim(),
			options: q.options?.map(normalizeOption).filter((o): o is AskOption => Boolean(o)),
		}))
		.filter((q) => q.text);
}

/**
 * 纯函数:这一轮提问是否放行。
 *
 * 四条规则,全部机械可测:
 *   1. 每个问题必须带推荐答案 —— 没有默认答案的问题是懒问题
 *   2. 一轮最多 DEFINE_QUESTION_CAP 个
 *   3. 轮次上限由档位定(standard 2 / complex 3)
 *   4. 结账:第二轮起,已落定的决策数必须比上一轮严格增长
 */
export function evaluateAsk(input: AskInput): AskVerdict {
	const questions = normalize(input.questions);
	const cap = roundCapFor(input.tier);

	if (cap === 0) {
		return { ok: false, reason: `${input.tier} 档不进 DEFINE 相位,没有提问环节。` };
	}
	if (questions.length === 0) {
		return { ok: false, reason: "没有实际问题。不需要提问就直接调用 mission_define。" };
	}
	if (questions.length > DEFINE_QUESTION_CAP) {
		return {
			ok: false,
			reason:
				`一轮最多 ${DEFINE_QUESTION_CAP} 个问题,你给了 ${questions.length} 个。` +
				"挑出真正'不知道就写不出验收标准'的那几个,剩下的等这一轮的回答落定之后再问。",
		};
	}

	const missing = questions.filter((q) => !q.recommend).map((q) => q.id || q.text);
	if (missing.length > 0) {
		return {
			ok: false,
			reason:
				`这些问题没有给推荐答案:${missing.join(" / ")}。` +
				"每个问题必须带一个你倾向的答案 —— 推荐答案会被选中高亮,人只需确认或改选;" +
				"你连倾向都没有,说明这个问题你自己还没想过。",
		};
	}
	// 给了选项就必须让 recommend 命中其中一项。
	// UI 靠 label === recommend 找出推荐行并默认选中它;对不上时旧实现**静默**回落到
	// 第 0 项 —— 人看到的高亮不是模型推荐的那个,而没有任何地方提示这件事。
	// 静默回落比报错糟得多,所以在 L0 拦下来让模型自己改。
	const strayRecommend = questions
		.filter((q) => q.options?.length && !q.options.some((o) => optionLabel(o) === q.recommend))
		.map((q) => `${q.id || q.text}(recommend="${q.recommend}")`);
	if (strayRecommend.length > 0) {
		return {
			ok: false,
			reason:
				`这些问题的 recommend 不在 options 里:${strayRecommend.join(" / ")}。` +
				"给了选项时,recommend 必须与其中一项**逐字相同** —— 界面靠它标出推荐并默认选中。" +
				"另外别在选项文案里写「(推荐)」之类的字样,界面会自己标。",
		};
	}

	const noImpact = questions.filter((q) => !q.impact).map((q) => q.id || q.text);
	if (noImpact.length > 0) {
		return {
			ok: false,
			reason:
				`这些问题没有写清影响:${noImpact.join(" / ")}。` +
				"说明这个答案会改变哪条完成条件或哪个方案分支;改变不了任何东西的问题不该问。",
		};
	}

	if (input.askedRounds >= cap) {
		return {
			ok: false,
			reason:
				`${input.tier} 档的提问轮次已经用完(上限 ${cap} 轮)。` +
				"根据已有回答调用 mission_define 定义问题;若信息仍然不足以定义,直接说明缺什么,由人重新描述需求。",
		};
	}

	if (input.askedRounds > 0 && input.settled.length <= input.prevSettled.length) {
		return {
			ok: false,
			reason:
				`上一轮问完之后没有任何决策落定(settled 仍是 ${input.settled.length} 条)。` +
				"继续追问只会更糟:先把已有回答收敛成结论再问下一轮,或者直接说明缺什么、由人重新描述需求。",
		};
	}

	return { ok: true, questions };
}

/**
 * 纯函数:DEFINE 交定义之前要不要人工确认范围。
 *
 * complex 恒确认(它要展开里程碑,范围错了代价最大);
 * standard 只在**真的有过歧义**时确认(问过至少一轮);
 * quick 不进 DEFINE。
 */
export function needsScopeConfirm(tier: Tier, defineAsks: number): boolean {
	if (tier === "complex") return true;
	if (tier === "standard") return defineAsks > 0;
	return false;
}

/**
 * pi-missions · core/criterion
 *
 * quick 档判定依据的闸门。
 *
 * quick 不问人:开工前多一次交互,小任务就不值得开 mission 了。判据由 AI 看过
 * 代码之后自己定 —— 这不违反任何不变量,**判据的提出者和判据的核对者是两回事**:
 * standard 的 AC 本来也是 planner(LLM)写的,I3 管的是核对权在执行者之外。
 *
 * 但没人把关的判据会烂成"样式正确显示"这种,verifier 拿它核对等于没核对 ——
 * 于是判据必须过一道机械闸门,和 core/define.ts 拒绝"没有推荐答案的懒问题"
 * 是同一个动作:L0 不判断内容对不对,只拒绝**结构上就不可能判真假**的东西。
 *
 * 三条规则都是机械可测的。刻意不做语义判断 —— 那需要模型,而让模型判断
 * 模型自己写的判据够不够格,就又回到自评了。
 */

/** 判据太短就不可能说清一个可观察的状态 */
const MIN_LENGTH = 8;

/**
 * 空泛词。命中这些词而又给不出任何具体锚点的判据,核对时只能靠感觉,
 * 等于把判定权还给了模型的印象。
 */
const VAGUE = [
	"正确",
	"正常",
	"良好",
	"符合预期",
	"没有问题",
	"无问题",
	"更好",
	"优化了",
	"生效",
	"可用",
	"完善",
	"合理",
	"友好",
	"works",
	"correct",
	"properly",
	"as expected",
];

/**
 * 具体锚点:数字、引号里的字面量、**看起来像代码**的标识符
 * (含 . _ - 分隔、驼峰、或连续大写:`media.query` `navBar` `HTTP`)。
 *
 * 刻意**不**把任意 ASCII 单词算作锚点:那样 "it works properly" 里的 works
 * 自己就成了锚点,英文判据的空泛检查会整个失效(踩过)。
 *
 * 反过来也不能要求"必须有锚点" —— 中文判据常常一个 ASCII 都没有
 * (「窄屏下导航折叠成汉堡菜单」),那会误杀大量正常判据。锚点只用来**赦免**
 * 空泛词:「HTTP 200 正确返回」有 200,是具体的;「样式正确显示」没有,就不是。
 */
const ANCHOR = /\d|[「『"'`][^」』"'`]+[」』"'`]|[A-Za-z][A-Za-z0-9]*[._\-][A-Za-z0-9]|[a-z][A-Z]|[A-Z]{2,}/;

export interface CriterionInput {
	/** mission 目标原文。用来拦"把目标复读一遍当判据" */
	goal: string;
	text: string;
}

export type CriterionVerdict = { ok: true; text: string } | { ok: false; reason: string };

/** 归一化后比较用:去掉空白与常见标点,避免"多个句号"就骗过复读检测 */
function squash(s: string): string {
	return s.replace(/[\s，。,.;;：:!!??、"'「」『』`]/g, "").toLowerCase();
}

/**
 * 纯函数:这条判据能不能当 quick 的判定依据。
 *
 *   1. 太短 —— 说不清一个可观察的状态
 *   2. 就是目标的复读 —— 目标说"要做什么",判据说"做完之后能观察到什么",
 *      两者同形意味着根本没有转写,CHECK 时无从判真假
 *   3. 空泛且无锚点 —— 核对时只能靠印象
 */
export function evaluateCriterion(input: CriterionInput): CriterionVerdict {
	const text = (input.text ?? "").trim();

	if (text.length < MIN_LENGTH) {
		return {
			ok: false,
			reason:
				`判据太短(${text.length} 字)。写清楚"做完之后能观察到什么" —— ` +
				"具体到哪个界面/接口/文件上的什么表现,而不是一个形容词。",
		};
	}

	if (squash(text) === squash(input.goal)) {
		return {
			ok: false,
			reason:
				"判据不能是目标的复读。目标说的是**要做什么**,判据说的是**做完之后能观察到什么** —— " +
				`把「${input.goal}」转写成一句能判真假的话,比如把祈使句改成可观察的状态。`,
		};
	}

	const hit = VAGUE.find((w) => text.toLowerCase().includes(w));
	if (hit && !ANCHOR.test(text)) {
		return {
			ok: false,
			reason:
				`判据里的「${hit}」没有任何具体锚点,核对时只能靠印象。` +
				"补上具体的东西:数字(断点/状态码/条数)、标识符(函数名/CSS 属性/文件名),或者直接描述可观察的行为。",
		};
	}

	return { ok: true, text };
}

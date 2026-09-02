/**
 * pi-missions · 相位提示词的选取
 *
 * `before_agent_start` 每一轮往系统提示里塞一段"当前相位怎么做"。它原来只看
 * `phase`,不看这个 mission 用的是哪套判定装置 —— 于是 quick 在跑过 standard
 * mission 的仓库里,读到的是**别人**留下的 `missions/phases/*.md`:
 *
 *   · PLAN 相位读到 plan.md,整篇在讲 mission_write_plan / AC 映射 verify.sh 分支 /
 *     covers / 方案 approach / 冻结基线 —— 而 quick 在 PLAN 的工具集是
 *     [只读 + mission_criterion],`mission_write_plan` 根本不在里面。提示词让它
 *     调一个闸门里没有的工具,一个字没提 mission_criterion。
 *   · DO 相位读到 do.md,末尾「提交前自检」写着"按 State Card 给出的路径跑一遍
 *     verify.sh <分支>"。quick 没有 verify.sh,State Card 里也没有那个路径。
 *   · ACT 相位读到 act.md,让它去读 LOG.md(quick 不落盘,没有),并把
 *     mission_escalate --level=2 当作正路 —— 而 quick 的 L2 落点(回 PLAN 改方案)
 *     是空的,它只有一条判据,改判据正是 I2/I3 要禁的事。
 *
 * 讽刺的地方是:quick 声称不落盘、不铺脚手架,却在消费脚手架 —— 而且必然是
 * 别的 mission 铺的。干净仓库里走兜底常量,脏仓库里走磁盘,行为还不一致。
 *
 * 所以这里按**判定装置**选,不按档位名(见 phasePromptFlavor 的注释)。
 */

import * as fs from "node:fs";
import * as path from "node:path";

import type { Phase, Tier } from "./core/types.ts";

export type PromptFlavor = "quick" | "standard";

/**
 * 纯函数:这一轮该用哪套相位提示词。
 *
 * 关键是别用 `tier === "quick"` 一刀切 —— 档位会在中途变,而提示词该跟着
 * **判定装置**走,不是跟着档位名走:
 *
 *   · PLAN 相位看档位。quick 的 PLAN 只产出一条判据,standard 的 PLAN 产出
 *     一整套 AC + verify.sh,两者要说的话完全不同。
 *   · 其余相位看**有没有冻结的 AC**。quick 第一次没过、走完 ACT 之后,
 *     `evaluatePromotion` 会发 PROMOTE_TIER 把档位抬成 standard,但**相位不变、
 *     判据不变**(见 machine.ts 的 PROMOTE_TIER:它只改 tier 和落盘)——
 *     此刻 tier 已经是 standard 而 verify.sh 依然不存在。按档位选就又错了。
 *     熔断那条升档路(failTransition 的 promote 分支)会回到 PLAN 重写计划,
 *     写完 AC 就不为 0,自然切回 standard 提示词。
 *   · DEFINE 没有 quick 版本 —— quick 从不经过它(START_PHASE.quick = "plan");
 *     真被 L3 送进 DEFINE 时,要做的事和 standard 一样。
 */
export function phasePromptFlavor(input: { tier: Tier; phase: Phase; frozenAcCount: number }): PromptFlavor {
	if (input.phase === "define") return "standard";
	if (input.phase === "plan") return input.tier === "quick" ? "quick" : "standard";
	return input.frozenAcCount === 0 ? "quick" : "standard";
}

/**
 * quick 的相位提示词。**内联,不读 missions/phases/**:quick 不铺脚手架,
 * 读到的一定是别的 mission 留下的;而且这几条本来就短,不值得让人去改。
 */
export const QUICK_PHASE_RULES: Record<string, string> = {
	plan: [
		"你在 PLAN 相位(quick 档)。这一相位只做一件事:定出这次任务的**判定依据**。",
		"",
		"1. 先用只读工具看几眼相关代码 —— 没看过代码的判据只会是「样式正确显示」这种,核对时等于没有判据。",
		"2. 调用 `mission_criterion` 交一条判据。判据是「做完之后能观察到什么」,不是「要做什么」:",
		"   照抄目标会被直接退回,太短、或空泛而没有具体锚点(数字 / 标识符 / 引号里的字面量)的也会。",
		"3. `judge` 选谁来核对:`ai`(默认,独立验证者读 diff 逐条核对,绝大多数用它);",
		"   `human`(真机、视觉、交互 —— 你读 diff 判不了的,做完由人终审);",
		"   `command`(有现成命令能判,退出码即判定,最省也最可重放)。",
		"   判自己核实不了的东西要如实选 `human` —— 硬判一个自己看不到的判据,等于把判定权还给了自己。",
		"",
		"判据冻结后自动进入 DO,写工具才会解锁 —— 现在写不了代码是设计,不是故障。",
		"这一档**没有 AC 清单、没有 verify.sh、没有 mission_write_plan**,别去找它们,",
		"也别照着 `missions/` 里别的 mission 留下的脚手架做事。",
	].join("\n"),

	do: [
		"你在 DO 相位(quick 档)。判定依据已经冻结在 State Card 的 `quick:` 那一行,",
		"谁来核对写在它下面一行 —— 照那条做,不要另立标准。",
		"",
		"1. 实现它。这一档只有这一个任务。",
		"2. 有 PREV FAILURE 就先弄明白上次为什么没过再动手 —— 同一思路换汤不换药会触发熔断。",
		"3. 做完调用 `mission_submit`(不接受任何参数)。提交不等于通过,判定由系统执行,不要自己宣布完成。",
		"",
		"这一档**没有 verify.sh、没有 AC 清单、没有 MISSION.md** —— 别去 `missions/` 找它们,",
		"那里若有东西也是别的 mission 留下的。想自查就直接跑这个项目本身的命令(构建 / 测试 / lint),",
		"但那只是自查,不是判定,也不必写成报告 —— 核对方看的是 diff 和上面那条判据。",
		"提交之后不要继续改代码(写工具会被闸门拦住)。",
	].join("\n"),

	check: "你在 CHECK 相位(quick 档):判定由系统执行 —— 按冻结判据的 judge 走独立验证者、人工终审或命令退出码。你不需要做任何事,也不要自行宣布通过。",

	act: [
		"你在 ACT 相位(quick 档)。上一轮判定没过,原因在 State Card 的 PREV FAILURE 里 —— 先读懂它。",
		"",
		"**你只有这一轮,而且不能写代码。** 产出是一段诊断:上一轮为什么没过、下一轮具体改哪里",
		"(哪个文件、哪一处、改成什么表现)。「再试一次」不是诊断。",
		"",
		"这一轮结束后系统会自动把档位抬到 standard:判据不变、任务不变,变的是重试额度和熔断阈值放宽。",
		"这是设计好的出口,不是故障,你不需要做任何事来触发它。",
		"**不要调用 `mission_escalate`** —— quick 没有「方案」可改,它只有一条判据,",
		"而改判据正是提交后修改判定标准,系统会拦。",
	].join("\n"),
};

/** standard/complex 的兜底(仓库里的 missions/phases/*.md 被删时用) */
export const FALLBACK_PHASE_RULES: Record<string, string> = {
	define:
		"你在 DEFINE 相位:只做问题定义。读代码;仍有影响完成条件的模糊就调用 mission_ask(一轮最多 3 个问题,每个必须带推荐答案;standard 2 轮、complex 3 轮)—— 会弹出交互问答页,回答直接出现在工具结果里;清楚了就调用 mission_define 交出目标、完成条件(doneWhen)与边界,问答记录原样带进 resolved。不写代码,不设计方案。",
	plan: '你在 PLAN 相位:只读分析 + 调用 mission_write_plan 提交计划(方案 approach 在 complex 档必填;每条 AC 必须声明 covers,把 DEFINE 的完成条件逐条覆盖)。不写实现代码。人会在计划评审页逐段读它,可以打回并写意见。每条 AC 冻结时会被跑一遍核对基线(默认必须是红的,回归项显式声明 baseline: "green")。',
	do: "你在 DO 相位:只完成 State Card 里的当前任务,完成后调用 mission_submit,不要自行判定通过。",
	check: "你在 CHECK 相位:判定由系统执行,你不需要做任何事。",
	act: "你在 ACT 相位:分析上一轮失败,给出修法或调用 mission_escalate。只有一轮,不能写代码。",
};

/**
 * 这一轮要注入的相位提示词。
 *
 * quick 味道的走内联常量,**完全不碰 phasesDir** —— quick 不铺脚手架,那个目录
 * 里若有东西必然是别的 mission 留下的。读盘反而让行为在干净仓库(走兜底)和
 * 跑过 standard 的仓库(走磁盘)之间分叉,而后者恰恰是出事的那个。
 */
export function phasePromptFor(input: {
	phasesDir: string;
	phase: Phase;
	tier: Tier;
	frozenAcCount: number;
}): string {
	const { phase } = input;
	if (phasePromptFlavor(input) === "quick") {
		const quick = QUICK_PHASE_RULES[phase];
		if (quick) return quick;
	}
	try {
		const file = path.join(input.phasesDir, `${phase}.md`);
		if (fs.existsSync(file)) return fs.readFileSync(file, "utf8");
	} catch {
		/* 读不到就走兜底 */
	}
	return FALLBACK_PHASE_RULES[phase] ?? "";
}

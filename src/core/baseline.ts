/**
 * pi-missions · core/baseline
 *
 * 冻结时的基线判定。
 *
 * validatePlan 只能证明"AC 指向的 verify 分支存在",证明不了它有判别力 ——
 * `ac1) exit 0 ;;` 是一个完全合法的分支。基线跑补上这一刀:冻结前把每条 AC
 * 的分支跑一遍,要求它**现在是红的**。红→绿才构成证据;一上来就绿的分支
 * 要么是空壳,要么说明这条 AC 已经满足、根本不该进这个 mission。
 *
 * 例外是回归型 AC("现有测试不许挂"),它天然一开始就绿。这类必须显式声明
 * baseline: "green",于是"我忘了写实现"和"我声明这是回归项"在机器眼里可区分。
 *
 * 反向作弊(把分支写成恒 exit 1)骗得过基线,但骗不过后面的循环:任务永远
 * 绿不了,熔断会把它推到停机。代价落在作弊者自己身上,这是刻意的不对称。
 */

export type Baseline = "red" | "green";

/**
 * 基线只在 mission 的**首次**冻结跑。
 *
 * L2/L3 重规划时执行者已经改过世界了:先前的红可能因为部分任务做完而变绿,
 * 此时再要求"每条 red AC 必须是红的"会把重规划直接锁死 —— 而 L2 的定义就是
 * AC 不变、只改方案,planner 连改 AC 脱身的余地都没有。
 *
 * 换句话说:冻结时刻的红绿只在干净基线上是可判定的信号,重规划时不是。
 */
export function shouldProbeBaseline(escalations: number): boolean {
	return escalations === 0;
}

/** 一条 AC 在冻结时刻的基线探针结果 */
export interface BaselineProbe {
	acId: string;
	/** verify.sh 的分支名 */
	verify: string;
	/** 声明的基线色(AC 未声明时调用方填 "red") */
	expected: Baseline;
	/** 实际退出码 */
	exitCode: number;
	/**
	 * 分支的输出尾巴(stderr 优先)。**只有判定不符预期时才会被印出来。**
	 *
	 * 这里原来什么都不带,于是打回信息只说得出"AC3 声明 green 但它现在是红的",
	 * 说不出**为什么**红 —— 而那份输出系统跑分支时本来就抓在手里,顺手丢掉了。
	 * 真机代价:同一条打回原样重复三次,planner 只能猜着改 verify.sh,
	 * 中间还去 read/grep 了一轮。给它看一眼报错,这是一次就能定位的事。
	 */
	output?: string;
}

/** 打回信息里带多少输出。够定位一个编译错或一条测试失败,又不至于灌满上下文 */
export const BASELINE_OUTPUT_TAIL = 600;

/** 取输出尾巴 —— 报错通常在最后(编译错、go test 的 FAIL 汇总、断言 diff) */
export function tailOutput(text: string, limit = BASELINE_OUTPUT_TAIL): string {
	const t = text.trimEnd();
	if (t.length <= limit) return t;
	return `…(前面省略)\n${t.slice(-limit)}`;
}

/** 退出码 → 基线色。非零即红 */
export function baselineOf(exitCode: number): Baseline {
	return exitCode === 0 ? "green" : "red";
}

/**
 * 纯函数:校验一组基线探针。返回错误信息数组,空数组 = 通过。
 *
 * 三条规则:
 *   1. 分支必须真的跑起来了(126/127 = 不可执行/找不到,不算"红")
 *   2. 每条 AC 的实际基线必须与声明一致
 *   3. 至少要有一条 red —— 全是回归项的 mission 不产出任何新东西
 */
export function evaluateBaseline(probes: BaselineProbe[]): string[] {
	const errors: string[] = [];
	if (probes.length === 0) return ["没有可跑的验收基线(至少需要一条 AC)"];

	for (const p of probes) {
		if (p.exitCode === 126 || p.exitCode === 127) {
			errors.push(
				`${p.acId} 的分支 "${p.verify}" 无法执行(exit=${p.exitCode})—— ` +
					"verify.sh 不可执行或分支里调用了不存在的命令,这不算基线为红",
			);
			continue;
		}
		const actual = baselineOf(p.exitCode);
		if (actual === p.expected) continue;
		// 符合预期的分支不印输出:红得对的那些每条都会有一大段报错,那是噪音不是线索
		const detail = p.output?.trim() ? `\n分支输出:\n${tailOutput(p.output)}` : "";

		if (p.expected === "red") {
			errors.push(
				`${p.acId} 的分支 "${p.verify}" 在动手之前就已经通过(exit=0)。` +
					"要么这条 AC 是空壳(如 `exit 0`),要么它已经满足、不该进这个 mission;" +
					'确实是回归项就显式声明 baseline: "green"' +
					detail,
			);
		} else {
			errors.push(
				`${p.acId} 声明了 baseline: "green"(回归项),但它现在就是红的(exit=${p.exitCode})。` +
					"基线已经坏了,先修好再冻结,否则无法区分是你改坏的还是本来就坏的" +
					detail,
			);
		}
	}

	if (!errors.length && !probes.some((p) => p.expected === "red")) {
		errors.push('所有 AC 的基线都是 "green":这个 mission 不产出任何可验证的新东西,至少需要一条 red');
	}
	return errors;
}

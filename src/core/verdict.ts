/**
 * pi-missions · core/verdict
 *
 * 把一组证据判定为 pass / fail / inconclusive。
 * 这是 I3(判定权外置)与 I9(环境不一致判 inconclusive)的实现。
 *
 * 判定优先级(自上而下,命中即返回):
 *   0. 无证据                        → inconclusive  ← 防止"没跑就算过"
 *   1. 环境指纹不符                  → inconclusive  ← I9,不计入熔断
 *   2. 任一证据 inconclusive         → inconclusive
 *   3. 任一 hard fail                → fail
 *   4. 必需 AC 缺少证据              → inconclusive  ← 防止漏跑当通过
 *   5. 任一 semi fail                → fail
 *   6. 只有 soft 证据                → inconclusive  ← I3,soft 不能触发 pass
 *   7. 其余                          → pass
 */

import type { Evidence, Verdict } from "./types.ts";
import { failureSignature } from "./breaker.ts";

export interface JudgeOptions {
  /** Plan 冻结时记录的环境指纹。传入则逐条比对 */
  expectedFingerprint?: string | null;
  /** 本次必须被覆盖的 AC id 列表。缺一条即 inconclusive */
  requiredAcIds?: string[];
}

export function judge(evidences: Evidence[], options: JudgeOptions = {}): Verdict {
  const { expectedFingerprint = null, requiredAcIds = [] } = options;

  // 0. 无证据不等于通过
  if (evidences.length === 0) {
    return {
      outcome: "inconclusive",
      failing: [],
      reason: "未采集到任何证据,无法判定",
    };
  }

  // 1. 环境漂移优先于一切。判 fail 会导致 agent 去改代码,而病根在环境。
  if (expectedFingerprint) {
    const drifted = evidences.filter(
      (e) => e.envFingerprint && e.envFingerprint !== expectedFingerprint,
    );
    if (drifted.length > 0) {
      return {
        outcome: "inconclusive",
        failing: drifted,
        reason:
          `环境指纹不符(期望 ${short(expectedFingerprint)},` +
          `实际 ${short(drifted[0].envFingerprint!)}),不计入熔断`,
      };
    }
  }

  // 2. 证据本身无结论
  const undecided = evidences.filter((e) => e.result === "inconclusive");
  if (undecided.length > 0) {
    return {
      outcome: "inconclusive",
      failing: undecided,
      reason: `${undecided.map((e) => e.acId).join(", ")} 无结论`,
    };
  }

  // 3. hard 失败:最强证据,无视其余
  const hardFail = evidences.filter((e) => e.level === "hard" && e.result === "fail");
  if (hardFail.length > 0) {
    return {
      outcome: "fail",
      signature: failureSignature(hardFail),
      failing: hardFail,
      reason: `hard 证据失败:${hardFail.map((e) => e.acId).join(", ")}`,
    };
  }

  // 4. 必需 AC 未被覆盖 —— 漏跑不能算通过
  const covered = new Set(evidences.map((e) => e.acId));
  const missing = requiredAcIds.filter((id) => !covered.has(id));
  if (missing.length > 0) {
    return {
      outcome: "inconclusive",
      failing: [],
      reason: `缺少验收证据:${missing.join(", ")}`,
    };
  }

  // 5. semi 失败
  const semiFail = evidences.filter((e) => e.level === "semi" && e.result === "fail");
  if (semiFail.length > 0) {
    return {
      outcome: "fail",
      signature: failureSignature(semiFail),
      failing: semiFail,
      reason: `AC 核对未通过:${semiFail.map((e) => e.acId).join(", ")}`,
    };
  }

  // 6. soft 单独不足以判定通过(I3)
  const hasObjective = evidences.some((e) => e.level === "hard" || e.level === "semi");
  if (!hasObjective) {
    return {
      outcome: "inconclusive",
      failing: [],
      reason: "仅有执行者自述,缺少客观证据",
    };
  }

  // 7. 通过
  return {
    outcome: "pass",
    failing: [],
    reason: `全部通过(${evidences.filter((e) => e.level !== "soft").length} 项客观证据)`,
  };
}

function short(fp: string): string {
  return fp.length > 14 ? `${fp.slice(0, 14)}…` : fp;
}

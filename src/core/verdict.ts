/**
 * pi-missions · core/verdict
 *
 * 把一组证据判定为 pass / fail / inconclusive。
 * 这是 I3(判定权外置)与 I9(环境不一致判 inconclusive)的实现。
 *
 * 判定优先级(自上而下,命中即返回):
 *   0. 无证据                        → inconclusive  ← 防止"没跑就算过"
 *   1. 环境指纹不符                  → inconclusive  ← I9,不计入熔断
 *   2. 必需范围内的证据 inconclusive  → inconclusive  ← 范围外 AC 的无结论只是信息
 *   3. 任一 hard fail                → fail
 *   4. 必需 AC 缺少证据              → inconclusive  ← 防止漏跑当通过
 *   5. 任一 semi/human fail          → fail
 *   6. 只有 soft 证据                → inconclusive  ← I3,soft 不能触发 pass
 *   7. 其余                          → pass
 *
 * 最后再过一道 judgeUnavailable:裁判本身坏掉时,把"缺证据"改判成"裁判不可用"
 * (cause=judge)。成因不同,处置也不同 —— 见 types.ts 的 InconclusiveCause。
 */

import type { Evidence, Verdict } from "./types.ts";
import { failureSignature } from "./breaker.ts";

export interface JudgeOptions {
  /** Plan 冻结时记录的环境指纹。传入则逐条比对 */
  expectedFingerprint?: string | null;
  /** 本次必须被覆盖的 AC id 列表。缺一条即 inconclusive */
  requiredAcIds?: string[];
  /**
   * 裁判本身不可用时的原因(核验模型报错、人工终审弹不出来)。
   * 传了也不会让判定变严:hard 证据够判 pass 就照样 pass —— 降级 hard-only 是设计。
   * 它只改写"因为缺证据而无结论"那一类的成因,让停机文案指向真正该修的东西。
   */
  judgeUnavailable?: string | null;
}

export function judge(evidences: Evidence[], options: JudgeOptions = {}): Verdict {
  const verdict = judgeEvidences(evidences, options);
  const unavailable = options.judgeUnavailable?.trim();
  // 裁判坏了却还判"缺证据",会把执行者支去补一份它永远补不出来的证据
  // (真实事故:verifier 模型 400,连着三轮判 evidence 无结论,提示写的是"环境可能漂移")。
  if (unavailable && verdict.outcome === "inconclusive" && verdict.inconclusiveCause === "evidence") {
    return {
      ...verdict,
      inconclusiveCause: "judge",
      reason: `裁判不可用:${unavailable}(本轮证据:${verdict.reason})`,
    };
  }
  return verdict;
}

function judgeEvidences(evidences: Evidence[], options: JudgeOptions): Verdict {
  const { expectedFingerprint = null, requiredAcIds = [] } = options;

  // 0. 无证据不等于通过
  if (evidences.length === 0) {
    return {
      outcome: "inconclusive",
      failing: [],
      reason: "未采集到任何证据,无法判定",
      inconclusiveCause: "evidence",
      missingAcIds: requiredAcIds.length > 0 ? requiredAcIds : undefined,
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
        inconclusiveCause: "env",
      };
    }
  }

  // 2. 证据本身无结论 —— 只在本次判定的必需范围(requiredAcIds)内阻断。
  //    CHECK 按任务收集证据:挂在后续任务的 AC(典型:lint/build 回归项)没有
  //    命令输出可核对,只读的 verifier 永远判不出结论 —— 若让范围外的无结论阻断,
  //    当前任务无论写得多好都过不了 CHECK,三次空转后熔断(真实事故 ×2)。
  //    范围外的 semi fail 仍由规则 5 阻断(改坏了别人的回归项当然要拦)。
  const scope = requiredAcIds.length > 0 ? new Set(requiredAcIds) : null;
  const undecided = evidences.filter(
    (e) => e.result === "inconclusive" && (!scope || scope.has(e.acId)),
  );
  if (undecided.length > 0) {
    const undecidedAcIds = undecided.map((e) => e.acId);
    return {
      outcome: "inconclusive",
      failing: undecided,
      reason: `${undecidedAcIds.join(", ")} 无结论`,
      inconclusiveCause: "evidence",
      missingAcIds: undecidedAcIds,
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
      inconclusiveCause: "evidence",
      missingAcIds: missing,
    };
  }

  // 5. semi / human 失败。人工终审与模型核验同级:两者都在执行者之外(I3),
  //    区别只在可重放性,不在权威性 —— 人说不行就是不行。
  const judgedFail = evidences.filter(
    (e) => (e.level === "semi" || e.level === "human") && e.result === "fail",
  );
  if (judgedFail.length > 0) {
    // 理由必须带进 reason,不能只报 acId。reason 会成为 task.lastFailureReason,
    // 而那是失败信息**进入模型上下文的唯一通道**(verdict 卡片只给 TUI 看,
    // 见 index.ts 的 registerEntryRenderer 注释)。
    //
    // hard 证据丢了理由还能补救 —— 执行者在 DO 相位有 bash,自己重跑一遍就看到了。
    // semi/human 不行:裁判写的那句话是不可重现的,丢了就等于让 ACT 相位的
    // escalator 蒙着眼睛想修法(它只有只读工具)。
    return {
      outcome: "fail",
      signature: failureSignature(judgedFail),
      failing: judgedFail,
      reason: `AC 核对未通过:${judgedFail
        .map((e) => `${e.acId} —— ${oneLine(e.raw, 300)}`)
        .join(";")}`,
    };
  }

  // 6. soft 单独不足以判定通过(I3)
  const hasObjective = evidences.some((e) => e.level !== "soft");
  if (!hasObjective) {
    return {
      outcome: "inconclusive",
      failing: [],
      reason: "仅有执行者自述,缺少客观证据",
      inconclusiveCause: "evidence",
      missingAcIds: requiredAcIds.length > 0 ? requiredAcIds : undefined,
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

/** 裁判理由压成一行带进 reason。截断只发生在超长的 verifier 论述上 */
function oneLine(raw: string, max: number): string {
  const s = (raw ?? "").replace(/\s+/g, " ").trim();
  if (!s) return "(未说明原因)";
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

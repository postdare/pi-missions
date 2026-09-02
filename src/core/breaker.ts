/**
 * pi-missions · core/breaker
 *
 * I4 的实现:同一问题连续失败必须升级,不得继续微调。
 *
 * Agent 最典型的失败模式不是能力不够,而是在一个错误的方案上反复微调,
 * 而且每次都显得快成了。没有熔断,双层循环会退化成单层死循环。
 *
 * 全文件最需要按实际数据调的是 normalize():
 *   归一化太严 → 同一病根算作不同失败,熔断永不触发
 *   归一化太松 → 不同问题被合并,误熔断
 * 起步策略:只保留测试标识 + 异常类型 + 断言种类,丢弃行号、堆栈、路径、耗时。
 */

import { createHash } from "node:crypto";
import type { Evidence, EscalationLevel, Tier, TaskState } from "./types.ts";

// ─────────────────────────── 阈值 ───────────────────────────

/** 同一签名连续出现多少次触发升级 */
const THRESHOLD: Record<Tier, number> = {
  quick: 2,
  standard: 3,
  complex: 3,
};

/** 单任务尝试次数硬上限。即使签名一直在变也不允许无限试 */
const ATTEMPT_HARD_CAP: Record<Tier, number> = {
  quick: 4,
  standard: 9,
  complex: 12,
};

export function thresholdFor(tier: Tier): number {
  return THRESHOLD[tier];
}

/**
 * 「再失败一次就要升级」—— 熔断临界。UI 靠它决定是否换成警告色,
 * 但这是"升不升"的判定,归 L0 管:阈值语义(含 `-1`)只允许在这里写一次。
 */
export function nearThreshold(task: TaskState | undefined, tier: Tier): boolean {
  if (!task || task.sameSignatureCount <= 0) return false;
  return task.sameSignatureCount >= thresholdFor(tier) - 1;
}

// ─────────────────────────── 归一化 ───────────────────────────

/** Java/JUnit 测试标识:AuthIntegrationTest#refreshToken 或 FooTest.bar */
const TEST_ID = /\b([A-Z]\w*(?:Test|Tests|IT|ITCase|Spec))\s*[.#]\s*([a-zA-Z_]\w*)/g;
/** 异常与错误类型 */
const THROWABLE = /\b([A-Z]\w*(?:Exception|Error|Throwable|Failure))\b/g;
/**
 * 断言种类。只保留"种类",不保留期望值/实际值。
 * 把 expected:<401> 与 expected:<500> 归为同一签名是刻意的:
 * 签名过细会导致同一病根算作不同失败,熔断永不触发 —— 那是更糟的失败模式。
 */
const ASSERTION_KINDS: Array<[RegExp, string]> = [
  [/expected[\s\S]{0,80}?but\s+was/i, "expected-but-was"],
  [/assert(?:Equals|Same)/, "assert-equals"],
  [/assert(?:True|False)/, "assert-boolean"],
  [/assert(?:NotNull|Null)/, "assert-null"],
  [/assertThrows/, "assert-throws"],
  [/\bto(?:Be|Equal|Match)\b/, "expect-to-be"],
  [/should\s+(?:be|equal|have)/i, "should-be"],
];
/** 源文件后缀。必须剥掉,否则 Foo.java 会被当成 类Foo#方法java */
const SOURCE_EXT = /\.(java|kt|kts|scala|groovy|ts|tsx|js|jsx|mjs|cjs|go|py|rb|cs)\b/gi;
/** 编译/类型错误码,如 TS2345、error: cannot find symbol */
const DIAG_CODE = /\b(TS\d{4}|error:\s*[a-z ]{4,40})/gi;

/**
 * 把原始失败输出压成一个稳定的规范串。
 *
 * 丢弃:行号、列号、绝对路径、时间戳、耗时、对象 hash、十六进制地址、
 *       线程名、随机 id、以及一切每次运行都会变的东西。
 */
export function normalize(raw: string): string {
  let s = raw;

  // 抹掉高熵噪声
  s = s.replace(/0x[0-9a-fA-F]+/g, "");
  s = s.replace(/@[0-9a-fA-F]{6,}/g, "");
  s = s.replace(/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?/g, "");
  s = s.replace(/\b\d+(\.\d+)?\s*(ms|s|sec|seconds|分钟|秒)\b/gi, "");
  s = s.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "");
  // 路径只留 basename,再去掉 :行号:列号
  s = s.replace(/(?:[A-Za-z]:)?[\\/][\w.\-\\/]+[\\/]([\w.\-]+)/g, "$1");
  s = s.replace(/:\d+(:\d+)?\b/g, "");
  // 必须在抽 token 之前:否则 AuthTest.java 会被识别成 类AuthTest#方法java
  s = s.replace(SOURCE_EXT, "");

  const tokens = new Set<string>();

  for (const m of s.matchAll(TEST_ID)) tokens.add(`test:${m[1]}#${m[2]}`);
  for (const m of s.matchAll(THROWABLE)) tokens.add(`throw:${m[1]}`);
  for (const [re, kind] of ASSERTION_KINDS) if (re.test(s)) tokens.add(`assert:${kind}`);
  for (const m of s.matchAll(DIAG_CODE)) tokens.add(`diag:${m[1].toLowerCase().trim()}`);

  // 一个标识都没抽到时,退化为前 3 行的紧凑形式。
  // 宁可粒度粗一点,也不能让签名变成"永不相同"。
  if (tokens.size === 0) {
    const fallback = s
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(0, 3)
      .join(" | ")
      .replace(/\s+/g, " ")
      .replace(/\d+/g, "#")
      .slice(0, 300);
    if (fallback) tokens.add(`raw:${fallback}`);
  }

  return [...tokens].sort().join("\n");
}

/**
 * 一条证据的规范形。**按裁判类型分流** —— 这是熔断在非机械裁判下还能工作的关键。
 *
 * normalize() 是为编译/测试输出设计的(抓测试标识、异常类型、断言种类、诊断码)。
 * 喂给它一句中文 rationale,它抽不到任何 token,只能退化成"前三行原文";
 * 而模型每次的措辞都不一样 —— 签名每次都变,sameSignatureCount 恒为 1,
 * 熔断永不触发,I4 的升级阶梯就等于关掉了。
 *
 *   hard  → normalize(raw)          机械输出,现状不变,这套归一化就是为它写的
 *   semi  → failureTag              受约束的三选一枚举,措辞变了签名不变
 *   human → 固定串                  人说了两次不行就是同一个信号,不必细分原因,
 *                                   更不该要求人给自己的判断做分类
 */
function canonicalOf(e: Evidence): string {
  if (e.level === "human") return "human:rejected";
  if (e.level === "semi") return `tag:${e.failureTag ?? "unspecified"}`;
  return normalize(e.raw);
}

/** 由一组失败证据计算稳定签名。acId 参与签名,避免不同 AC 的相同异常被合并。 */
export function failureSignature(failing: Evidence[]): string {
  const canonical = failing
    .map((e) => `${e.acId}::${canonicalOf(e)}`)
    .sort()
    .join("\n---\n");
  return createHash("sha256").update(canonical).digest("hex").slice(0, 12);
}

// ─────────────────────────── 熔断判定 ───────────────────────────

export type BreakerAction =
  | { action: "retry"; sameSignatureCount: number; remaining: number }
  /** quick 专用出口:同一病根撞阈值时升档,而不是走 L2(见 decide 里的注释) */
  | { action: "promote"; to: Tier; reason: string }
  | { action: "escalate"; to: 2 | 3; reason: string }
  | { action: "halt"; reason: string };

export interface BreakerInput {
  tier: Tier;
  task: TaskState;
  /** 本次失败的签名 */
  signature: string;
  /** mission 当前所处的升级级别 */
  level: EscalationLevel;
}

/**
 * 纯函数:给定当前任务状态与本次失败签名,决定重试 / 升级 / 停机。
 * 不修改入参。计数的推进由 applyFailure 完成。
 */
export function decide(input: BreakerInput): BreakerAction {
  const { tier, task, signature, level } = input;
  const threshold = THRESHOLD[tier];
  const cap = ATTEMPT_HARD_CAP[tier];

  const sameCount = task.lastSignature === signature ? task.sameSignatureCount + 1 : 1;

  // 硬上限优先于一切:签名一直在变也不能无限试下去
  if (task.attempts >= cap) {
    return {
      action: "halt",
      reason: `尝试次数达上限 ${cap}(tier=${tier}),停机等待人工介入`,
    };
  }

  if (sameCount >= threshold) {
    // quick 的出口是**升档**,不是 L2。三个理由,都是结构性的:
    //   1. quick 没有"方案"可改 —— 它只有一条判据。L2 的落点(回 PLAN 改方案)
    //      对它是空的,唯一能改的就是那条判据本身,而那是**事后修改判定标准**,
    //      正好是 I2/I3 要禁的事。
    //   2. quick 不落盘(inMemory)。L2 强制换脑,而换脑靠磁盘重附着 ——
    //      失败历史会在换脑那一刻全部蒸发(真实事故:人贴的 CSP 报错就是这么没的)。
    //   3. 升档是往**严**了走:一条判据变成一组冻结 AC + verify.sh,判定强度提高;
    //      而 L2 对 quick 只能往松了走。
    // tier.ts 的 evaluatePromotion 早就写着"quick 档进入第 2 次尝试,升档 standard",
    // 意图一直是对的,只是那条路的检查时机够不着(见 runtime.onAgentSettled)。
    if (tier === "quick") {
      return {
        action: "promote",
        to: "standard",
        reason:
          `连续 ${sameCount} 次同一失败签名 ${signature},quick 档不再重试 —— ` +
          "升档 standard,把那条判据展开成冻结 AC + verify.sh 重新来",
      };
    }
    if (level >= 3) {
      return {
        action: "halt",
        reason: `已在 L3 仍连续 ${sameCount} 次同一失败签名 ${signature},停机`,
      };
    }
    const to = (level + 1) as 2 | 3;
    return {
      action: "escalate",
      to,
      reason:
        `连续 ${sameCount} 次同一失败签名 ${signature},` +
        `不再调整实现,升级到 L${to}(${to === 2 ? "改方案" : "改问题定义"})`,
    };
  }

  return {
    action: "retry",
    sameSignatureCount: sameCount,
    remaining: threshold - sameCount,
  };
}

/** 把一次失败记入任务状态。返回新对象,不修改入参。 */
export function applyFailure(task: TaskState, signature: string): TaskState {
  const same = task.lastSignature === signature;
  return {
    ...task,
    lastSignature: signature,
    sameSignatureCount: same ? task.sameSignatureCount + 1 : 1,
  };
}

/** 升级后重置签名计数:新方案下旧的失败历史不应继续累积。 */
export function resetAfterEscalation(task: TaskState): TaskState {
  return { ...task, lastSignature: undefined, sameSignatureCount: 0 };
}

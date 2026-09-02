import { test } from "node:test";
import assert from "node:assert/strict";
import { judge } from "../verdict.ts";
import type { Evidence } from "../types.ts";

const ev = (p: Partial<Evidence>): Evidence => ({
  level: "hard",
  acId: "AC1",
  result: "pass",
  raw: "",
  ...p,
});

test("无证据不算通过", () => {
  const v = judge([]);
  assert.equal(v.outcome, "inconclusive");
  assert.equal(v.inconclusiveCause, "evidence");
});

test("hard 失败压倒其余全部通过", () => {
  const v = judge([
    ev({ acId: "AC1", level: "hard", result: "fail", raw: "AuthTest#login failed" }),
    ev({ acId: "AC2", level: "semi", result: "pass" }),
    ev({ acId: "AC3", level: "hard", result: "pass" }),
  ]);
  assert.equal(v.outcome, "fail");
  assert.equal(v.failing.length, 1);
  assert.ok(v.signature);
});

test("环境指纹不符判 inconclusive 而非 fail", () => {
  const v = judge(
    [ev({ result: "fail", raw: "boom", envFingerprint: "sha256:bbb" })],
    { expectedFingerprint: "sha256:aaa" },
  );
  assert.equal(v.outcome, "inconclusive");
  assert.equal(v.inconclusiveCause, "env");
  assert.match(v.reason, /环境指纹/);
});

test("必需 AC 缺证据判 inconclusive", () => {
  const v = judge([ev({ acId: "AC1", result: "pass" })], {
    requiredAcIds: ["AC1", "AC2"],
  });
  assert.equal(v.outcome, "inconclusive");
  assert.equal(v.inconclusiveCause, "evidence");
  assert.deepEqual(v.missingAcIds, ["AC2"]);
  assert.match(v.reason, /AC2/);
});

test("只有 soft 证据不能判通过", () => {
  const v = judge([ev({ level: "soft", result: "pass", raw: "我觉得做完了" })]);
  assert.equal(v.outcome, "inconclusive");
  assert.equal(v.inconclusiveCause, "evidence");
});

test("soft 与客观证据并存时以客观证据为准", () => {
  const v = judge([
    ev({ level: "soft", result: "pass" }),
    ev({ acId: "AC1", level: "hard", result: "pass" }),
  ]);
  assert.equal(v.outcome, "pass");
});

test("semi 失败判 fail 并带签名", () => {
  const v = judge([
    ev({ acId: "AC1", level: "hard", result: "pass" }),
    ev({ acId: "AC2", level: "semi", result: "fail", raw: "契约字段 expiresIn 缺失" }),
  ]);
  assert.equal(v.outcome, "fail");
  assert.ok(v.signature);
});

test("范围外 AC 的 inconclusive 不阻断(挂在后续任务的 lint/build 回归项)", () => {
  // 真实事故形状:T1 的 CHECK 只跑 dw1-3,verifier 对 AC6(yarn lint/build,挂在 T4)
  // 永远只能判「无结论」—— 它不该挡住 T1
  const v = judge(
    [
      ev({ acId: "AC1", level: "hard", result: "pass" }),
      ev({ acId: "AC1", level: "semi", result: "pass" }),
      ev({ acId: "AC6", level: "semi", result: "inconclusive", raw: "没有 lint/build 输出证据" }),
    ],
    { requiredAcIds: ["AC1"] },
  );
  assert.equal(v.outcome, "pass");
});

test("范围内 AC 的 inconclusive 仍然阻断", () => {
  const v = judge(
    [
      ev({ acId: "AC1", level: "hard", result: "pass" }),
      ev({ acId: "AC1", level: "semi", result: "inconclusive", raw: "找不到断言" }),
    ],
    { requiredAcIds: ["AC1"] },
  );
  assert.equal(v.outcome, "inconclusive");
  assert.equal(v.inconclusiveCause, "evidence");
  assert.deepEqual(v.missingAcIds, ["AC1"]);
  assert.match(v.reason, /AC1/);
});

test("范围外 AC 的 semi fail 仍然阻断(改坏了别人的回归项)", () => {
  const v = judge(
    [
      ev({ acId: "AC1", level: "hard", result: "pass" }),
      ev({ acId: "AC6", level: "semi", result: "fail", raw: "regression 段断言破" }),
    ],
    { requiredAcIds: ["AC1"] },
  );
  assert.equal(v.outcome, "fail");
  assert.ok(v.signature);
});

test("未传 requiredAcIds 时 inconclusive 一律阻断(quick/spike 原语义)", () => {
  const v = judge([
    ev({ acId: "quick", level: "hard", result: "pass" }),
    ev({ acId: "AC9", level: "semi", result: "inconclusive" }),
  ]);
  assert.equal(v.outcome, "inconclusive");
});

// ─────────────── 裁判理由必须能到执行者手里 ───────────────

test("human fail:人写的那句话带进 reason(它是失败信息进模型的唯一通道)", () => {
  const v = judge([
    { level: "human", acId: "quick", result: "fail", raw: "汉堡点开只有 3 个链接,少了设置和帮助" },
  ]);
  assert.equal(v.outcome, "fail");
  assert.ok(v.reason.includes("汉堡点开只有 3 个链接"), v.reason);
});

test("semi fail:verifier 的 rationale 同样带进 reason", () => {
  const v = judge([
    { level: "semi", acId: "AC1", result: "fail", raw: "media query 写在了 1024px,断点不是 768", failureTag: "incorrect" },
  ]);
  assert.ok(v.reason.includes("断点不是 768"), v.reason);
});

test("理由为空时给出明确占位,不是一个空的冒号", () => {
  const v = judge([{ level: "human", acId: "quick", result: "fail", raw: "   " }]);
  assert.ok(v.reason.includes("未说明原因"), v.reason);
});

test("超长论述截断,但不影响签名(签名走 failureTag,不看措辞)", () => {
  const long = "不对。".repeat(400);
  const a = judge([{ level: "semi", acId: "AC1", result: "fail", raw: long, failureTag: "missing" }]);
  const b = judge([{ level: "semi", acId: "AC1", result: "fail", raw: "换个说法", failureTag: "missing" }]);
  assert.ok(a.reason.length < 400, "reason 不能把整篇论述灌进 State Card");
  assert.equal(a.signature, b.signature, "措辞变了签名不能变,否则熔断失效");
});

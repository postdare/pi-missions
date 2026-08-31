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
  assert.match(v.reason, /环境指纹/);
});

test("必需 AC 缺证据判 inconclusive", () => {
  const v = judge([ev({ acId: "AC1", result: "pass" })], {
    requiredAcIds: ["AC1", "AC2"],
  });
  assert.equal(v.outcome, "inconclusive");
  assert.match(v.reason, /AC2/);
});

test("只有 soft 证据不能判通过", () => {
  const v = judge([ev({ level: "soft", result: "pass", raw: "我觉得做完了" })]);
  assert.equal(v.outcome, "inconclusive");
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

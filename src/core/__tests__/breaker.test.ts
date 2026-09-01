import { test } from "node:test";
import assert from "node:assert/strict";
import { normalize, failureSignature, decide, applyFailure, nearThreshold } from "../breaker.ts";
import type { Evidence, TaskState } from "../types.ts";

const fail = (raw: string, acId = "AC1"): Evidence => ({
  level: "hard",
  acId,
  result: "fail",
  raw,
});

const task = (p: Partial<TaskState> = {}): TaskState => ({
  id: "T3",
  status: "running",
  attempts: 1,
  sameSignatureCount: 0,
  inconclusiveStreak: 0,
  ...p,
});

// ─────────────── 归一化:同一病根必须同签名 ───────────────

test("行号变化不改变签名", () => {
  const a = "AuthIntegrationTest#refreshToken(AuthIntegrationTest.java:87) expected:<200> but was:<401>";
  const b = "AuthIntegrationTest#refreshToken(AuthIntegrationTest.java:91) expected:<200> but was:<401>";
  assert.equal(failureSignature([fail(a)]), failureSignature([fail(b)]));
});

test("耗时与时间戳不改变签名", () => {
  const a = "2026-08-31T10:22:01 AuthTest#login FAILED in 1.23 s NullPointerException";
  const b = "2026-08-31T11:40:55 AuthTest#login FAILED in 0.87 s NullPointerException";
  assert.equal(failureSignature([fail(a)]), failureSignature([fail(b)]));
});

test("对象 hash 与绝对路径不改变签名", () => {
  const a = "at /home/kevin/proj/src/AuthFilter.java com.x.AuthFilter@1a2b3c4d NullPointerException";
  const b = "at /var/ci/work/src/AuthFilter.java com.x.AuthFilter@9f8e7d6c NullPointerException";
  assert.equal(failureSignature([fail(a)]), failureSignature([fail(b)]));
});

// ─────────────── 归一化:不同病根必须不同签名 ───────────────

test("不同测试方法签名不同", () => {
  const a = failureSignature([fail("AuthTest#login expected:<200> but was:<401>")]);
  const b = failureSignature([fail("AuthTest#logout expected:<200> but was:<401>")]);
  assert.notEqual(a, b);
});

test("不同异常类型签名不同", () => {
  const a = failureSignature([fail("AuthTest#login NullPointerException")]);
  const b = failureSignature([fail("AuthTest#login IllegalStateException")]);
  assert.notEqual(a, b);
});

test("同样的异常出现在不同 AC 上签名不同", () => {
  const a = failureSignature([fail("NullPointerException", "AC1")]);
  const b = failureSignature([fail("NullPointerException", "AC2")]);
  assert.notEqual(a, b);
});

test("抽不到标识时退化为归一化前三行,而不是永不相同", () => {
  const a = normalize("build failed after 12 attempts\nsee log\ntail");
  const b = normalize("build failed after 37 attempts\nsee log\ntail");
  assert.equal(a, b, "数字应被归一化");
  assert.ok(a.length > 0, "不应产生空签名");
});

// ─────────────── 熔断 ───────────────

test("签名变化时重新计数,不触发升级", () => {
  const d = decide({
    tier: "standard",
    task: task({ lastSignature: "aaa", sameSignatureCount: 2 }),
    signature: "bbb",
    level: 1,
  });
  assert.equal(d.action, "retry");
  assert.equal(d.action === "retry" && d.sameSignatureCount, 1);
});

test("standard 档同一签名第 3 次触发 L2 升级", () => {
  const d = decide({
    tier: "standard",
    task: task({ lastSignature: "aaa", sameSignatureCount: 2, attempts: 3 }),
    signature: "aaa",
    level: 1,
  });
  assert.equal(d.action, "escalate");
  assert.equal(d.action === "escalate" && d.to, 2);
});

test("quick 档阈值更低,第 2 次即升级", () => {
  const d = decide({
    tier: "quick",
    task: task({ lastSignature: "aaa", sameSignatureCount: 1, attempts: 2 }),
    signature: "aaa",
    level: 1,
  });
  assert.equal(d.action, "escalate");
});

test("已在 L3 仍连续失败则停机,不会有 L4", () => {
  const d = decide({
    tier: "standard",
    task: task({ lastSignature: "aaa", sameSignatureCount: 2, attempts: 5 }),
    signature: "aaa",
    level: 3,
  });
  assert.equal(d.action, "halt");
});

test("签名一直在变也不能无限重试:硬上限触发停机", () => {
  const d = decide({
    tier: "standard",
    task: task({ attempts: 9, lastSignature: "x", sameSignatureCount: 1 }),
    signature: "y",
    level: 1,
  });
  assert.equal(d.action, "halt");
  assert.match(d.action === "halt" ? d.reason : "", /上限/);
});

test("applyFailure 不修改入参", () => {
  const t = task({ lastSignature: "aaa", sameSignatureCount: 1 });
  const next = applyFailure(t, "aaa");
  assert.equal(t.sameSignatureCount, 1);
  assert.equal(next.sameSignatureCount, 2);
});

// ─────────────── 回归:真实 surefire 输出 ───────────────

const SUREFIRE = `[ERROR] com.acme.auth.AuthIntegrationTest.refreshToken  Time elapsed: 0.331 s  <<< FAILURE!
org.opentest4j.AssertionFailedError: expected: <200> but was: <401>
	at com.acme.auth.AuthIntegrationTest.refreshToken(AuthIntegrationTest.java:87)`;

test("源文件后缀不产生假的 类#方法 token", () => {
  const s = normalize(SUREFIRE);
  assert.ok(s.includes("test:AuthIntegrationTest#refreshToken"));
  assert.ok(!s.includes("#java"), `规范串出现假 token:\n${s}`);
});

test("同一测试的不同期望值归为同一签名(刻意从粗)", () => {
  const a = SUREFIRE;
  const b = SUREFIRE.replace("<401>", "<500>");
  assert.equal(failureSignature([fail(a)]), failureSignature([fail(b)]));
});

test("断言类别不同则签名不同", () => {
  const a = "FooTest#bar assertThrows failed";
  const b = "FooTest#bar assertNotNull failed";
  assert.notEqual(failureSignature([fail(a)]), failureSignature([fail(b)]));
});

// ─────────────── 熔断临界:UI 的警告色以此为准 ───────────────

test("nearThreshold:再失败一次就升级时为真,且不把 0 次当成临界", () => {
  // standard 阈值 3:第 2 次同签名就是临界
  assert.equal(nearThreshold(task({ sameSignatureCount: 0 }), "standard"), false);
  assert.equal(nearThreshold(task({ sameSignatureCount: 1 }), "standard"), false);
  assert.equal(nearThreshold(task({ sameSignatureCount: 2 }), "standard"), true);
  assert.equal(nearThreshold(task({ sameSignatureCount: 3 }), "standard"), true);
  // quick 阈值 2:第 1 次同签名就已经是临界
  assert.equal(nearThreshold(task({ sameSignatureCount: 1 }), "quick"), true);
  // 没有任务时不报警
  assert.equal(nearThreshold(undefined, "standard"), false);
});

test("nearThreshold 与 decide 一致:临界的下一次失败必须真的升级", () => {
  const sig = failureSignature([fail("boom NullPointerException")]);
  for (const tier of ["quick", "standard", "complex"] as const) {
    // 一直用同一个签名打,直到 decide 说要升级
    let cur = task({ sameSignatureCount: 0, lastSignature: sig });
    for (let i = 0; i < 12; i++) {
      const wasNear = nearThreshold(cur, tier);
      const d = decide({ tier, task: cur, signature: sig, level: 1 });
      if (d.action !== "retry") {
        assert.equal(wasNear, true, `${tier}:升级前一刻 nearThreshold 应为真`);
        break;
      }
      assert.equal(wasNear, false, `${tier}:还能重试就不该是临界`);
      cur = applyFailure({ ...cur, attempts: cur.attempts + 1 }, sig);
    }
  }
});

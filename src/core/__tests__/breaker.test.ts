import { test } from "node:test";
import assert from "node:assert/strict";
import { normalize, failureSignature, decide, applyFailure, evaluateManualEscalation, nearThreshold } from "../breaker.ts";
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

test("quick 档阈值更低,第 2 次即出栈 —— 但出口是升档,不是 L2", () => {
  const d = decide({
    tier: "quick",
    task: task({ lastSignature: "aaa", sameSignatureCount: 1, attempts: 2 }),
    signature: "aaa",
    level: 1,
  });
  // quick 没有"方案"可改,L2 的落点对它是空的;而且它不落盘,强制换脑会丢掉失败历史
  assert.equal(d.action, "promote");
  assert.equal(d.action === "promote" && d.to, "standard");
});

test("standard/complex 仍然走 L2,升档出口只属于 quick", () => {
  for (const tier of ["standard", "complex"] as const) {
    const d = decide({
      tier,
      task: task({ lastSignature: "aaa", sameSignatureCount: 2, attempts: 3 }),
      signature: "aaa",
      level: 1,
    });
    assert.equal(d.action, "escalate", tier);
    assert.equal(d.action === "escalate" && d.to, 2, tier);
  }
});

test("quick 的硬上限优先于升档:签名一直在变也不能无限试", () => {
  const d = decide({
    tier: "quick",
    task: task({ lastSignature: "aaa", sameSignatureCount: 1, attempts: 4 }),
    signature: "bbb",
    level: 1,
  });
  assert.equal(d.action, "halt");
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

// ─────────────── 自然语言裁判的签名:措辞变了,签名不能变 ───────────────

const semiFail = (tag: any, rationale: string, acId = "AC1"): Evidence => ({
  level: "semi",
  acId,
  result: "fail",
  raw: rationale,
  failureTag: tag,
});

const humanFail = (rationale: string, acId = "AC1"): Evidence => ({
  level: "human",
  acId,
  result: "fail",
  raw: rationale,
});

test("semi 证据:同一类别换一种措辞,签名不变(否则熔断永不触发)", () => {
  const a = semiFail("missing", "导航栏在窄屏下没有折叠成汉堡菜单,media query 缺失");
  const b = semiFail("missing", "未看到 768px 断点的处理,汉堡菜单没有实现");
  assert.equal(failureSignature([a]), failureSignature([b]));
});

test("semi 证据:类别不同则签名不同(换了病根应当重新计数)", () => {
  const a = semiFail("missing", "没做");
  const b = semiFail("incorrect", "做了但断点写成了 1024");
  assert.notEqual(failureSignature([a]), failureSignature([b]));
});

test("semi 证据:同类别但不同 AC,签名不同(别把两条判据合并)", () => {
  const a = semiFail("missing", "没做", "AC1");
  const b = semiFail("missing", "没做", "AC2");
  assert.notEqual(failureSignature([a]), failureSignature([b]));
});

test("semi 证据:缺 failureTag 时退化成固定串,仍然稳定", () => {
  const a: Evidence = { level: "semi", acId: "AC1", result: "fail", raw: "随便写的一段" };
  const b: Evidence = { level: "semi", acId: "AC1", result: "fail", raw: "完全不同的另一段" };
  assert.equal(failureSignature([a]), failureSignature([b]));
});

test("human 证据:人两次说不行就是同一个信号,理由措辞不参与签名", () => {
  const a = humanFail("汉堡点开只有 3 个链接");
  const b = humanFail("还是不对,宽屏也跟着变了");
  assert.equal(failureSignature([a]), failureSignature([b]));
});

test("human 与 semi 即使同 AC 也是不同签名(裁判换了,病根未必同)", () => {
  assert.notEqual(failureSignature([humanFail("不行")]), failureSignature([semiFail("missing", "不行")]));
});

test("自然语言签名接得上熔断:同类别连续两次即达到 quick 阈值", () => {
  const sig = failureSignature([semiFail("missing", "第一次的说法")]);
  const t1 = applyFailure(task({ attempts: 1 }), sig);
  assert.equal(t1.sameSignatureCount, 1);
  const sig2 = failureSignature([semiFail("missing", "第二次换了个说法")]);
  const d = decide({ tier: "quick", task: t1, signature: sig2, level: 1 });
  assert.equal(d.action, "promote", "同一病根第二次必须出栈,而不是继续微调");
});

test("人工终审签名固定,所以人连说两次不行必然出栈 —— 这是刻意的", () => {
  const hf = (why: string): Evidence => ({ level: "human", acId: "quick", result: "fail", raw: why });
  const s1 = failureSignature([hf("CSP 报错,脚本加载不了")]);
  const t1 = applyFailure(task({ attempts: 1 }), s1);
  const s2 = failureSignature([hf("还是不行,布局全乱了")]);
  const d = decide({ tier: "quick", task: t1, signature: s2, level: 1 });
  assert.equal(d.action, "promote", "人说了两次不行就该换档,不该让人陪着试第三次");
});

// ─────────────── 手动升级的守卫 ───────────────

test("首次失败就手动 L2 —— 拒绝,并给出正确动作", () => {
  const r = evaluateManualEscalation({ task: task({ attempts: 1, sameSignatureCount: 1 }), to: 2 });
  assert.equal(r.ok, false);
  // 打回只说"不行"会让模型再想一个别的姿势;要直接告诉它该做什么
  assert.match(r.ok === false ? r.reason : "", /直接结束本轮/);
});

test("同一失败第二次 —— 放行:'再修也没用'这句话有机械依据了", () => {
  assert.equal(evaluateManualEscalation({ task: task({ attempts: 1, sameSignatureCount: 2 }), to: 2 }).ok, true);
});

test("试过两次 —— 放行,哪怕每次的失败签名都不一样", () => {
  assert.equal(evaluateManualEscalation({ task: task({ attempts: 2, sameSignatureCount: 1 }), to: 2 }).ok, true);
});

test("卡在 INCONCLUSIVE 上 —— 必须放行,否则守卫自己变成死锁", () => {
  // INCONCLUSIVE 不走 applyFailure,签名计数永远是 0:按签名拦就再也升不上去了
  const t = task({ attempts: 1, sameSignatureCount: 0, inconclusiveStreak: 1 });
  assert.equal(evaluateManualEscalation({ task: t, to: 2 }).ok, true);
});

test("待补证据 —— 同理放行", () => {
  const t = task({ attempts: 1, sameSignatureCount: 0, awaitingEvidence: { reason: "缺 AC2", acIds: ["AC2"], treeFp: null } });
  assert.equal(evaluateManualEscalation({ task: t, to: 2 }).ok, true);
});

test("L3 不归这道守卫管 —— 它自己要人工确认", () => {
  assert.equal(evaluateManualEscalation({ task: task({ attempts: 1, sameSignatureCount: 0 }), to: 3 }).ok, true);
});

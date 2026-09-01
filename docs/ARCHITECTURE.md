# pi-missions 架构与术语

> 本文描述**当前代码的实际行为**,不是设计意图或路线图。所有断言都带 `文件:行号`,
> 与代码不符以代码为准。README.md 是使用说明,本文是内部结构说明。

## 目录

- [1. 定位](#1-定位)
- [2. 分层结构](#2-分层结构)
- [3. 相位状态机](#3-相位状态机)
- [4. 术语表](#4-术语表)
- [5. 一次完整的 DO→CHECK 时序](#5-一次完整的-docheck-时序)
- [6. 仓库布局](#6-仓库布局)
- [7. 不变量与代码落点](#7-不变量与代码落点)
- [8. 当前边界与已知薄弱点](#8-当前边界与已知薄弱点)

---

## 1. 定位

pi-missions 是跑在 [pi](https://github.com/earendil-works/pi-coding-agent) 上的扩展,
把"agent 做任务"改造成一个由纯代码裁判的状态机。

**核心断言:L0 是唯一的裁判,LLM 只是执行者。LLM 只能提交,不能宣布通过。**

---

## 2. 分层结构

```
┌─ pi 宿主进程 ──────────────────────────────────────────────┐
│                                                            │
│  事件: session_start / before_agent_start / tool_call      │
│        tool_result / agent_settled / message_end           │
│         │                        (挂载见 src/index.ts:44-87)│
│  ┌──────▼─── 扩展进程(本包)──────────────────────────┐   │
│  │                                                     │   │
│  │  src/index.ts        装配层:挂事件、注册工具与命令  │   │
│  │       │                                             │   │
│  │  src/runtime.ts      哑管道:采证据 → judge →       │   │
│  │       │              发事件 → 翻译 Effect            │   │
│  │       │                                             │   │
│  │  ┌────▼─── src/core/ ── 纯函数,唯一裁判 ────────┐  │   │
│  │  │  machine.ts   相位状态机 (state,event)→effects│  │   │
│  │  │  breaker.ts   失败签名 + 熔断 + 升级判定       │  │   │
│  │  │  verdict.ts   证据 → pass/fail/inconclusive    │  │   │
│  │  │  tier.ts      三档与自动升档                    │  │   │
│  │  └────────────────────────────────────────────────┘  │   │
│  │                                                     │   │
│  │  src/store/   仓库读写(计划/状态/日志/证据/路径)   │   │
│  │  src/hooks/   闸门 + 编辑级增量反馈                  │   │
│  │  src/roles/   角色模型映射 + 子进程 Verifier         │   │
│  │  src/ui/      主面板 / 状态条 / 卡片                 │   │
│  └─────────────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────────┘
         │ 落盘
         ▼
    <repo>/missions/   ← 状态在这里,不在会话里
```

### core 的纯净性是硬约束

`src/core/types.ts:3-7` 写明:core 下所有模块不 import pi、不读文件、不调网络、
除事件携带的 `at` 之外不依赖环境。

这是"L0 是唯一裁判"的物理保证 —— 裁判必须可单测。`npm test` 里 core 的 49 个单测
(breaker 16 / machine 20 / tier 6 / verdict 7)就建立在这条约束上。

### runtime 的角色被刻意收窄

`src/runtime.ts:4-6` 写明 runtime **不做任何判定**,只做四件事:

1. 采集证据
2. 调 `judge()`
3. 把事件喂给 `machine`
4. 把返回的 `Effect[]` 翻译成 pi API 调用(`src/runtime.ts:274`)

所有"对不对 / 升不升 / 停不停"的决定都在 core 里。

---

## 3. 相位状态机

### 相位(Phase)

`src/core/types.ts:11`,六个值:

| 相位 | PDCA | 谁在动 | 工具集(`src/hooks/gate.ts:20`) |
|---|---|---|---|
| `plan` | P | LLM(planner) | 只读 + `mission_write_plan` |
| `do` | D | LLM(executor) | 全部内置工具 + `mission_submit` |
| `check` | C | **L0,没有 LLM 回合** | 只读 |
| `act` | A | LLM(escalator),**只有一轮** | 只读 + `mission_escalate` |
| `done` | — | — | 恢复用户原工具集 |
| `halted` | — | — | 同上 |

### 迁移图

```
   ┌──────┐  PLAN_FROZEN  ┌──────┐  SUBMIT  ┌───────┐
   │ PLAN │──────────────▶│  DO  │─────────▶│ CHECK │
   └──────┘               └──────┘          └───┬───┘
       ▲                     ▲                  │ VERDICT
       │                     │                  │
       │        ADJUST_DONE  │      ┌───────────┴───────────┐
       │       ┌─────────────┘      │ pass → 下一任务/done  │
       │       │                    │ fail → breaker 判定    │
       │   ┌───┴──┐                 │ inconclusive → 回 DO   │
       │   │ ACT  │◀────────────────┘  (连 3 次 → halted)    │
       │   └───┬──┘  retry                                   │
       └───────┘  escalate L2 / L3(L3 需人工确认)
```

### 纯 reducer

```ts
transition(state: MissionState, event: MissionEvent): { state, effects, error? }
```

`src/core/machine.ts:62`。非法迁移**不抛异常**,返回 `error` 字段且状态不变,
调用方记录并忽略该事件。

**11 个事件**(`src/core/types.ts:117-138`):
`PLAN_FROZEN` `SUBMIT` `VERDICT` `ADJUST_DONE` `ESCALATE` `ESCALATION_CONFIRMED`
`ESCALATION_REJECTED` `HANDOFF_REQUEST` `HANDOFF_DONE` `PROMOTE_TIER` `ABORT`

**11 个效果**(`src/core/types.ts:144-160`):
`SET_TOOLS` `SET_ROLE` `HANDOFF` `LOG` `CONFIRM` `ADVANCE_TASK` `FREEZE_AC`
`PERSIST_PLAN` `ARCHIVE_PLAN` `RESTORE` `NOTIFY`

机器一条 Effect 都不执行,全部交给 `runtime.translateEffects()` 翻译。

---

## 4. 术语表

### 4.1 最容易混的一组:L0 vs L1/L2/L3

**这两套编号不是同一个维度。**

- **L0** —— 层级概念,指扩展进程里的纯代码裁判(相对 L1 = LLM 执行者的分层)。
  "L0 亲自跑 verify.sh"就是这个意思。
- **L1/L2/L3** —— `EscalationLevel`(`src/core/types.ts:16`),**升级阶梯**:

| 级别 | 含义 | 改什么 | 落点 |
|---|---|---|---|
| L1 | 改实现 | 代码 | ACT → DO(默认级别,`escalation.level` 初值 1) |
| L2 | 改方案 | 任务分解,**AC 不变** | 回 PLAN,强制换脑 |
| L3 | 改问题定义 | **可改 AC**,需人工确认 | 回 PLAN,归档旧计划 + 换脑 |

`escalation.level` 是 **mission 级**的单调递增值,`src/core/machine.ts:255` 拒绝降级。

### 4.2 档位(Tier)

`quick | standard | complex`(`src/core/types.ts:13`)。**升档自动,降档手动。**

| | quick | standard | complex |
|---|---|---|---|
| 入口 | `/mission quick --verify "<命令>"` | `/mission new` | `/mission new --tier=complex` |
| 落盘 | 否(`inMemory: true`) | 是 | 是,里程碑分文件 |
| 判定依据 | 一条裸命令 `quickVerifyCommand`,**进 DO 前冻结** | verify.sh 分支 + 子进程 Verifier | 同左 + 里程碑回归 |
| 熔断阈值 | 2 | 3 | 3 |
| 尝试硬上限 | 4 | 9 | 12 |
| 任务切换换脑 | 否 | 否 | **是** |

阈值见 `src/core/breaker.ts:21`(THRESHOLD)与 `:28`(ATTEMPT_HARD_CAP)。

升档判据在 `src/core/tier.ts:39` `evaluatePromotion()`,全部机械可测:
触及公开 API / 改动 > 5 文件 / quick 档第 2 次尝试 / standard 档 2 次 L2。
**刻意不让 LLM 自评"这任务复杂吗"**(I7)。

### 入口守卫(准入判定)

`evaluateAdmission()`(`src/core/tier.ts:80`)决定一个 mission 能否直接进 DO:

- quick 档**必须**在进 DO 前拿到一条验证命令(`/mission quick --verify "<命令>"`)
- 拿不到 → 不进 DO,自动升 standard,由 PLAN 相位写出可执行的 AC

理由是 I2/I3:判定依据必须先于执行冻结。允许执行者干完活再补一条判定命令,
等于让被判定方事后挑裁判。`mission_submit` 因此**不接受任何参数**——
提交路径上没有任何"补一条标准"的入口。

### 4.3 角色(Role)

`planner | executor | verifier | escalator`(`src/core/types.ts:18`)。两个用途:

1. **模型映射** —— `missions/models.json` 给每个角色配 provider/model/thinking
   (`src/roles/models.ts`),进相位时 `applyRole()` 切换。默认 thinking:
   planner=high、escalator=high、verifier=off。
2. **成本分账** —— `state.cost` 是 `Partial<Record<Role, number>>`,
   `/mission models` 查看每个角色的花费。

相位到角色的映射是常量表 `ROLE_OF`(`src/core/machine.ts:42`),
`done`/`halted` 映射到 `null`。

### 4.4 AC(验收标准)与 verify 分支

```ts
{ id: "AC1", text: "人类可读的验收描述", verify: "auth-integration" }
```

**`verify` 不是命令,是 `missions/scripts/verify.sh` 的一个分支名**
(`src/store/mission.ts:15`:"不写裸命令")。判定时 L0 执行的是
`bash missions/scripts/verify.sh auth-integration`,取退出码(`src/runtime.ts:420`)。

这是整个设计的枢纽:**AC 必须有可执行入口,否则写不进计划。**
`validatePlan()`(`src/store/mission.ts:67`)在冻结前校验:

- 至少一条 AC、至少一个任务、goal 非空
- 每条 AC 必须有非空 `verify`
- 每个任务必须至少有一个 verify 分支("无法判定的事不该进入 DO")
- 所有 verify 分支必须能在 verifyScript 文本里找到
  —— `scriptHasBranch()`(`src/store/mission.ts:103`)正则粗检 `name)` / `"name"` / `name()`

### 4.5 冻结(Freeze)

`mission_write_plan` 是**原子提交**:MISSION.md 内容 + verify.sh 内容一次写入,
人工确认(`src/runtime.ts:653`),然后发 `PLAN_FROZEN`,触发 `FREEZE_AC` 效果
(`src/runtime.ts:332`):记录环境指纹、落盘、提示提交 git。

冻结后 AC 只读,由三道锁保护:

1. **工具集** —— DO 相位没有 `mission_write_plan`
2. **闸门** —— `src/hooks/gate.ts:57-68` 拦 `missions/plans/`、`missions/state/`、
   非 plan 相位的 `verify.sh` 的 edit/write
3. **bash 粗检** —— `src/hooks/gate.ts:71-79` 拦 `>` `sed -i` `tee` `rm` 等写操作
   指向受保护路径

### 4.6 证据(Evidence)三级

`src/core/types.ts:29-33`:

| 级别 | 来源 | 成本 | 能否触发 PASS |
|---|---|---|---|
| **hard** | L0 直接跑 verify.sh 拿退出码 | 零模型成本 | 能 |
| **semi** | 独立 Verifier 子进程逐条核对 AC | 一次冷启动 pi 进程 | 能 |
| **soft** | 执行者自述 | — | **永远不能**,只能触发 ACT |

**semi 的独立性靠进程隔离**:`src/roles/verifier.ts` 起一个 `pi -p --no-extensions`
子进程,只给 read + bash,喂 git diff + 冻结的 AC + hard 结果,逐条核对后调
`mission_verdict` 返回结论。它**不能写文件** —— `templates/phases/check.md` 写明理由:
"验证者一旦能改代码,就会顺手修一下然后判自己通过"。

### 4.7 判定(Verdict)

`judge(evidences, options)`(`src/core/verdict.ts:28`),七条优先级自上而下命中即返回:

```
0. 无证据                → inconclusive   ← 防"没跑就算过"
1. 环境指纹不符          → inconclusive   ← I9
2. 任一证据 inconclusive → inconclusive
3. 任一 hard fail        → fail
4. 必需 AC 缺证据        → inconclusive   ← 防漏跑当通过
5. 任一 semi fail        → fail
6. 只有 soft 证据        → inconclusive   ← I3
7. 其余                  → pass
```

`inconclusive` 是第三态,**不是失败**:不计 attempts、不进熔断、直接回 DO
(`src/core/machine.ts:126-160`)。但连续 `INCONCLUSIVE_STREAK_CAP = 3` 次
(`src/core/machine.ts:52`)直接停机等人 —— 环境没人修,重试没有意义。

### 4.8 失败签名(Signature)与熔断(Breaker)

**签名** —— 把失败输出压成稳定的规范串再哈希。`normalize()`(`src/core/breaker.ts:69`)
丢弃行号、绝对路径、时间戳、耗时、对象 hash、UUID,只保留四类 token:

- `test:AuthTest#refreshToken` —— 测试标识
- `throw:NullPointerException` —— 异常类型
- `assert:expected-but-was` —— 断言**种类**(刻意不保留期望值/实际值)
- `diag:ts2345` —— 编译/类型错误码

抽不到任何 token 时退化为前三行的紧凑形式,而不是"永不相同"。
最终 `sha256` 取前 12 位,`acId` 参与签名(`src/core/breaker.ts:110`),
不同 AC 的相同异常不会被合并。

`src/core/breaker.ts:12-14` 标注这是**全文件最需要按实际数据调的参数**:

- 归一化太严 → 同一病根算作不同失败,熔断永不触发
- 归一化太松 → 不同问题被合并,误熔断

**熔断** —— `decide()`(`src/core/breaker.ts:138`),优先级:

```
attempts >= ATTEMPT_HARD_CAP   → halt      (签名一直在变也不许无限试)
同一签名连续 >= THRESHOLD      → escalate  (已在 L3 则 halt,没有 L4)
其余                           → retry     (进 ACT 诊断一轮)
```

熔断判定**已并入状态机**(`src/core/machine.ts:14-17`):`VERDICT(fail)` 到达时
机器内部直接调 `decide()`,签名计数也在机器内更新。hooks 层不做任何决策。

### 4.9 换脑(Handoff)

**I5:每次升级必须换干净上下文。** 实现分两半:

**软的一半** —— `ctx.newSession()` 创建新会话,只携带 MISSION.md + LOG.md 失败记录
+ 最后一次失败证据,不带污染对话。

**硬的一半** —— `state.pendingHandoff`(`src/core/types.ts:105-110`)。非 null 时
闸门硬阻断一切非只读操作(`src/hooks/gate.ts:51`),唯一出口是 `/mission next`
发 `HANDOFF_DONE`。状态机层面也拒绝 `PLAN_FROZEN` 与 `SUBMIT`。

**握手走磁盘,不走内存** —— pi 在 newSession 后会重建扩展实例,内存态必丢。
所以新会话的 `session_start` 从 `missions/state/CURRENT` 读 mission id →
读 STATE.json → 看到 `pendingHandoff` 非空 → 判定"这个全新会话就是换脑要的干净
上下文",接上并发 `HANDOFF_DONE`(`src/runtime.ts:236-250`)。
链路被打断时硬阻断仍在,手动 `/mission next` 兜底。

### 4.10 闸门(Gate)

两层粗细(`src/hooks/gate.ts`):

1. **`setActiveTools()`** —— 粗粒度,LLM 看不到的工具不会调
2. **`tool_call` 钩子** —— 细粒度,防 bash 绕过、防写冻结件

`src/hooks/gate.ts:7` 有一条重要约束:**闸门只依赖 STATE,不依赖"上一个工具的
结果"** —— 并行工具执行时序不保证。

### 4.11 环境指纹(Env Fingerprint)

`missions/scripts/env-fingerprint.sh` 的输出哈希。冻结时记录一次
(`state.envFingerprint`),每次采集证据时重算。不符 → 整份判 `inconclusive`
而不是 `fail`(I9)。理由(`src/core/verdict.ts:44`):**判 fail 会让 agent 去改代码,
而病根在环境。**

### 4.12 State Card

`before_agent_start` 钩子注入的一段结构化文本(`src/runtime.ts:737`),每轮对话都带:

```
[MISSION] <id> · <tier> · phase=<phase> · task=<T1> · attempt=<n>
GOAL: ...
AC(冻结,不可修改):
  - AC1: ./missions/scripts/verify.sh auth-integration 退出码 0 —— <描述>
CURRENT TASK: T1 <标题>(verify: auth-integration)
PREV FAILURE: <上一轮失败原因>
⏸ 换脑挂起中:<原因>。请执行 /mission next。
```

同一钩子把 `missions/phases/<phase>.md` 追加进 system prompt ——
**I8:走到哪一步读哪一层**。相位提示词在仓库里,用户可改,改了就是规范(I6)。

### 4.13 tick(内层循环驱动)

`agent_settled` 是**唯一安全的判定点**(`src/runtime.ts:498`)。按相位分流:

- `check` → 跑 `runCheck()`(采证据 → judge → 发 VERDICT)
- `act` → 发 `ADJUST_DONE` 回 DO(**ACT 就是一轮,不给第二轮**)
- `do` / `plan` → 机械升档判定 + 上下文水位换脑

对话的推进靠 `sendUserMessage(..., { deliverAs: "followUp" })`:判定完给 LLM 发一条
DO brief 或 ACT brief,循环自己转起来。

### 4.14 两层循环

README 标题里的"双层循环":

- **外层 PDCA** —— 任务级:PLAN→DO→CHECK→ACT,管分解与进度
- **内层操控循环** —— 两个粒度:
  - 任务级自我修正:CHECK 失败 → ACT 诊断一轮 → 回 DO
  - **编辑级**:`src/hooks/diagnostics.ts`,edit/write 成功后 debounce 800ms
    后台跑配置的 `incrementalCheck`(如 `npx tsc --noEmit`),发现问题当场 steer 回灌。
    理由:"lint/类型检查是每次编辑后立刻可得的,没理由攒到 CHECK"。
    命令未配置则关闭 —— 通用扩展无法发明跨语言的增量检查器,这是诚实的边界。

### 4.15 其余术语

| 术语 | 含义 | 位置 |
|---|---|---|
| **inMemory** | quick 档不落盘,计划与状态只在内存;升档时 `PERSIST_PLAN` 补写 | `src/runtime.ts:63` |
| **CURRENT 指针** | `missions/state/CURRENT`,一行 mission id,重建实例时找回现场 | `src/store/paths.ts:65` |
| **profile** | 用户原本的模型/thinking 现场,mission 开始时保存、结束时 `RESTORE` 恢复;随 mission 落盘以便跨会话接力 | `src/roles/models.ts` |
| **里程碑(Milestone)** | complex 档的任务分组,分文件存 `M1.md`;里程碑最后一个任务重跑整组 verify 分支(回归) | `src/runtime.ts:415-418` |
| **fence** | MISSION.md 尾部的 ```` ```mission ```` JSON 块,**机器的 source of truth**;resume 时只解析 fence,绝不回读散文 | `src/store/mission.ts:43` |
| **降级模式** | 目标目录非 git 仓库:AC 冻结只剩 L0 闸门,无 git 审计链,semi 证据跳过(需要 git diff) | `src/runtime.ts:65` |

### 4.16 LLM 可调用的工具

只有三个(`src/tools.ts`),外加子进程里的第四个:

| 工具 | 相位 | 作用 |
|---|---|---|
| `mission_write_plan` | PLAN | 原子提交 AC + 任务分解 + verify.sh 内容 |
| `mission_submit` | DO | 声明已提交,触发判定(**不等于通过**)。无参数——判定依据早已冻结 |
| `mission_escalate` | ACT | 主动升级 L2/L3 |
| `mission_verdict` | — | 只存在于 Verifier 子进程,逐条 AC 提交结论 |

**没有任何工具能直接改 STATE.json。** 状态推进全部由 L0 驱动。

---

## 5. 一次完整的 DO→CHECK 时序

```
LLM 写代码
  │  edit/write → tool_call 闸门校验 → tool_result 记 metrics
  │              └→ diagnostics 后台增量检查,有问题 steer 回灌
  ▼
LLM 调 mission_submit
  │  → applyEvent(SUBMIT) → machine 迁移到 check
  │  → SET_TOOLS(check) 收走写工具
  ▼
agent_settled 触发 tick,phase === check → runCheck()
  │  1. 算环境指纹
  │  2. 逐个跑 verify.sh <分支> 拿退出码           → hard 证据
  │  3. 起 Verifier 子进程,喂 AC + hard 结果 + diff → semi 证据
  │  4. judge(evidences, { expectedFingerprint, requiredAcIds }) → Verdict
  │  5. 证据归档到 missions/state/<id>/evidence/
  │  6. 渲染 verdict 卡片(TUI 可见,不进 LLM 上下文)
  ▼
applyEvent(VERDICT)
  │  pass         → 下一任务(complex 档顺带换脑)/ 全完 → done + RESTORE
  │  inconclusive → 回 do,不计数;连 3 次 → halted
  │  fail         → applyFailure 记签名 + decide()
  │                   retry    → act
  │                   escalate → L2 回 plan + 换脑 / L3 发 CONFIRM 等人
  │                   halt     → halted + RESTORE
  ▼
followUp 发 DO brief 或 ACT brief,循环继续
```

---

## 6. 仓库布局

**I6:仓库即规范。** 状态不放 `.pi/`(工具目录,通常在 .gitignore),全部进 `missions/`。

```
<repo>/missions/
├── README.md                      工作流规则(脚手架铺设,已存在不覆盖)
├── phases/{plan,do,check,act}.md  相位提示词 ← 进哪个相位读哪个
├── scripts/
│   ├── verify.sh                  AC 的唯一执行入口,planner 起草,随 AC 冻结
│   ├── env-fingerprint.sh         环境指纹
│   └── verifier-tools.ts          子进程 Verifier 的扩展(提供 mission_verdict)
├── models.json                    角色 → 模型映射(可选)
├── plans/<id>/
│   ├── MISSION.md                 冻结计划(正文给人,尾部 fence 给机器)
│   └── M1.md …                    complex 档的里程碑分文件
└── state/
    ├── CURRENT                    活跃 mission 指针
    └── <id>/
        ├── STATE.json             MissionState 全量(tmp + rename 原子写 + 串行队列)
        ├── LOG.md                 事件流水
        ├── profile.json           用户现场(模型/thinking)
        ├── evidence/              按 task/attempt 归档的原始证据
        └── archive/               L3 归档的旧 MISSION.md
```

`missions/state/` 默认写进 `.git/info/exclude`(不动用户的 `.gitignore`);
`MISSION.md` 建议提交,git 提供 AC 冻结的审计链。
脚手架**已存在的文件不覆盖** —— 用户可以定制,仓库里的才是规范。

---

## 7. 不变量与代码落点

| # | 不变量 | 实现位置 |
|---|---|---|
| I1 | 状态是仓库里的文件,不是会话里的对话 | `src/store/state.ts` + CURRENT 指针 + `ensureAttached()` |
| I2 | AC 在 Plan 冻结,执行期只读 | `FREEZE_AC` + `src/hooks/gate.ts:57-68` + 工具集切换 |
| I3 | 判定证据必须来自执行者之外 | 子进程 Verifier + soft 永不触发 pass |
| I4 | 熔断优先于重试 | `breaker.decide()`,并入 `VERDICT(fail)` 处理 |
| I5 | 每次升级必须换干净上下文 | `pendingHandoff` 硬阻断 + 磁盘握手 |
| I6 | 不在仓库里的等于不存在 | `missions/` 全套 + `ensureScaffold()` |
| I7 | 确定性判定归代码,语义判断归模型 | hard 证据零模型成本;升档判据机械可测 |
| I8 | 上下文按相位分层加载 | `before_agent_start` 读 `phases/<phase>.md` |
| I9 | 环境不一致判 INCONCLUSIVE | 指纹比对 + `verdict.ts` 第 1 条 |

---

## 8. 当前边界与已知薄弱点

以下都是**当前代码的真实状态**,不是待办清单。

### 8.1 "AC 可执行" ≠ "AC 有判别力"

冻结时只校验 verify 分支**存在**(`scriptHasBranch()` 正则文本匹配)。
`ac1) exit 0 ;;` 能通过校验。也就是说:AC 必须可执行这条约束挡住了"用户体验良好"
这类不可判定的 AC,但挡不住空壳 target。

### 8.2 quick 档仍然没有 AC,只有一条命令

quick 档不落盘、不走 `validatePlan()`,`acceptanceCriteria` 恒为空,
判定依据是单条 `quickVerifyCommand`,acId 固定为 `"quick"`,也没有子进程 Verifier
交叉核对。**这一档的判定强度天然低于 standard**,是设计取舍(Q18),不是缺陷。

已经收口的部分:那条命令现在必须由 `--verify` 在进 DO 前给出并冻结
(`evaluateAdmission()`),`mission_submit` 不再接受任何参数,执行者无法事后
补一条判定标准。给不出命令的输入会被升档到 standard,走完整的 PLAN + AC 流程。

仍然成立的限制:那条命令本身的判别力没有任何机械校验 —— `--verify "true"`
能过。这与 8.1 是同一个洞的两个入口。

### 8.3 签名归一化粒度未经真实数据校准

`src/core/breaker.ts` 自己标注了这是最需要按实际数据调的参数,当前只有构造用例覆盖。
真实项目的失败输出形态(尤其非 JVM/TS 生态)会暴露归一化的偏差。

### 8.4 其他运行时限制

- mission 是**前台**的:占用当前会话,一次一个。后台批量编排用 pi-subagents。
- 相位切换用 `setActiveTools` 改写工具集,plan/act/check 相位会隐藏其它扩展的工具。
- 并行工具执行下 `tool_call` 不保证看到同批次兄弟工具的结果;闸门只依赖 STATE。
- 内存态不可信:pi 在 newSession/reload/重启时重建扩展实例。所有关键路径
  (session_start、驱动类命令)都从 CURRENT 指针 + STATE.json 重附着。
- 子进程 Verifier 每次 CHECK 冷启动一个 pi 进程;quick 档不用它。
- `test/` 下的 UI 测试需要 `@earendil-works/pi-tui` 等 peer 依赖装好才能加载;
  core 的 49 个单测无外部依赖,`node --test` 直接跑。

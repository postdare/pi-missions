# pi-missions 架构与术语

> 本文描述**当前代码的实际行为**,不是设计意图或路线图。所有断言都指到**文件 + 符号名**
> (`validatePlan()`、`ROLE_OF`、文件头注释),不写行号 —— 行号每次编辑都会漂,
> 一份到处是错行号的文档比没有定位更糟;符号名 grep 得到,而且改名时会被一起发现。
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
│         │                        (挂载见 src/index.ts 的 pi.on)│
│  ┌──────▼─── 扩展进程(本包)──────────────────────────┐   │
│  │                                                     │   │
│  │  src/index.ts        装配层:挂事件、注册工具与命令  │   │
│  │       │                                             │   │
│  │  src/runtime.ts      哑管道:采证据 → judge →       │   │
│  │       │              发事件 → 翻译 Effect            │   │
│  │       │                                             │   │
│  │  ┌────▼─── src/core/ ── 纯函数,唯一裁判 ────────┐  │   │
│  │  │  machine.ts   相位状态机 (state,event)→effects│  │   │
│  │  │  define.ts    DEFINE 的提问闸门 + 范围确认判据   │  │   │
│  │  │  coverage.ts  完成条件 ↔ AC 的覆盖校验           │  │   │
│  │  │  review.ts    计划打回的记账与硬拦                │  │   │
│  │  │  spike.ts     探针任务的额度与结论判据          │  │   │
│  │  │  breaker.ts   失败签名 + 熔断 + 升级判定       │  │   │
│  │  │  verdict.ts   证据 → pass/fail/inconclusive    │  │   │
│  │  │  baseline.ts  冻结时的基线红绿校验              │  │   │
│  │  │  tier.ts      三档与自动升档 + 进 DO 的准入      │  │   │
│  │  └────────────────────────────────────────────────┘  │   │
│  │                                                     │   │
│  │  src/store/   仓库读写(计划/状态/日志/证据/路径)   │   │
│  │  src/hooks/   闸门 + 编辑级增量反馈                  │   │
│  │  src/roles/   角色模型映射 + 进程内 Verifier AgentSession │   │
│  │  src/ui/      主面板 / 状态条 / 卡片                 │   │
│  └─────────────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────────┘
         │ 落盘
         ▼
    <repo>/missions/   ← 状态在这里,不在会话里
```

### core 的纯净性是硬约束

`src/core/types.ts` 文件头写明:core 下所有模块不 import pi、不读文件、不调网络、
除事件携带的 `at` 之外不依赖环境。

这是"L0 是唯一裁判"的物理保证 —— 裁判必须可单测。`npm test` 里 core 的 49 个单测
(breaker 16 / machine 20 / tier 6 / verdict 7)就建立在这条约束上。

### runtime 的角色被刻意收窄

`src/runtime.ts` 文件头写明 runtime **不做任何判定**,只做四件事:

1. 采集证据
2. 调 `judge()`
3. 把事件喂给 `machine`
4. 把返回的 `Effect[]` 翻译成 pi API 调用(`translateEffects()`)

所有"对不对 / 升不升 / 停不停"的决定都在 core 里。

### UI 呈现与纯函数渲染

UI 层同样保持纯函数设计,所有视图接收不可变数据对象并输出终端行数组:
- `src/ui/chrome.ts`: 基础框架积木(圆角盒 `boxTop`/`boxRow`/`boxBot`、`wrap` 悬挂折行、`ruleLabel`、`hintBar`、`tabs`、`miniBar`)。
- `src/ui/panel.ts`: `/missions` 主面板(任务列表、模型页)。
- `src/ui/plan-review.ts`: 冻结前的计划评审页(五段:目标与边界 / 方案 / 验收标准 / 任务 /
  verify.sh 全文;`Enter` 批准、`R` 打回并写意见)。`/mission plan` 用 `readOnly` 打开同一页。
- `src/ui/status-view.ts`: `/mission status` 状态视图与按键交互(支持 `mode: "mission" | "task-detail"` 切换,任务列表焦点下 `↑↓` 选中任务,`Enter` 展开详情,`Esc`/`Backspace` 返回)。
- `src/ui/task-detail.ts`: 任务详情视图纯渲染(任务定义、实时 CHECK 进度、验收标准、全部 attempt 的 stdout/stderr 原始证据、spike 结论正文)。
- `src/ui/dashboard.ts`: 状态卡片与内容分块(`taskBlocks`、`taskLines`、`overviewLines`、`checkProgressLines`、`acLines`、`renderWidgetCard`)。
- `src/store/evidence.ts:readTaskEvidenceHistory()`: 只读聚合磁盘 `missions/state/<id>/evidence/` 历史 JSON,容错解析损坏文件。
- `src/store/check.ts`: L0 独占写入 `CHECK.json`,记录当前子阶段、分支、Verifier 状态与耗时;状态视图每 2 秒读取。

---

## 3. 相位状态机

### 相位(Phase)

`Phase`(`src/core/types.ts`),六个值:

| 相位 | PDCA | 谁在动 | 工具集(`toolsForPhase()`) |
|---|---|---|---|
| `define` | — | LLM(planner) | 只读 + `mission_ask` + `mission_define` |
| `plan` | P | LLM(planner) | 只读 + `mission_write_plan` |
| `do` | D | LLM(executor) | 全部内置工具 + `mission_submit` |
| `check` | C | **L0,没有 LLM 回合** | 只读 |
| `act` | A | LLM(escalator),**只有一轮** | 只读 + `mission_escalate` |
| `done` | — | — | 恢复用户原工具集 |
| `halted` | — | — | 同上 |

### 迁移图

升级阶梯就是这张图上的反向边 —— 升级 = 往回走一格,不是一套外挂机制:

```
DEFINE ─▶ PLAN ──▶ DO ⇄ CHECK ──▶ ACT
  ▲         ▲        ▲                │
  └─ L3 ────┴─ L2 ───┴──── L1 ────────┘
改问题定义   改方案        改实现
```

```
   ┌────────┐ DEFINE_DONE┌──────┐ PLAN_FROZEN ┌──────┐ SUBMIT ┌───────┐
   │ DEFINE │───────────▶│ PLAN │────────────▶│  DO  │───────▶│ CHECK │
   └────────┘            └──────┘             └──────┘        └───┬───┘
       ▲                    ▲                   ▲               │ VERDICT
       │                    │       ADJUST_DONE │   ┌───────────┴───────────┐
       │                    │      ┌────────────┘   │ pass → 下一任务/done  │
       │                    │      │                │ fail → breaker 判定    │
       │                    │  ┌───┴──┐             │ inconclusive → 回 DO   │
       │                    │  │ ACT  │◀────────────┘  (连 3 次 → halted)    │
       │                    │  └───┬──┘  retry(L1)
       │                    └──────┤  escalate L2
       └───────────────────────────┘  escalate L3(人工确认后)
```

`DEFINE_ASKED` 不迁移相位,只记提问账。

### 纯 reducer

```ts
transition(state: MissionState, event: MissionEvent): { state, effects, error? }
```

`transition()`(`src/core/machine.ts`)。非法迁移**不抛异常**,返回 `error` 字段且状态不变,
调用方记录并忽略该事件。

**15 个事件**(`src/core/types.ts`):
`DEFINE_ASKED` `DEFINE_DONE` `PLAN_FROZEN` `PLAN_REJECTED` `SUBMIT` `VERDICT` `ADJUST_DONE`
`ESCALATE` `ESCALATION_CONFIRMED` `ESCALATION_REJECTED` `HANDOFF_REQUEST` `HANDOFF_DONE`
`PROMOTE_TIER` `RECORD_ROLE_COST` `ABORT`

**11 个效果**(`Effect`,`src/core/types.ts`):
`SET_TOOLS` `SET_ROLE` `HANDOFF` `LOG` `CONFIRM` `ADVANCE_TASK` `FREEZE_AC`
`PERSIST_PLAN` `ARCHIVE_PLAN` `RESTORE` `NOTIFY`

机器一条 Effect 都不执行,全部交给 `runtime.translateEffects()` 翻译。

---

## 4. 术语表

### 4.1 最容易混的一组:L0 vs L1/L2/L3

**这两套编号不是同一个维度。**

- **L0** —— 层级概念,指扩展进程里的纯代码裁判(相对 L1 = LLM 执行者的分层)。
  "L0 亲自跑 verify.sh"就是这个意思。
- **L1/L2/L3** —— `EscalationLevel`(`src/core/types.ts`),**升级阶梯**:

| 级别 | 含义 | 改什么 | 落点 |
|---|---|---|---|
| L1 | 改实现 | 代码 | ACT → DO(默认级别,`escalation.level` 初值 1) |
| L2 | 改方案 | 任务分解,**AC 不变** | 回 PLAN,强制换脑 |
| L3 | 改问题定义 | **可改 AC**,需人工确认 | 回 **DEFINE**,归档旧计划 + 换脑 + 重置提问预算 |

`escalation.level` 是 **mission 级**的单调递增值,`ESCALATE` 的 handler(`src/core/machine.ts`)拒绝降级。

### 4.2 档位(Tier)

`quick | standard | complex`(`Tier`,`src/core/types.ts`)。**升档自动,降档手动。**

| | quick | standard | complex |
|---|---|---|---|
| 入口 | `/mission quick <任务>` | `/mission new` | `/mission new --tier=complex` |
| 起始相位 | `plan`(定判据后冻结进 DO) | `define` | `define` |
| 落盘 | 否(`inMemory: true`) | 是 | 是,里程碑分文件 |
| 判定依据 | 一条 `QuickCriterion`(ai/human/command),**进 DO 前冻结** | verify.sh 分支 + 进程内独立 Verifier | 同左 + 里程碑回归 |
| 熔断阈值 | 2 | 3 | 3 |
| 尝试硬上限 | 4 | 9 | 12 |
| 任务切换换脑 | 否 | 否 | **是** |

阈值见 `src/core/breaker.ts` 的 `THRESHOLD` 与 `ATTEMPT_HARD_CAP`。

升档判据在 `evaluatePromotion()`(`src/core/tier.ts`),全部机械可测:
触及公开 API / 改动 > 5 文件 / quick 档第 2 次尝试 / standard 档 2 次 L2。
**刻意不让 LLM 自评"这任务复杂吗"**(I7)。它在 `Runtime.maybePromote()` 里检查,
由 `onAgentSettled` 的两处调用触发 —— 注意 ACT 分支处理完 `ADJUST_DONE` 后**不能提前
return**,否则"phase=do 且 attempts>=2"的时刻永远不会出现(DO 相位每一轮都以
`mission_submit` 结束,相位当场变 check),quick 的这条逃生梯就是空的。升档判定还必须
排在 DO 简报**之前**:升档会挂起换脑,先发一句"进入 DO"再换脑是在骗下一个会话。

**从 quick 升档一律回 PLAN + 挂换脑 + 先落盘**,由 `promoteFromQuick()`
(`src/core/machine.ts`)统一实现,两个入口共用:熔断(`decide()` 返回 `promote`)
与机械升档(`PROMOTE_TIER`)。

理由是结构性的 —— **quick 根本没有计划**(`acceptanceCriteria` 空、`verifyScript` 空串),
升档的全部意义就是把那一条判据摊开成冻结 AC + verify.sh,而那只能在 PLAN 相位做。
两个入口曾经各写各的,`PROMOTE_TIER` 那份只改 tier 不改相位,留下一个
tier=standard / phase=do / 没有任何 AC 的 mission;而 `runCheck` 是按
`state.tier === "quick"` 分流的,档位一变它就不再看那条冻结判据,转去跑空的 `verify.sh` ——
采不到证据判 inconclusive,回 DO 再来一遍,三次之后停机,人工终审的判据从此再没被问过。
**quick 只要失败一次就必然走进这条路**,所以 quick 的"重试"一次都不成立。

`PERSIST_PLAN` 必须排在一切 LOG 之前(`inMemory` 期间 LOG effect 是空操作,目录还没建
出来就写等于把失败原因扔了)。相对地,L2 对 quick 是空的:它没有"方案"可改,回 PLAN
唯一能改的就是判据本身,而那是事后修改判定标准(I2/I3 的反面)。

standard → complex 不走这条路 —— 它已经有计划了,`PROMOTE_TIER` 只改档位。

### 入口守卫(quick 的判据闸门)

quick 起于 `plan` 相位,那个相位**只有只读工具 + `mission_criterion`**
(`toolsForPhase(phase, tier)`)。所以"判据先于写代码冻结"是工具集的物理保证,
不依赖任何入口参数,也不需要问人 —— 开工前多一次交互,小任务就不值得开 mission。

判据由 AI 看过代码之后自己提出,过 `evaluateCriterion()`(`src/core/criterion.ts`)
的机械闸门:太短 / 复读目标 / 空泛且无具体锚点,一律退回重写(与 `evaluateAsk()`
拒绝"没有推荐答案的懒问题"同形)。

判据带一个 `judge`,决定谁来核对:`ai`(独立 Verifier,默认)、`human`(人工终审)、
`command`(退出码)。三者产出的证据级别不同(semi / human / hard),但都在执行者
之外 —— **I3 要的是判定权外置,不是判定必须可执行**。

`mission_submit` 因此**不接受任何参数**:提交路径上没有任何"补一条标准"的入口。

> 历史:这里原来是 `evaluateAdmission()`,要求 quick 必须带 `--verify`,
> 否则升档 standard。那是把 I3 收窄成了"判定必须可执行",把大量
> "说得清但写不出 shell 断言"的任务(改样式、调交互)挡在了快车道外。

### 4.3 角色(Role)

`planner | executor | verifier | escalator`(`Role`,`src/core/types.ts`)。两个用途:

1. **模型映射** —— `missions/models.json` 给每个角色配 provider/model/thinking
   (`src/roles/models.ts`),进相位时 `applyRole()` 切换。默认 thinking:
   planner=high、escalator=high、verifier=off。
2. **成本分账** —— `state.cost` 是 `Partial<Record<Role, number>>`(美元),
   `state.tokens` 是 `Partial<Record<Role, RoleTokenUsage>>`(input/output/cacheRead/
   cacheWrite 逐字段累计)。两本账并列的原因:自建网关常不报价(`cost.total = 0`),
   美元账是空的但 token 账永远是真的 —— verifier 的 `RECORD_ROLE_COST` 无条件记,
   面板/widget 在美元为零时改显 token。`/mission models` 查看每个角色的花费。

相位到角色的映射是常量表 `ROLE_OF`(`src/core/machine.ts`),
`done`/`halted` 映射到 `null`。

**面板编辑**(`/missions` 的「模型」页,`src/ui/models-page.ts`)直接写
`missions/models.json`。三条设计约束:

- 显示 `resolveRoleView()` 解出的**实际生效值**,不是配置值 —— `applyRole()` 在模型
  不可用时静默回退会话模型,只 warn 一次,照抄配置会误导成本判断
- 模型列表取 `ctx.scopedModels`(pi 文档指定的 picker 数据源),空则回退
  `modelRegistry.getAvailable()`
- 改动写 LOG.md;改的若是当前相位的角色则立刻 `applyRole`,否则等下次相位切换。
  verifier 变更额外告警:它是 I3 的独立判定者,中途更换意味着前后 semi 证据不同源

### 4.4 DEFINE(问题定义)

`Phase = "define"`,standard/complex 的起始相位(`START_PHASE`,`src/core/machine.ts`)。

**存在的理由**:AC 必须在 PLAN 冻结且必须可执行(I2)。需求模糊时写不出这样的 AC,
系统的入口条件就不成立;此时 agent 的行为是可预测的 —— **它会编一条 AC 出来凑格式**,
然后整套判定建立在一条假标准上。DEFINE 把 L3(改问题定义)提到最前面。

**三类模糊**(决定该走哪个出口,写在 `templates/phases/define.md` 里):
描述不清 → `mission_ask`(答案在人脑子里);事实不明 → 自己读代码,读不出来就进 PLAN 排
spike(答案在代码里,问人无效);方案未定 → 自己造选项、带推荐答案去问。

**两个工具**:

- `mission_ask({questions[], settled[]})` —— 把"不知道就写不出完成条件"的问题交给人。
  闸门由 L0 强制(`evaluateAsk()`,`src/core/define.ts`),四条:
  ① 每个问题必须带 `recommend`(推荐答案)与 `impact`,缺一即拒;
  ② 一轮 ≤ `DEFINE_QUESTION_CAP`(3);
  ③ 轮次上限按档位(`roundCapFor`:standard 2、complex 3、quick 0);
  ④ **结账判据** —— 第二轮起要求 `settled.length` 严格大于上一轮的快照。
  轮数记在 `state.defineAsks`、快照记在 `state.defineSettled`(事件 `DEFINE_ASKED`)。

  通过闸门后弹出**交互问答页**(`openAskReview`,`src/ui/ask-review.ts`):阻塞 `ctx.ui.custom`,
  ↑↓ 选选项(推荐项默认选中)、E 自定义答案、Tab 切题、Esc = 人中断。
  答案经 `normalizeAskAnswers()` 规整后走 `DEFINE_ANSWERED` 落进 `state.defineAnswers`,
  同时以信封形式直接回到工具结果 —— 模型照抄进 `mission_define.resolved`,不再靠转抄。
  **Esc 中断与回答都消耗轮次**:否则模型可以反复问反复中断原地打转。
  没有 UI 的宿主(RPC/ACP)直接拒绝,并指引模型改在聊天里提问。
  ①改变了提问的经济学:推荐项在问答页里选中高亮,人确认或改选即可,一轮的成本从
  "写一段需求"降到"回车",于是轮数付得起。④负责收敛,与 `breaker.ts` 同构 ——
  那里数"同一失败签名连续出现",这里数"提问没有推进决策"。

- `mission_define({goal, doneWhen, constraints, nonGoals, verifySeam?, resolved?})` ——
  写进 `plan.definition`,发 `DEFINE_DONE` 进 PLAN。三条运行时守卫在 `Runtime.define()`:
  `doneWhen` 不能为空;调用过 `mission_ask` 就必须交 `resolved`(问答落盘 ——
  人的回答只活在上下文里,换脑即丢,而额度已经烧掉);
  `needsScopeConfirm(tier, defineAsks)` 为真时先弹**范围确认**
  (complex 恒确认,standard 仅当问过至少一轮),被拒则停在 DEFINE 且轮次不返还。

  范围确认走 `ctx.ui.confirm` 而不是 `CONFIRM` effect —— 它与 PLAN 的冻结确认同形状
  (确认在事件之前、拒绝则相位不动);`CONFIRM` effect 那条路是给机器**主动发起**的
  L3 用的,套过来要给状态机加一个"等确认"的中间态,不值得。

**退出条件**:目标本身仍然判不了"够不够清楚"(见 8.3)。但**判不了"清楚",
不代表判不了"覆盖"** —— `doneWhen` 与 `AcceptanceCriterion.covers` 之间有一条机械判据:
`evaluateCoverage()`(`src/core/coverage.ts`)要求每条 DW 至少被一条 AC 覆盖(没漏)、
每条 AC 至少覆盖一条 DW(没夹带),在 `writePlan()` 里与 `validatePlan` 并列执行。
覆盖校验只在 `plan.definition` 存在时跑 —— quick 档不经过 DEFINE 相位。
反过来说,**definition 一旦存在,`doneWhen` 就必须非空**(空数组本身是错误),
每条 AC 也必须带 `covers`:开发期不留可以为空的口子,否则这条判据等于没有。

这条边让升级阶梯的三级第一次各有物理落点:L1 → 代码;L2 → `plan.approach`;
L3 → `definition.doneWhen` / `nonGoals`。

**角色复用 planner**:同一种"读代码 + 想清楚问题"的工作,不为一个只跑一两轮的相位
在 models.json 和成本分账里多开一个维度。代价是 DEFINE 的花费并进 planner 账下。

### 4.5 AC(验收标准)与 verify 分支

```ts
{ id: "AC1", text: "人类可读的验收描述", verify: "auth-integration", baseline: "red", covers: ["DW1"] }
```

**`verify` 不是命令,是当前 mission generation 中 `verify.sh` 的一个分支名**
(`AcceptanceCriterion.verify`:"不写裸命令")。判定时 L0 从 SNAPSHOT 取 generation,
校验脚本 hash,再执行 `bash missions/state/<id>/generations/<n>/verify.sh auth-integration`,
取退出码(`runBranch()`,`src/runtime.ts`)。

这是整个设计的枢纽:**AC 必须有可执行入口,否则写不进计划。**
`validatePlan()`(`src/store/mission.ts`)在冻结前校验:

- 至少一条 AC、至少一个任务、goal 非空
- 每条 AC 必须有非空 `verify`
- 每个任务必须至少有一个 verify 分支("无法判定的事不该进入 DO")
- 所有 verify 分支必须能在 verifyScript 文本里找到
  —— `scriptHasBranch()`(`src/store/mission.ts`)正则粗检 `name)` / `"name"` / `name()`
- complex 档必须有 `approach`(summary 与 decisions 非空,每条决策有 `why`)

`covers`(这条 AC 覆盖哪几条完成条件)不在这里校验 —— 它判的是**两份产物之间的关系**,
归 `evaluateCoverage()`(4.4),在 `writePlan()` 里与 `validatePlan()` 并列执行。

### 4.6 冻结(Freeze)

`mission_write_plan` 是对外原子发布:plan/state/handoff 与冻结件由同一个 v2 snapshot
revision 绑定。磁盘写入顺序固定:

1. 在 `generations/.tmp-<n>-<uuid>/` 写 MISSION.md 与 verify.sh
2. 计算并记录两者 SHA-256
3. 原子 rename 为不可变 `generations/<n>/`
4. 以 CAS 校验 expected revision,最后原子替换 SNAPSHOT.json

进程在第 4 步前退出,旧 SNAPSHOT 仍指向旧 generation;第 4 步后退出,新 snapshot
已经完整可读。CURRENT 只是定位提示,其 revision 落后时以 SNAPSHOT 为准。
冻结路径有四道关,顺序固定:

1. **结构校验** —— `validatePlan()`(AC/任务/verify 分支的完整性,以及 complex 的
   `approach` 必填)+ `evaluateCoverage()`(完成条件覆盖)+ `validateSpikePlan()`(探针额度)
2. **人工评审** —— `openPlanReview()`(`src/ui/plan-review.ts`),最重要的一次人工介入。
   五段可滚动:目标与边界 / 方案 / 验收标准 / 任务 / **verify.sh 全文**。
   见 4.6.2
3. **基线跑** —— 落 verify.sh,逐条跑 AC 分支,`evaluateBaseline()` 核对红绿(见 4.6.1)
4. **冻结** —— 发布 generation + SNAPSHOT、发 `PLAN_FROZEN`,记录环境指纹并提示提交 git

前三关任意一关不过,计划都不冻结,相位停在 PLAN,错误信息回给 planner 自己修。
基线跑放在人工确认**之后**是刻意的:PLAN 相位不执行任何东西(工具集里没有 bash),
这一跑属于进入 DO 的过渡动作,而且跑的是人刚刚批准的那份脚本。

#### 4.6.1 基线判定

`evaluateBaseline()`(`src/core/baseline.ts`,纯函数):

| AC 的 `baseline` | 冻结时要求 | 含义 |
|---|---|---|
| `red`(缺省) | 必须失败 | 红→绿才是证据;一上来就绿 = 空壳,或该 AC 不该进这个 mission |
| `green` | 必须已通过 | 回归项;此刻就红 = 基线本来就坏了,无法区分是谁改坏的 |

外加:**至少一条 `red`**;分支跑不起来(exit 126/127)不算红。

这一关补的是 `validatePlan` 补不了的洞:结构校验只能证明分支**存在**,
`ac1) exit 0 ;;` 完全合法。基线跑要求分支拿出一次真实的红。

反向作弊(恒 `exit 1`)骗得过基线,但任务永远绿不了,熔断推到停机 ——
代价落在作弊者自己身上,是刻意的不对称。

**基线只在首次冻结跑**(`shouldProbeBaseline()`)。L2/L3 重规划时执行者已经改过世界,
先前的红可能因为部分任务做完而变绿;此时仍要求"red AC 必须红"会把重规划直接锁死 ——
而 L2 的定义就是 AC 不变、只改方案,planner 连改 AC 脱身的余地都没有。
冻结时刻的红绿只在干净基线上是可判定的信号。

冻结后 AC 只读,由三道锁保护:

1. **工具集** —— DO 相位没有 `mission_write_plan`
2. **闸门** —— `gateCheck()` 的冻结件分支(`src/hooks/gate.ts`)拦整个
   `missions/state/` 的 edit/write,包括 SNAPSHOT 与所有 generation
3. **bash 粗检** —— `gateCheck()` 的 bash 分支拦 `>` `sed -i` `tee` `rm` 等写操作
   指向受保护路径

#### 4.6.2 计划评审与打回

原来这一关是一个 `ctx.ui.confirm`:整份计划被压成一段字符串(目标 + AC 行 + "任务数:8"),
任务本体、里程碑、方案、verify.sh 全文都看不到 —— 等于让人批准一份没读过的合同。
而拒绝返回的是一句死字符串,**"反馈"没有任何载体**,planner 只收到 1 bit。

现在:

- `openPlanReview()` 摊开五段(`Tab`/`←→` 切段,`↑↓` 各自滚动),`Enter` 批准、`R` 打回。
  渲染是纯函数 `renderPlanReview()`,进 `test/render.test.ts` 的宽度矩阵与
  `test/theme-colors.test.ts` 的严格主题。
- 打回意见在**关页之后**由 `Runtime.rejectPlan()` 用 `ctx.ui.editor` 收 ——
  在 `ui.custom` 里嵌一层 `ui.editor` 会把 TUI 叠坏。意见回传 planner,并落
  `state.planReview.notes`、LOG.md 与 State Card 的 `PREV REJECTION`(换脑后仍读得到)。
- 记账与硬拦在 `evaluatePlanReview()`(`src/core/review.ts`,`PLAN_REJECT_CAP = 3`):
  到上限时 `PLAN_REJECTED` 走**与 `ESCALATION_CONFIRMED` 相同的落点** ——
  `phase = define`、`escalation.level = 3`、重置 `defineAsks`/`defineSettled`、
  `ARCHIVE_PLAN` + `HANDOFF`。理由:同一份问题定义下改了三版方案人都不满意,
  问题多半不在方案;继续在 PLAN 里磨等于在错的问题上做高质量的工作。

冻结之后 `/mission plan` 用同一份 snapshot 渲染只读页面。现在 goal/definition
从 mission 创建起就进入 SNAPSHOT,冻结时再发布新的 generation:
snapshot 中的 plan/state 是换脑与重启后 `attach()` 的恢复锚点(I1),否则 define/plan 阶段的
mission 一旦会话重建就永久失联。

### 4.7 证据(Evidence)三级

`EvidenceLevel`(`src/core/types.ts`)的文档注释:

| 级别 | 来源 | 成本 | 能否触发 PASS |
|---|---|---|---|
| **hard** | L0 直接跑 verify.sh 拿退出码 | 零模型成本 | 能 |
| **semi** | 进程内独立 Verifier AgentSession 逐条核对 AC | 一次只读 AgentSession | 能 |
| **soft** | 执行者自述 | — | **永远不能**,只能触发 ACT |

**semi 的独立性靠会话隔离**:`src/roles/verifier.ts` 用 pi SDK 的
`createAgentSession` + `SessionManager.inMemory` 起一个 in-memory 会话,
只给只读工具(read/grep/find/ls + 结构化 `mission_verdict`,没有 edit/write/bash),
喂 git diff + 冻结的 AC + hard 结果,逐条核对后调 `mission_verdict` 返回结论。
它**不能写文件** —— `templates/phases/check.md` 写明理由:
"验证者一旦能改代码,就会顺手修一下然后判自己通过"。Verifier 不写盘、不挂 pi
扩展(`ResourceLoader` 显式置空),结论只通过工具参数回到 L0,判定权仍在
`judge()`。配置的 verifier 模型解析不到时显式降级 hard-only,不静默退回会话模型。

#### 4.7.1 探针任务(spike)

`PlanTask.kind = "spike"`(缺省 `"impl"`)。用于**答案不在人那里、在代码里**的模糊:
私有 API 用在几处、瓶颈在哪一层、升级报几个错。这类问题 `mission_ask` 无效。

三条约束,每条都有机械实现:

| 约束 | 实现位置 |
|---|---|
| 产物是书面结论 | `gateCheck` 的 `spikeReportPath`:edit/write 只放行结论文件;bash 的写操作全挡 |
| 一次 attempt,不进 ACT/熔断 | `spikeTransition()`(`src/core/machine.ts`)在 `failTransition` 之前分流 |
| 强制以重写 PLAN 结尾 | 同上:pass/fail 都 → `phase: "plan"` + `ARCHIVE_PLAN` + `HANDOFF` |

**判定**复用现有证据分级,不引入第四种证据:

- **hard** —— `reportIsSubstantive()`:结论文件 ≥ 80 字(挡 `TODO` 与空文件),零模型成本
- **semi** —— `renderSpikeVerifierBrief()`:独立验证者核对结论是否**正面回答了 `question`**,
  并抽查它引用的事实;答非所问、只有"需要进一步调研"、或探针改了实现,判 fail

**额度**:每个 mission 最多一个 spike(`validateSpikePlan()`)。计数记在
`state.spikesRun` 而不是扫 `tasks` —— 重写计划时 `PLAN_FROZEN` 只保留新 taskOrder 里的
任务,跑过的 spike 会从 `tasks` 里消失,靠扫描会把额度还回来。

**为什么强制回 PLAN 而不是直接接着做**:spike 后面的任务是基于未知写的,本来就该重写;
更重要的是,允许探针的产出直接进实现,等于给了一条"在没有 AC 的状态下改代码"的通路,
绕过整个验证闸门。换脑也是必须的 —— 探针上下文里全是调研噪音(I5)。

### 4.8 判定(Verdict)

`judge(evidences, options)`(`src/core/verdict.ts`),七条优先级自上而下命中即返回:

```
0. 无证据                → inconclusive   ← 防"没跑就算过"
1. 环境指纹不符          → inconclusive   ← I9
2. 必需范围内的证据
   inconclusive          → inconclusive   ← 范围外 AC 的无结论只是信息:
                                             CHECK 按任务收集证据,挂在后续任务的
                                             AC(典型:lint/build 回归)verifier 永远
                                             判不出,让它阻断 = 当前任务注定熔断
3. 任一 hard fail        → fail
4. 必需 AC 缺证据        → inconclusive   ← 防漏跑当通过
5. 任一 semi fail        → fail           ← 范围外也算:改坏了别人的回归项要拦
6. 只有 soft 证据        → inconclusive   ← I3
7. 其余                  → pass
```

`inconclusive` 是第三态,**不是失败**:不计 attempts、不进熔断、直接回 DO
(`VERDICT` 的 handler,`src/core/machine.ts`)。但连续 `INCONCLUSIVE_STREAK_CAP = 3` 次
(`src/core/machine.ts`)直接停机等人 —— 环境没人修,重试没有意义。

**防空转与补证据闸门**:
`verdict.ts` 对 `inconclusive` 进行三因分类(`inconclusiveCause`,见 `core/types.ts` 的
`InconclusiveCause`)。成因决定处置与文案 —— 说错成因等于把人指到错误的方向:
- `env`:环境指纹漂移。无需改代码,不受补证据闸门限制(仅受连续 3 次停机兜底)。
- `evidence`:缺机械断言、范围内核验无结论或仅有 soft 证据。此时状态机在当前任务挂起 `awaitingEvidence`,记录提交时的工作区树指纹(`treeFp`)及缺失的 `missingAcIds`。
- `judge`:**裁判本身不可用** —— 独立 Verifier 被 provider 打回、模型解析不到、非 TUI 下人工终审弹不出来。由 `check-runner.ts` 把原因经 `judge()` 的 `judgeUnavailable` 传入,只改写"因缺证据而无结论"那一类(hard 证据够判 pass 的照旧 pass,降级 hard-only 是设计)。**首轮即停机**:执行者改什么都换不来一个能用的裁判,回 DO 只是拿同一个坏裁判再空转一轮。也不挂 `awaitingEvidence` —— 它补不出这份证据。
- **重交拦截**:在工作区未发生任何改动(git tree 指纹一致)时,执行者原样再次调用 `mission_submit` 会被状态机直接拦截并拒绝迁移,促使其补充有效机械断言或修改代码;当工作区产生修改(`treeFp` 变化)后放行,或通过 `mission_escalate` 升级方案。非 git 仓库自动退化放行。

### 4.9 失败签名(Signature)与熔断(Breaker)

**签名** —— 把失败输出压成稳定的规范串再哈希。`normalize()`(`src/core/breaker.ts`)
丢弃行号、绝对路径、时间戳、耗时、对象 hash、UUID,只保留四类 token:

- `test:AuthTest#refreshToken` —— 测试标识
- `throw:NullPointerException` —— 异常类型
- `assert:expected-but-was` —— 断言**种类**(刻意不保留期望值/实际值)
- `diag:ts2345` —— 编译/类型错误码

抽不到任何 token 时退化为前三行的紧凑形式,而不是"永不相同"。
最终 `sha256` 取前 12 位,`acId` 参与签名(`signatureOf()`),
不同 AC 的相同异常不会被合并。

`src/core/breaker.ts` 文件头标注这是**全文件最需要按实际数据调的参数**:

- 归一化太严 → 同一病根算作不同失败,熔断永不触发
- 归一化太松 → 不同问题被合并,误熔断

**熔断** —— `decide()`(`src/core/breaker.ts`),优先级:

```
attempts >= ATTEMPT_HARD_CAP   → halt      (签名一直在变也不许无限试)
同一签名连续 >= THRESHOLD      → escalate  (已在 L3 则 halt,没有 L4)
其余                           → retry     (进 ACT 诊断一轮)
```

熔断判定**已并入状态机**(`src/core/machine.ts` 文件头):`VERDICT(fail)` 到达时
机器内部直接调 `decide()`,签名计数也在机器内更新。hooks 层不做任何决策。

### 4.10 换脑(Handoff)

**I5:每次升级必须换干净上下文。** 实现分两半:

**软的一半** —— `ctx.newSession()` 创建新会话,只携带当前 generation 的 MISSION.md 投影 + LOG.md 失败记录
+ 最后一次失败证据,不带污染对话。

**硬的一半** —— `state.pendingHandoff`(`src/core/types.ts`)。非 null 时
闸门硬阻断一切非只读操作(`gateCheck()` 的第一条分支),唯一出口是 `/mission next`
发 `HANDOFF_DONE`。状态机层面也拒绝 `PLAN_FROZEN` 与 `SUBMIT`。

**握手走磁盘,不走内存** —— HANDOFF_REQUEST 先把 UUID token、父 session、
requested revision 与原因绑定进 SNAPSHOT;`newSession.setup()` 再写
`pi-missions-handoff` custom marker。新会话的 `session_start` 只有在 reason、
parent session、token、revision 全部匹配时才发 `HANDOFF_DONE`。
普通 startup、错误 token 或陈旧 revision 都不能消费挂起请求;用户取消 newSession
则显式发 `HANDOFF_CANCELLED`,解除硬阻断。

### 4.11 闸门(Gate)

两层粗细(`src/hooks/gate.ts`):

1. **`setActiveTools()`** —— 粗粒度,LLM 看不到的工具不会调
2. **`tool_call` 钩子** —— 细粒度,防 shell 绕过、防写冻结件

`src/hooks/gate.ts` 文件头有一条重要约束:**闸门只依赖 STATE,不依赖"上一个工具的
结果"** —— 并行工具执行时序不保证。

`BUILTIN_ALL` 必须与 pi 的内置工具全集(`ToolName`,八个)保持一致。`powershell` 与
`bash` 共用同一份 schema、同一种能力,漏掉它有两个后果:Windows 用户一开 mission 就
没了 shell,而第 2 层的命令粗检也管不到它 —— 少一个名字等于给冻结件写保护开一条旁路。
所以第 2 层按 `SHELL` 集合判,不按单个工具名。

#### 4.11.1 工具集是白名单,所以它同时是"用户现场"

`toolsForPhase()` 返回的是**全量白名单**,`setActiveTools()` 按名字设活跃工具、
忽略未知名字。因此 mission 一开始,用户装的第三方扩展(subagent、todo、MCP 桥接……)
注册的工具在**所有相位**都被摘掉,不只是只读相位 —— DO 相位返回
`[...BUILTIN_ALL, "mission_submit"]`,同样是白名单。

这是刻意的(理由见 8.7),但它有一个必须成对出现的义务:**摘掉的要还回去。**
`saveProfile()`(`src/roles/models.ts`)在 mission 开始时连同模型/thinking 一起记下
`getActiveTools()`,随 `profile.json` 落盘;`Runtime.toolsForActivePhase()` 在
done/halted 时还原它,而不是发一套本扩展想象中的内置全集。

> 历史:这里原来一律发 `[...BUILTIN_ALL, ...MISSION_TOOLS]`,而 `SavedProfile` 根本
> 不存工具集(pi 有 `getActiveTools()`,`src/` 里一次都没调过)。于是被摘掉的第三方
> 工具在 mission 结束后**永远回不来**,得重开会话。那是 bug,不是取舍。

### 4.12 环境指纹(Env Fingerprint)

`missions/scripts/env-fingerprint.sh` 的输出哈希。冻结时记录一次
(`state.envFingerprint`),每次采集证据时重算。不符 → 整份判 `inconclusive`
而不是 `fail`(I9)。理由(`src/core/verdict.ts` 文件头):**判 fail 会让 agent 去改代码,
而病根在环境。**

### 4.13 State Card

`before_agent_start` 钩子注入的一段结构化文本(`renderStateCard()`,`src/runtime.ts`),每轮对话都带:

```
[MISSION] <id> · <tier> · phase=<phase> · task=<T1> · attempt=<n>
GOAL: ...
AC(冻结,不可修改):
  - AC1: ./missions/state/<id>/generations/<n>/verify.sh auth-integration 退出码 0 —— <描述>
CURRENT TASK: T1 <标题>(verify: auth-integration)
PREV FAILURE: <上一轮失败原因>
⏸ 换脑挂起中:<原因>。请执行 /mission next。
```

同一钩子把相位提示词追加进 system prompt —— **I8:走到哪一步读哪一层**。
选哪一份由 `phasePromptFor()`(`src/phase-prompts.ts`)决定,它按的是**判定装置**
而不是档位名:

- standard/complex 读 `missions/phases/<phase>.md`。提示词在仓库里,用户可改,
  改了就是规范(I6);文件被删则走 `FALLBACK_PHASE_RULES`。
- quick 走内联的 `QUICK_PHASE_RULES`,**完全不碰那个目录**。quick 不铺脚手架,
  那里若有东西必然是别的 mission 留下的 —— 事故就出在这里:quick 在跑过 standard
  的仓库里读到 `plan.md`,被指去调用 `mission_write_plan`(闸门里没有这个工具),
  又在 `do.md` 里被指去跑不存在的 `verify.sh`。
- 分流点不是 `tier === "quick"`:`evaluatePromotion` 在 ACT 之后发 `PROMOTE_TIER`,
  只改档位、不改相位也不改判据,此刻 tier 已是 standard 而 verify.sh 依然不存在。
  所以 PLAN 相位看档位(两者产出物不同),其余相位看**有没有冻结的 AC**。
  (`PROMOTE_TIER` 后来被修成从 quick 升档也回 PLAN,见 `promoteFromQuick()`;
  这条分流规则仍然保留 —— 它防的是"档位与判定装置脱节"这一类,不是那一个 bug。)

### 4.14 tick(内层循环驱动)

`agent_settled` 是**唯一安全的判定点**(`onAgentSettled()`,`src/runtime.ts`)。按相位分流:

- `check` → 跑 `runCheck()`(采证据 → judge → 发 VERDICT)
- `act` → 发 `ADJUST_DONE` 回 DO(**ACT 就是一轮,不给第二轮**),再走一次升档判定
- `do` / `plan` / `define` → 机械升档判定(`maybePromote()`)+ 上下文水位换脑

对话的推进靠 `sendUserMessage(..., { deliverAs: "followUp" })`:判定完给 LLM 发一条
DO brief 或 ACT brief,循环自己转起来。

### 4.15 两层循环

README 标题里的"双层循环":

- **外层 PDCA** —— 任务级:PLAN→DO→CHECK→ACT,管分解与进度
- **内层操控循环** —— 两个粒度:
  - 任务级自我修正:CHECK 失败 → ACT 诊断一轮 → 回 DO
  - **编辑级**:`src/hooks/diagnostics.ts`,edit/write 成功后 debounce 800ms
    后台跑配置的 `incrementalCheck`(如 `npx tsc --noEmit`),发现问题当场 steer 回灌。
    理由:"lint/类型检查是每次编辑后立刻可得的,没理由攒到 CHECK"。
    命令未配置则关闭 —— 通用扩展无法发明跨语言的增量检查器,这是诚实的边界。

### 4.16 其余术语

| 术语 | 含义 | 位置 |
|---|---|---|
| **inMemory** | quick 档不落盘,计划与状态只在内存;升档时 `PERSIST_PLAN` 补写 | `MissionRuntimeState.inMemory`,`src/runtime.ts` |
| **CURRENT 指针** | `missions/state/CURRENT`,仅定位活跃 mission;revision 落后不覆盖 snapshot | `currentPointer()`,`MissionRepository.loadCurrent()` |
| **profile** | 用户原本的模型/thinking 现场,mission 开始时保存、结束时 `RESTORE` 恢复;随 mission 落盘以便跨会话接力 | `src/roles/models.ts` |
| **里程碑(Milestone)** | complex 档的任务分组;里程碑最后一个任务重跑整组 verify 分支(回归) | `isLastTaskOfMilestone()`,`src/store/mission.ts` |
| **generation** | 一组不可变 MISSION.md + verify.sh 投影,由 SNAPSHOT 中 generation 与 hash 绑定 | `MissionRepository.stagePlan()/publishStaged()` |
| **降级模式** | 目标目录非 git 仓库:AC 冻结只剩 L0 闸门,无 git 审计链,semi 证据跳过(需要 git diff) | `src/store/git.ts` |

### 4.17 LLM 可调用的工具

五个(`src/tools.ts`),按相位分发,外加 Verifier 会话里的第六个:

| 工具 | 相位 | 作用 |
|---|---|---|
| `mission_ask` | DEFINE | 提问(每轮 ≤3 且每问带推荐答案;standard 2 轮 / complex 3 轮;要结账。L0 强制) |
| `mission_define` | DEFINE | 交出目标 + **完成条件** + 约束 + 非目标 + 接缝 + 问答记录,进入 PLAN |
| `mission_write_plan` | PLAN | 原子提交**方案** + AC(含 `covers`)+ 任务分解(含 spike)+ verify.sh 内容 |
| `mission_submit` | DO | 声明已提交,触发判定(**不等于通过**)。无参数——判定依据早已冻结 |
| `mission_escalate` | ACT | 主动升级 L2/L3 |
| `mission_verdict` | — | 只存在于 Verifier AgentSession(`defineTool` 结构化参数),逐条 AC 提交结论 |

**没有任何工具能直接改 SNAPSHOT.json。** 状态推进全部由 L0 事件驱动并经 Repository CAS 提交。

---

## 5. 一次完整的 DO→CHECK 时序

在此之前,一个 standard mission 的开头是:

```
/mission new "让登录快一点"
  │  startNew → START_PHASE.standard = define → SET_TOOLS(define) + planner
  ▼
DEFINE:LLM 读代码 → mission_ask(每轮≤3,每问带推荐答案)→ 交互问答页阻塞收答案
  │                └→ evaluateAsk 拒掉:没推荐答案 / 超额 / 超轮次 / 上一轮没结账
  │  答案落 state.defineAnswers + 工具结果信封 → 可以再问一轮(settled 必须变长;Esc 中断也算一轮)
  ▼
mission_define(goal + doneWhen + resolved 照信封抄)→ 范围确认 → DEFINE_DONE → PLAN
  ▼
PLAN:mission_write_plan → validatePlan + evaluateCoverage → 计划评审页
  │                        └→ R 打回:意见回传 planner,累计 3 次转 L3 回 DEFINE
  ▼                     批准 → 基线跑 → 冻结 → DO
```


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
  │  1. 建立 CHECK.json(stage=preparing),随后每个子阶段原子更新
  │  2. 算环境指纹
  │  3. 逐个跑 verify.sh <分支> 拿退出码           → hard 证据
  │     CHECK.json 同步记录当前分支、已完成分支与耗时
  │  4. 起进程内 Verifier AgentSession,喂 AC + hard 结果 + diff → semi 证据
  │     记录 running/completed/timeout/skipped/degraded
  │  5. judge(evidences, { expectedFingerprint, requiredAcIds }) → Verdict
  │  6. 完整命令、开始时间、耗时、exitCode、stdout/stderr
  │     归档到 missions/state/<id>/evidence/
  │  7. CHECK.json(stage=completed,outcome=...) + verdict 卡片
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
├── phases/{define,plan,do,check,act}.md  相位提示词 ← 进哪个相位读哪个
├── scripts/
│   └── env-fingerprint.sh         环境指纹
├── models.json                    角色 → 模型映射(可选)
├── spikes/<id>/<taskId>.md        探针结论(执行者在 spike 任务里唯一能写的文件)
└── state/
    ├── CURRENT                    活跃 mission 定位提示(schema/id/revision)
    └── <id>/
        ├── SNAPSHOT.json          v2 唯一机器真相源(plan/state/handoff/artifacts/revision)
        ├── generations/<n>/
        │   ├── MISSION.md         人类可读投影
        │   └── verify.sh          当前 generation 独立裁判脚本
        │   └── .tmp-*/            发布前临时目录,不参与恢复
        ├── CHECK.json             CHECK 瞬时运行态(L0 独占写,状态页轮询)
        ├── LOG.md                 事件流水
        ├── profile.json           用户现场(模型/thinking)
        ├── evidence/              按 task/attempt 归档的原始证据
        └── archive/               L3 归档
```

CURRENT、SNAPSHOT、CHECK、LOG、profile、evidence 与 archive 默认写进
`.git/info/exclude`(不动用户的 `.gitignore`);不可变 generations 建议提交,
git 提供 AC 冻结的审计链。
脚手架**已存在的文件不覆盖** —— 用户可以定制,仓库里的才是规范。

---

## 7. 不变量与代码落点

| # | 不变量 | 实现位置 |
|---|---|---|
| I1 | 状态是仓库里的文件,不是会话里的对话 | `MissionRepository` + SNAPSHOT/CURRENT + `ensureAttached()` |
| I2 | AC 在 Plan 冻结,执行期只读 | `FREEZE_AC` + `gateCheck()` 的冻结件分支 + 工具集切换;判定依据先于执行冻结:`evaluateAdmission()` + `evaluateBaseline()` |
| I3 | 判定证据必须来自执行者之外 | 只读独立 Verifier AgentSession + soft 永不触发 pass |
| I4 | 熔断优先于重试 | `breaker.decide()`,并入 `VERDICT(fail)` 处理 |
| I5 | 每次升级必须换干净上下文 | `pendingHandoff` 硬阻断 + 磁盘握手 |
| I6 | 不在仓库里的等于不存在 | `missions/` 全套 + `ensureScaffold()` |
| I7 | 确定性判定归代码,语义判断归模型 | hard 证据零模型成本;升档判据机械可测 |
| I8 | 上下文按相位分层加载 | `before_agent_start` + `phasePromptFor()`:standard 读 `phases/<phase>.md`,quick 走内联 `QUICK_PHASE_RULES` |
| I9 | 环境不一致判 INCONCLUSIVE | 指纹比对 + `verdict.ts` 第 1 条 |

---

## 8. 当前边界与已知薄弱点

以下都是**当前代码的真实状态**,不是待办清单。

### 8.1 "AC 可执行" ≠ "AC 有判别力"(已收口大半)

已经堵住的:冻结时的基线跑(4.6.1)要求每条 red AC 拿出一次真实的失败,
`ac1) exit 0 ;;` 这类空壳分支会被当场打回。

仍然成立的限制:

- **恒红分支骗得过基线**。`ac1) exit 1 ;;` 基线合格,但任务永远绿不了。
  这是自罚型作弊(熔断会推到停机),不会产出假的"通过",但会白烧一轮 mission。
- **红的理由没有校验**。分支因为"功能没实现"而红,和因为"脚本自己写错了"而红,
  机器分不出来。后者会在 DO 阶段表现为怎么改都不绿,最终走熔断。
- **分支存在性仍是正则粗检**。`scriptHasBranch()` 可能匹配到注释里的同名字符串;
  真正的机械解法是要求 verify.sh 实现 `--list` 子命令并核对其输出,
  这需要先给 scaffold 补一个 verify.sh 骨架(目前脚手架不铺 verify.sh,
  它完全由 planner 起草)。

### 8.2 quick 档仍然没有 AC,只有一条判据

quick 档不落盘、不走 `validatePlan()`,`acceptanceCriteria` 恒为空,
判定依据是单条 `QuickCriterion`,acId 固定为 `"quick"`。
**这一档的判定强度天然低于 standard**,是设计取舍(Q18),不是缺陷。

已经收口的部分:判据必须在进 DO 前冻结(PLAN 相位只有只读工具),
`evaluateCriterion()` 拦掉复读目标与空泛判据,`mission_submit` 不接受任何参数;
`judge: "ai"` 时独立 Verifier 也接上了(这一档以前是显式 skip 的)。

仍然成立的限制:

- **判据的判别力仍没有机械校验**。`evaluateCriterion()` 只拦结构上就判不了真假的
  (太短/复读/空泛),拦不住"具体但没意义"的判据 —— 就像 `--verify "true"` 能过一样。
  这与 8.1 是同一个洞。
- **`judge: "ai"` 的错误与执行者相关**。verifier 与 executor 同源时会系统性偏向 pass。
  提示词已经反向要求"先找反证,找不到才判 pass",但真正的对策是给 verifier 配
  不同家族的模型(`missions/models.json`),那是配置项,不是代码能保证的。
- **`judge: "human"` 不可重放**。mission 结束后这条判据没留下能重跑的东西,
  回归时是空的。

### 8.3 DEFINE 的退出没有机械判据(已收口一半)

已经堵住的:`doneWhen` 与 `AcceptanceCriterion.covers` 的覆盖校验
(`evaluateCoverage()`,4.4)。它判的不是"目标清不清楚",而是"人批准的那张清单
有没有被逐条翻译成退出码" —— 漏一条冻结不了,多一条(孤儿 AC)同样冻结不了。
提问闸门也从"数追问次数"变成了"每问必须带推荐答案 + 每轮必须结账"(4.4),
后者判的是**这轮问答有没有推进决策**,比数次数更贴近真实的失败模式。

仍然成立的限制:

- **`doneWhen` 本身的质量没有校验。** 一个 agent 完全可以不问任何问题,把原始需求
  拆成两条含糊的完成条件("DW1: 体验更好")就调用 `mission_define` —— 系统不会拦。
  它只能保证这两条被 AC 覆盖,不能保证它们值得覆盖。
  这不是疏漏,是这一层的性质:清晰度无法用退出码表达。补偿是把关卡放在下游
  (冻结基线要求每条 red AC 拿出一次真实的红,含糊的完成条件翻译不出这样的分支),
  以及**放在人身上** —— 范围确认卡与计划评审页都是为此存在的介入点。
- **`approach` 完全不可机械判定**,只查非空与 `why` 非空。这是刻意的:
  决策与 AC 不是一一对应,强行配对会把好决策(排除一整片方案空间的那种)挤掉。

### 8.4 spike 的"不许改代码"仍有逃逸口

闸门挡住了 edit/write 到非结论文件,以及 bash 里的重定向、`sed -i`、`rm`/`mv`/`cp`、
`git apply` 这类写操作。挡不住的是:

- **构建/工具链的副作用** —— `npm install`、编译产物、缓存目录的写入无法与"改实现"区分
- **语言运行时** —— `python -c "open('x','w')..."`、`node -e` 这类可以绕过命令模式匹配

真正严密的做法是在 CHECK 时比对工作区快照(spike 开始时记文件列表,结束时要求没有新增
改动),代价是要为此存一份快照并处理 mission 开始前就存在的脏改动。当前实现选择了
命令层拦截 + 独立验证者核对(它看得到 git diff,探针改了实现会判 fail)这一组合。

### 8.5 签名归一化粒度未经真实数据校准

`src/core/breaker.ts` 自己标注了这是最需要按实际数据调的参数,当前只有构造用例覆盖。
真实项目的失败输出形态(尤其非 JVM/TS 生态)会暴露归一化的偏差。

### 8.6 其他运行时限制

- mission 是**前台**的:占用当前会话,一次一个。后台批量编排另开会话用 subagent 类扩展 ——
  但它与 mission **不能同时用**(8.7)。
- 相位切换用 `setActiveTools` 改写工具集,**所有相位**都会隐藏其它扩展的工具
  (白名单语义,DO 也不例外);mission 结束时按 `profile.json` 记下的现场还原(4.11.1)。
- 并行工具执行下 `tool_call` 不保证看到同批次兄弟工具的结果;闸门只依赖已提交 SNAPSHOT。
- 内存态不可信:pi 在 newSession/reload/重启时重建扩展实例。所有关键路径
  (session_start、驱动类命令)都从 CURRENT 指针 + SNAPSHOT.json 重附着。
- 独立 Verifier 每次 CHECK 起一个 in-memory AgentSession(pi ≥ 0.84.4);quick 档不用它。
- `test/` 下的 UI 测试需要 `@earendil-works/pi-tui` 等 peer 依赖装好才能加载;
  core 的 49 个单测无外部依赖,`node --test` 直接跑。

### 8.7 为什么不做通用 sub-agent(以及与 subagent 类扩展互斥)

**mission 期间,第三方扩展注册的工具全部不可用**(4.11.1 的白名单语义)。这不是没做完,
是**能力矩阵的必然结果**:相位决定这一刻允许做什么,而白名单之外的工具本扩展一无所知,
放行等于在能力矩阵上开一个自己也说不清的口子。

更根本的一条:**这套系统的三条保证全部挂在宿主会话的 `tool_call` / `tool_result`
钩子上,而 sub-agent 的工具调用不经过这两个钩子。** 无论 sub-agent 是独立 `pi` 进程
(pi 官方 `examples/extensions/subagent` 就是 `child_process.spawn`),还是 SDK 起的
`AgentSession`(本包的 Verifier 用 `emptyResourceLoader` 显式不加载扩展,否则会递归
自加载),结果一样。于是:

| 保证 | 落点 | 交给能写工作区的 sub-agent 之后 |
|---|---|---|
| I2 AC 冻结后只读 | `gateCheck()` 的冻结件分支 | **失效** —— 它可以直接写 `missions/state/` 下的 SNAPSHOT 与 generation |
| I7 机械升档 | `state.metrics.touchedFiles`,由 `Runtime.onToolResult()` 在 edit/write 上记账 | **失效** —— 它的编辑不进账,"改动 > 5 文件 / 触及公开 API"恒为假 |
| 编辑级内层循环 | `IncrementalDiagnostics`,同样挂 `tool_result` | **失效** —— 最快的那一环对它不存在 |

说清楚缓解项:Verifier 拿的是 **git diff**(工作区级),sub-agent 改的代码 semi 证据
照样看得见,所以不会漏判。但"事后判得出 fail"和"当场拦得住写冻结件"是两回事。
补救办法只有一个 —— 只给 sub-agent 路由过 `gateCheck()` 的 custom tool,那等于把闸门
实现第二遍,两份 I2 要永远同步,正是 CLAUDE.md 硬约束第 5 条禁的那类"方便入口"。

**判据因此是一条,而不是"支不支持 sub-agent":能写工作区的 sub-agent 一律不做;
只读、且结论经结构化工具回到 L0 的 sub-agent 安全** —— 它退化成一次函数调用,
判定权仍在 `judge()`。现行 Verifier(4.7)正是按这个模子做的,新的也必须按它做。

顺带说明另外两件容易被当成"缺 sub-agent"的事,它们已经各有答案:

- **上下文隔离**由**换脑**(4.10)承担,不是由子 agent 承担。换脑是整会话替换 +
  从 SNAPSHOT 重附着,崩溃安全;sub-agent 的上下文是易失的,进程一死什么都不剩,
  与 I1(状态是仓库里的文件,不是会话里的对话)相反。
- **调研隔离**由 **spike**(4.7.1)承担。它就是"scout 子 agent"的形状,只是产物被强制
  落到 `missions/spikes/`,并接一次换脑与 PLAN 重写 —— 可审计、可续、可回看。

**任务级并行同样不做**:`MissionState.phase` 是 mission 级单值、`currentTask` 是单个
任务 id、`nextTask()` 就是 `order[i+1]`,并行要把相位降到任务级,那是重写 `machine.ts`。
更硬的一条是并行执行者共享工作区,hard 证据不再可归因(T1 的分支红了可能是 T2 改坏的),
失败签名、基线红绿、`regression` 分类同时失去意义。参考 `docs/factory-ai-missions-research.md`:
Factory 公开表态"串行执行 + 定向并行"实测优于广泛并行,并行化是否必要仍是其开放问题。

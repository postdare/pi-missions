# DEFINE 强化与计划评审:设计笔记

> 研究笔记,与 `docs/SUBAGENT-VERIFIER-RESEARCH.md` 同档。记录**为什么这么改**;
> 实现细节以代码为准,与代码不符以代码为准。

## 起因:两个洞

### 洞 1 —— DEFINE 太薄

`evaluateAsk()`(`src/core/define.ts`)原本只允许**一轮、最多 3 个问题**。这条限制的出发点是对的
(agent 连环追问二十条比直接说"我不理解"更糟),但它卡错了轴:

**决策是有依赖的。** "要不要独立服务"没定之前,"数据放哪张表"根本问不出来 —— 后者的答案
取决于前者。一轮问答在结构上只能覆盖设计树的**第一层**,再深一点的需求,模型必然被逼着
自己猜下一层,而猜错的代价要到 L2/L3 才显现。

同时,DEFINE 的产出(`Definition` = `constraints` + `nonGoals` 两个字符串数组)
**没有任何 L0 判据消费它**。`docs/ARCHITECTURE.md` §8.3 已经诚实承认了这点:
一个 agent 完全可以不问任何问题、把原始需求原样抄进 `goal`,系统不会拦。

还有一个持久化洞:`mission_ask` 只把**问题**写进 LOG.md,**人的回答只活在上下文里**。
DEFINE 之后一旦换脑或重启,提问额度已经烧掉,答案却没留下 —— 违反"内存态不可信"。

### 洞 2 —— 计划不可见,打回没有回传通道

- 冻结确认原本是一个二值弹窗:只塞了目标 + AC 行 + "任务数:8"。
  任务本体、里程碑、spike、**verify.sh 全文**一个字都看不到 —— 而 verify.sh 才是这份计划
  真正的可执行内核。等于在批准一份没读过的合同。
- 拒绝后返回的是一句死字符串"人工拒绝了计划。请根据反馈修改后重新调用" ——
  **"反馈"是空的**,系统里没有任何地方承载它。planner 只收到 1 bit:不行。
  它只能猜哪里不满意,大概率原地改个措辞再交一次。
- `/mission plan` 的可用窗口是**空的**:它只在 PLAN 相位放行,读 `MISSION.md`;
  而该文件由 `persistPlanFiles()` 写,后者在人工确认 + 基线跑**之后**才被调。
  冻结前打开 = 空编辑器,冻结后 = "只有 PLAN 相位可以编辑计划"。
- 更根本的:`MissionPlan` 里**没有任何字段描述"打算怎么做"**。结构是
  `goal → AC → tasks → verifyScript`,从目标直接跳到可执行分支,设计决策没有载体。
  所以"看不到架构"不是 UI 问题,是数据结构缺一层。

## 三类模糊

把这两个洞放在一起看,会浮出一个更清楚的分类。**模糊不是一种东西,是三种**:

| 类型 | 答案在哪 | 正确出口 |
|---|---|---|
| 描述不清 | 人的脑子里 | `mission_ask` —— 问一轮,人答得出来 |
| 事实不明 | 代码/环境里 | spike —— 问人无效,人也不知道;打探针去看 |
| **方案未定** | **不在任何人脑子里** | **先生成选项、比较、由人拍板** |

第三类是这次补的主角。它的特征是:答案要先被**造出来**才能被选择 —— 你不能"查"到
"该不该拆服务",只能列出两条路、说清代价、请人选。原本系统里没有它的位置:
DEFINE 是纯收敛的(读代码 → 问 → 写一句话),PLAN 直接假设方案显然、开始拆 AC。
于是方案层的不确定性只能靠 L2(改方案)在烧掉一整轮之后才被发现 ——
**升级阶梯是事后补救机制,被当成了事前设计机制用。**

## 参考来源与取舍边界

改动参考了 `~/.agents/skills/` 下的六个 skill。最重要的一条取舍是:

> **只把可以降维成退出码的部分提到 L0。"目标够不够清楚"永远不进 `src/core/`。**

这些 skill 的方法论本体(设计树、frontier、术语锐化)是**提示词工程**,产出质量无法机械判定。
把它们整体塞进 core,等于让这个项目最核心的断言("L0 是唯一的裁判")变成一句空话 ——
一个判不了真假的裁判不是裁判。所以逐条筛:

| 来源 | 拿走的东西 | 落点 |
|---|---|---|
| `grilling` | 每个问题必须带**推荐答案**;一轮答完要**结账**(哪些决策落定了) | L0:`evaluateAsk` |
| `grilling` | 设计树 / frontier / "找事实是你的活,决策是用户的活" | 提示词:`define.md` |
| `to-spec` | **完成条件清单**(它的 user stories 段的内核) | L0:`doneWhen` + `coverage.ts` |
| `to-spec` | **测试接缝先定**(第 2 步:优先用已有的、用尽可能高的那层) | `verifySeam`,上确认卡 |
| `to-spec` | Implementation Decisions | `approach`,评审页第二段 |
| `to-tickets` | prefactor first;任务是纵切不是横切 | 提示词:`plan.md` |
| `to-tickets` | expand–contract | 提示词:倒计数式 AC(见下) |
| `domain-modeling` | ADR 三条判据(难逆转 / 反直觉 / 有真权衡) | `ApproachDecision.sticky`(留接口) |
| `handoff` | 压缩落盘、引用不复制 | `Definition.resolved`;State Card 的打回意见 |
| `implement` | at **pre-agreed** seams | 同 `verifySeam`(其余三条 `do.md` 已实现) |

`implement` 的另外三条("typecheck 常跑、单测常跑、全量最后一次"、"最后跑 code-review"、
"提交到当前分支")在本仓库已经有对应物 —— `templates/phases/do.md` 的「提交前自检」、
独立 Verifier 的 semi 证据、既有 git 约定。**不重复造。**

## 设计决策

### D1 —— 提问从"预算"改成"质量闸门 + 结账判据"

`grilling` 里有个细节很值钱:每个问题强制附带推荐答案。这是**机械可测**的,而且它改变了
提问的经济学 —— 带推荐答案的问题,人回一句"1 用你的、2 选 b、3 你定"就完了,一轮的成本
从"写一段需求"降到"回车"。成本降下来,轮数就付得起。

于是轮次上限放宽到 standard 2 / complex 3,同时加一条新的机械判据:

> **第 N+1 轮要求已落定的决策数严格增长。** 上一轮问完什么都没定下来,就不给下一轮。

这跟 `breaker.ts` 数"同一失败签名连续出现"是同构的,只是把签名换成了"提问没有推进决策"。
两者都在回答同一个问题:**这个循环是在收敛,还是在原地打转?**

_否决的方案:_ 纯靠轮次硬上限。硬上限只能限制损失,不能识别"这一轮白问了" ——
一个模型可以在 3 轮里问 9 个同样含糊的问题,全部合规。

### D2 —— `doneWhen` ↔ `AC.covers`:给 DEFINE 一个机械化的下游后果

§8.3 说"目标的清晰度无法用退出码表达",这句话是对的,但它推出的结论过强了。
**判不了"清楚",不代表判不了"覆盖"。**

DEFINE 产出一张人话的完成条件清单(`doneWhen`,DW1/DW2…),PLAN 的每条 AC 声明它
`covers` 哪几条。`core/coverage.ts` 校验:每条 DW 至少被一条 AC 覆盖(**没漏**),
每条 AC 至少覆盖一条 DW(**没夹带私货**)。两条都是纯集合运算。

这一条的连带收益是,升级阶梯的三级第一次各有物理落点:

| 级别 | 改什么 | 载体 |
|---|---|---|
| L1 改实现 | 代码 | 工作区 |
| L2 改方案 | **`approach`** + tasks/verify | MISSION.md |
| L3 改问题定义 | **`doneWhen` / `nonGoals`** | MISSION.md |

"这次该升几级"从语义判断变成了"你要改哪个字段"。

_覆盖校验只在 mission 经过 DEFINE 时跑_(`plan.definition` 存在)。quick 档没有 DEFINE 相位,
判定依据是 `--verify` 冻结的那条命令 —— 那是档位差异,不是可以为空的口子:
**definition 一旦存在,`doneWhen` 就必须非空,每条 AC 也必须带 `covers`。**

### D3 —— `approach`:方案的物理载体

`MissionPlan` 加 `approach: { summary, decisions[] }`。每条决策带 `why`,可选 `rejected`
(否决了什么)与 `sticky`(难以逆转,将来提示落 ADR)。

校验只做最弱的一档:**complex 强制**(summary 与 decisions 非空、每条 `text`/`why` 非空),
standard/quick 可选。`approach` 没有可追溯的对端,**不假装它可机械判定** ——
它的过滤器是人在评审页读它。这是刻意的:强行给它编一个退出码,只会诱导模型写出
能过校验的废话。

_否决的方案:_ 让 approach 也参与覆盖校验(比如每条决策必须关联一条 AC)。
决策与 AC 不是一一对应的 —— 一条"不动 User 表"的决策可能不产生任何 AC,
它的价值是排除了一整片方案空间。强行配对会把好决策挤掉。

### D4 —— 打回意见是一条有内容的边,第 3 次硬拦

评审页的 `R` 打回要收一段意见文本,回传给 planner,并落 LOG.md + State Card
(否则换脑即丢,与 D1 的 `resolved` 是同一个洞)。

打回次数记进 STATE,**第 3 次直接转 DEFINE(L3)**,不再让 planner 重交。理由是硬的:
同一份问题定义下改了三版方案你都不满意,那不是方案的问题,是 `doneWhen` 没定对;
继续在 PLAN 里磨等于**在错的问题上做高质量的工作**。

选硬拦而不是软警告,是因为这个项目的判定一贯是硬的 —— 软警告等于没有。
转 DEFINE 时强制换脑(I5:升级后的重新规划绝不在被污染的上下文里进行)。

### D5 —— 不新增相位

多轮问答、方案讨论、范围确认,全部装在 DEFINE **内部**(靠 `defineAsks`/`defineSettled` 记账)。
相位图是这个项目的核心资产,每加一个节点,闸门矩阵、UI、状态机、换脑规则都要跟着长。
DEFINE 本来就是"改问题定义"的落点,不需要它旁边再站一个 BRAINSTORM。

### D6 —— expand–contract 用倒计数式 AC,不加新机制

`to-tickets` 讲的 wide refactor(expand → migrate 批次 → contract)在原规则下**冻结不了**:
中间那些 migrate 批次的 AC 天然是"CI 还是绿的",全部 `baseline: "green"`,
会被 `evaluateBaseline()` 的"至少要有一条 red"当场打回。

解法不需要新机制,是 **AC 写法**的问题:用**倒计数式 AC**(`grep -c 旧形态 <= N`)。
它在批次前是红、批次后是绿,严丝合缝落在现有的红→绿框架里。
顺带这也是 §8.1 的一个正面解 —— 计数式 AC 的判别力比布尔式强得多。

写进 `templates/phases/plan.md` 的「AC 的三种可靠形态」:
① 失败用例转绿 ② 计数单调下降 ③ 契约比对。

### D7 —— 范围确认不走 `CONFIRM` effect

原计划是把 L3 专用的 `CONFIRM` effect 泛化。实现时发现形状不对:范围确认必须发生在
`DEFINE_DONE` **之前**(拒绝则相位不动),走 effect 就得给状态机加一个"等确认"的中间态。
而 PLAN 的冻结确认早就是在 runtime 里内联的同一形状。

所以判定(`needsScopeConfirm`)留在 core,执行放 runtime,状态机一行没动。
`CONFIRM` effect 那条路是给机器**主动发起**的 L3 用的 —— 两者的发起方向不同。

### D8 —— 开发期不留兼容口子

所有"老 mission 缺字段就按缺省算"的软着陆都拆掉了:
`MissionState` 的 `defineAsks` / `defineSettled` / `planReview` / `spikesRun` 是必填,
`Definition.doneWhen` / `resolved` 与 `AcceptanceCriterion.covers` 也是必填,
`evaluateCoverage` 遇到空的 `doneWhen` 直接报错而不是跳过。

留一条可选是有代价的:一个可以为空的判据等于没有判据 —— 模型只要不填就绕过了它,
而"不填"恰恰是它想不清楚时最省事的动作。唯一保留的可选是 `MissionPlan.definition`,
那不是兼容,是档位差异:quick 档不经过 DEFINE 相位。

**后果:旧协议 mission 没有 v2 `SNAPSHOT.json`,当前版本不会读取。**
开发期直接删掉重开,不增加迁移或默认值分支。

要跟"取值保护"分开看:`evaluateCoverage()` 里仍然写 `input.doneWhen ?? []`。
那不是兼容口子 —— 那两个数组来自 LLM 的工具参数与 snapshot plan,
**类型上必填不代表运行时一定在**。裁判被畸形输入打崩比判错更糟,
所以缺字段一律走"没有覆盖"这条错误路径,而不是抛异常。

## 批次划分

| 批次 | 内容 |
|---|---|
| 0 | 本文件 |
| 1 | `core/define.ts` 重写 `evaluateAsk`:推荐答案强制 + 结账判据 + 档位轮次上限 |
| 2 | `Definition` 扩展(`doneWhen`/`verifySeam`/`resolved`)+ 新建 `core/coverage.ts` |
| 3 | `MissionPlan.approach`,complex 强制 |
| 4 | `ui/plan-review.ts` 计划评审页 + `core/review.ts` 打回硬拦 |
| 5 | DEFINE 出口的范围确认(内联 `ctx.ui.confirm`,见 D7) |
| 6 | `templates/phases/{define,plan}.md` 提示词 |

## 明确不做

- **DEFINE 直接请求 spike**(spike 返回点从"恒回 PLAN"改成"回请求方相位")。
  这是真缺口 —— DEFINE 只有只读工具,碰到"得跑一下才知道"就卡死,唯一出路是硬编一个 goal、
  进 PLAN、排 spike、再回 PLAN,中间那次 define/plan 是编的。但它改的是状态机,
  而 `core/spike.ts` 的第三条硬约束("强制以重写 PLAN 结尾")是刻意设计的。
  先靠 `define.md` 引导"进 PLAN 排 spike"绕过,观察真实频率再定。
- **跨 mission 记忆**(读仓库 `CONTEXT.md` 当词汇输入;DONE 时按 ADR 三条判据提示落 ADR)。
  这是唯一能让 DEFINE 越用越便宜的机制,但本次只用 `ApproachDecision.sticky` 留好接口。
- quick 档判别力(§8.2)、签名归一化校准(§8.5)—— 与这两个洞无关。

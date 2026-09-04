# pi-missions

双层循环工作流引擎,跑在 [pi](https://github.com/earendil-works/pi-coding-agent) 上。
外层 PDCA 管任务分解与进度追踪,内层操控循环管执行中的质量控制与自我修正。
提供 quick / standard / complex 三档。

**L0(扩展进程内的纯 TypeScript)是唯一的裁判;LLM 只是执行者。**
LLM 永远不能自己宣布"我做完了"——它只能提交,由 L0 依据证据判定。

```
/mission new "把登录鉴权从 session 迁移到 JWT"
   │  DEFINE 相位:读代码 → 必要时提问(每轮≤3,每问带推荐答案)→ mission_define 定义问题
   │  PLAN   相位:LLM 只读分析 → mission_write_plan 原子提交
   │            (人工确认 → 基线跑:每条 AC 此刻必须是红的 → 冻结)
   ▼
   DO → mission_submit → CHECK(L0 亲自跑 verify.sh + 进程内独立 Verifier AgentSession)
   ▲                     │ pass → 下一任务;fail → ACT(诊断一轮)→ 回到 DO
   │                     │ 同一失败签名 ×N → 熔断升级:L2 改方案(回 PLAN,换脑)
   │                     │                          L3 改问题定义(回 DEFINE,人工确认)
   └── 全部任务通过 → done,恢复现场
```

## 设计不变量

| # | 不变量 | 违反后果 |
|---|---|---|
| I1 | 状态是**磁盘上**的文件,不是会话里的对话 | 会话一断,进度全丢 |
| I2 | 验收标准在 Plan 阶段冻结,执行期只读 | agent 做不出来就悄悄放宽标准 |
| I3 | 判定的证据必须来自执行者之外 | Check 变成自我表扬 |
| I4 | 熔断优先于重试:同一问题连续失败必须升级 | 在错误方案上无限打磨 |
| I5 | 每次升级必须换干净上下文 | 污染上下文里只得到同一错误的变体 |
| I6 | 不在仓库里的,对 Agent 等于不存在 | 换机器/换 agent 行为不一致 |
| I7 | 确定性判定归代码,语义判断归模型 | 又慢又贵 |
| I8 | 上下文按相位分层加载 | 注意力稀释,跳步骤 |

## 安装

### 在线安装(git)

```bash
pi install git:github.com/postdare/pi-missions            # 跟随默认分支
pi install git:github.com/postdare/pi-missions@<tag|commit>  # 钉死某个版本
pi install https://github.com/postdare/pi-missions        # 裸 URL 同样可用
pi install git:git@github.com:postdare/pi-missions        # SSH(用你已配置的 key)
```

默认写进用户设置 `~/.pi/agent/settings.json`,克隆到
`~/.pi/agent/git/github.com/postdare/pi-missions`。

**装到项目里**(写 `.pi/settings.json`,可随仓库提交;队友信任该项目后,pi 启动时自动补装):

```bash
pi install -l git:github.com/postdare/pi-missions
```

**只试一次,不落设置**(装到临时目录,仅本次运行有效):

```bash
pi -e git:github.com/postdare/pi-missions
```

### 本地安装

```bash
pi install /absolute/path/to/pi-missions
pi install ./pi-missions
```

### 管理

```bash
pi list                                                   # 已安装的包
pi update --extensions                                    # 更新已装包
pi update git:github.com/postdare/pi-missions             # 只更这一个
pi remove git:github.com/postdare/pi-missions
```

带 `@ref` 的安装是**钉死**的:`pi update` 不会把它移到新版本,要换版本重新
`pi install git:github.com/postdare/pi-missions@<新 ref>`。

### 前置与注意

- **Node ≥ 22.6**(core 单测用 `node --test` + type stripping,扩展本身直接跑 `.ts`)。
- **不需要额外依赖**:运行时只用到 pi 自带的 `@earendil-works/pi-coding-agent`、
  `@earendil-works/pi-tui`、`typebox`,它们按 pi 的约定声明为 `peerDependencies`。
  git 安装会跑 `npm install --omit=dev`,不会拉进多余的东西。
- ⚠️ **不要 `pi install npm:pi-missions`。** npm 上的 `pi-missions` 是另一个同名的
  无关项目(`itisbryan/pi-missions`),不是本仓库。本项目只从 git 源安装。
- ⚠️ pi 包以**完整系统权限**运行(扩展执行任意代码)。装任何第三方包之前,
  包括这个,先读一遍源码。

## 用法

扩展随包带一个 pi skill(`skills/pi-missions/`),装载后模型在任何会话里都能拿到
「该不该开 mission、三档怎么选、入口命令怎么写」的入场导览;相位内的行为规范仍由
系统按相位自动注入,skill 不重复。

`/missions` 是主入口 —— 两页,`Tab` 切换(`←/→` 同效)。选中行整行铺背景、行首 `▸` 是光标;
终端窄的时候按重要性丢列(先档位,再进度),目标永远保留:

```
╭─ MISSIONS ────────────────────────────────────────────────── 5 个 mission ─╮
│  任务   模型                                               输入以筛选任务… │
│                                                                            │
│   + 开始新任务   standard  任务列表 + 验证闸门(默认)           Ctrl+L 换档 │
│                                                                            │
│   状态    更新   进度        目标                                          │
│ ▸ ⚠ 执行  3min   █──── 1/4   把登录鉴权从 session 迁移到 JWT               │
│   ◆ 判定  42min  ███── 6/9   CMS 管理端 REST 接口重构                      │
│   ✓ 完成  16h    █████ 1/1   修掉 verify.sh 在 CI 上的路径假设             │
│   ✕ 熔断  22h    ██─── 2/5   把证据归档换成按 attempt 分目录               │
│   ⚠ 定义  1d     ───── 0/3   给 spike 任务加结论模板                       │
╰────────────────────────────────────────────────────────────────────────────╯
 ↑↓ 导航   Enter 选择   Ctrl+L 档位   Ctrl+D 详情   Tab 切页   Esc 关闭
```

| 命令 | 作用 |
|---|---|
| `/missions` | 主面板,两页(`Tab` 切换):**任务**(新建 + 历史,`Ctrl+L` 换档位)· **模型**(角色 → 模型/thinking) |
| `/mission new <目标> [--tier=standard\|complex]` | 新建并进入 PLAN 相位 |
| `/mission quick <任务> --verify "<命令>"` | 单任务快捷档,不落盘。**`--verify` 是判定的唯一依据,必须给**;不给则自动升 standard 走 PLAN |
| `/mission status` | 当前 mission 状态总览(双栏内联页:左「概览/验收」· 右「任务 + 日志」,`Tab` 切焦点分别滚动;焦点在任务段时 `↑↓` 选任务,`Enter` 查看任务详情页;窄终端自动退化成单栏) |
| `/mission tier <quick\|standard\|complex>` | 设定待用档位:编辑器边框随档位换色,直接输入目标回车即开 mission(取消:按 `Esc`) |
| `/mission next` | 换脑:创建干净会话继续(唯一解除 pendingHandoff 的出口) |
| `/mission verify` | do 相位手动触发一次 CHECK |
| `/mission escalate --level=2\|3` | 人工升级 |
| `/mission plan [id]` | 计划评审页(只读):目标与边界 / 方案 / 验收标准 / 任务 / verify.sh 全文,`Tab` 切段 |
| `/mission log [--task=T3]` | 查看 LOG.md |
| `/mission resume <id>` | 恢复历史任务到当前会话 |
| `/mission abort` | 终止当前任务(halted) |
| `/mission models` | 打印角色模型的**实际生效值** + 按角色分账的花费(修改走 `/missions` 的模型页) |

LLM 可调用的工具五个,按相位分发:`mission_ask` / `mission_define`(DEFINE)、
`mission_write_plan`(PLAN)、`mission_submit`(DO,无参数)、`mission_escalate`(ACT)。
状态推进由 L0 驱动。

### 状态视图与任务详情页 (`/mission status`)

运行 `/mission status` 或在 `/missions` 列表中按 `Enter` 打开活动 mission 详情:

```
╭─ m-20260901-1402 · 任务 T2 ───────────────────────────────── 任务 2/4 ─╮
│  standard  ◆ check   attempt 2/3   $0.96   3min                         │
├─────────────────────────────────────────────────────────────────────────┤
│  任务定义 [T2] ──────────────────────────────────────────────────────── │
│  标题: 迁移登录端点                                                     │
│  状态: ▸ 执行中  (running)                                              │
│  类型: impl (代码实现)                                                  │
│                                                                         │
│  尝试次数: attempt 2/3                                                  │
│  失败签名: 9f2c1a4b7e30  同一签名连续 2 次                              │
│  上次失败: AuthIntegrationTest#refreshToken 断言失败,期望 200 实际 401   │
│                                                                         │
│  验收标准与验证入口 ─────────────────────────────────────────────────── │
│  verify分支: auth-integration                                           │
│    AC1 [verify: auth-integration, baseline: red]                        │
│      登录链路集成测试全绿                                               │
│                                                                         │
│  实时验证 · Attempt 2 ───────────────────────────────────────────────── │
│  验证阶段  执行脚本 · 12s                                               │
│  正在执行  auth-integration                                             │
│  已完成    ✓ lint 1.3s                                                  │
│                                                                         │
│  证据记录 (2 次尝试) ────────────────────────────────────────────────── │
│  ▶ Attempt 1 · 14:10:05                                                 │
│    ✗ FAIL @hard  auth-integration · exit=1                              │
│      (stdout / stderr 原始输出...)                                      │
╰─────────────────────────────────────────────────────────────────────────╯
 ↑↓ 滚动   Esc 返回任务列表   R 刷新   Q 关闭
```

- **三段焦点**: `Tab` 在「概览/验收」(焦点 0)、「任务列表」(焦点 1) 与「日志」(焦点 2) 之间循环切换。
- **逐项选择与高亮**: 焦点在任务列表时,用 `↑`/`↓` 上下选择特定任务,选中的任务块带有高亮背景与 `▸` 标识。
- **任务详情页 (`Enter`)**: 选中任务后按 `Enter` 展开该任务的深度详情页:
  - **任务定义与状态**: 任务 ID、标题、所属里程碑、执行状态与任务类型(`impl` 或 `spike`)。
  - **执行历史与熔断状态**: 尝试次数 (`attempt m/n`)、失败签名、连续同签名计数、连续无结论计数(标签按成因区分:证据缺口 / 裁判不可用)与上次失败原因。
  - **验收标准与 verify 分支**: 映射的 AC ID、verify 分支、基线要求(`red`/`green`)及 AC 完整正文。
  - **实时 CHECK 进度**: 每 2 秒读取 L0 写入的 `CHECK.json`,显示准备环境、执行脚本、独立核验、生成判定等阶段,以及耗时、当前分支和已完成分支;独立核验进行中还会显示 Verifier 的最近动作、轮次、工具调用数、token 与费用。
- **验证中的人工干预**: 独立核验运行时按 `S` 补充检查指令(写入 CHECK.json/LOG.md 审计链,只补检查重点,改不了冻结 AC),按 `Ctrl+A` 立即中止 mission 并同步终止 Verifier。
  - **全量证据历史**: 每次 attempt 的完整执行记录(命令、开始时间、各分支判决结果、exitCode、耗时与完整 stdout/stderr 输出,折行不截断)。
  - **探针任务结论**: Spike 类型任务直接呈现核心问题及书面结论正文(`missions/spikes/<id>/<task>.md`)。
- **滚动与返回**: 详情页内 `↑`/`↓` / `PgUp`/`PgDn` / `Home`/`End` 滚动查看超长输出;按 `Esc` 或 `Backspace` 返回任务列表并保留原先的光标位置。

## 仓库布局(I6 · 仓库即规范)

```
<repo>/
├── missions/
│   ├── README.md              # 工作流规则(脚手架自动铺设)
│   ├── phases/{define,plan,do,check,act}.md  # 相位提示词,可定制
│   ├── spikes/<id>/<task>.md  # 探针结论
│   └── state/
│       ├── CURRENT            # 活跃 mission 定位提示
│       └── <id>/
│           ├── SNAPSHOT.json  # v2 唯一机器真相源(plan/state/handoff/revision)
│           ├── generations/<n>/ # 不可变 MISSION.md + verify.sh
│           └── CHECK.json · LOG.md · evidence/ · archive/
```
- `generations/`、`LOG.md`、`archive/` 建议提交(不可变或 append-only,可合并,重规划要读);
  CURRENT、SNAPSHOT、CHECK、profile、evidence 默认写入 `.git/info/exclude` —— 见「换机器接力」。
- `CHECK.json` 是 L0 独占写入的瞬时运行账本,验证完成后保留最终阶段,恢复或中止 mission 时清理。
- 非 git 仓库降级运行:AC 冻结只剩 L0 闸门,无 git 审计链,TUI 会提示。
- 目录名冲突时在 `.pi/pi-missions.json` 里改 `missionsDir`。

## 三档

| | quick | standard | complex |
|---|---|---|---|
| 入口 | `/mission quick --verify "<命令>"` | `/mission new` | `/mission new --tier=complex` |
| 起始相位 | PLAN(建好即冻结进 DO) | DEFINE | DEFINE |
| v2 snapshot | 不落盘(升档时补落盘) | 落盘,任务级 | 落盘,含里程碑 |
| 验证 | hard(`--verify` 的命令,进 DO 前冻结) | hard + 子进程 semi | hard + semi + 里程碑回归 |
| 换脑 | 不换 | 水位/升级触发 | 每任务换 + 升级换 |
| 熔断阈值 | 2 | 3 | 3 |

**升档自动,降档手动。** 判据机械可测:attempts≥2、改动文件 >5、触及公开 API
(`publicApiGlobs` 配置)、2 次改方案(L2)。

**方案(approach):** `MissionPlan` 带一段 `approach{summary, decisions[]}` ——
打算怎么做、动哪几个模块、否决了什么。**complex 强制**,standard/quick 可选。
它没有可追溯的对端(一条"不动 User 表"的决策可能不产生任何 AC,它的价值是排除了
一整片方案空间),所以只做最弱的校验(summary/decisions 非空、每条决策有 `why`)——
真正的过滤器是人在评审页读它。

**入口守卫(I2/I3):** `/mission quick` 不带 `--verify` 时不进 DO —— 判定依据必须先于执行
冻结,否则等于让执行者干完活再自己挑裁判。这种输入自动升 standard,由 PLAN 相位
写出可执行的 AC。判定见 `core/tier.ts` 的 `evaluateAdmission()`。

## 证据分级(I3)

- **hard**:L0 亲自执行 `verify.sh` 分支拿退出码,零模型成本;
- **semi**:进程内独立 Verifier AgentSession(只读 read/grep/find/ls + 结构化 mission_verdict)逐条核对 AC;
- **soft**:执行者自述,只能触发 ACT,永远不能触发 PASS。

连续 3 次 INCONCLUSIVE → 停机等人。

## DEFINE:先定义问题(I2 的入口条件)

AC 必须在 PLAN 冻结,而且必须可执行。需求模糊时根本写不出这样的 AC —— 此时 agent
的行为是可预测的:**它会编一条 AC 出来凑格式**("AC1: 用户体验良好"),整套判定
就建立在一条假标准上。

DEFINE 把升级阶梯的 L3(改问题定义)提到最前面,于是三级阶梯不再是外挂机制,
而是相位图上的反向边 —— 升级就是往回走一格:

```
DEFINE ─▶ PLAN ──▶ DO ⇄ CHECK ──▶ ACT
  ▲         ▲        ▲                │
  └─ L3 ────┴─ L2 ───┴──── L1 ────────┘
改问题定义   改方案        改实现
```

standard/complex 起于 DEFINE(`core/machine.ts` 的 `START_PHASE`);quick 档没有 AC
要定义,建好即冻结进 DO。DEFINE 只有只读工具加两个:

- `mission_ask` —— 把"不知道就写不出完成条件"的问题交给人。闸门在
  `core/define.ts` 的 `evaluateAsk`,四条都是机械的:
  **每个问题必须带推荐答案**(没有默认答案的问题是懒问题,直接拒);**一轮最多 3 个**;
  **轮次上限按档**(standard 2 / complex 3);**每轮都要结账** —— 下一轮的 `settled`
  必须比上一轮长,上一轮问完什么都没定下来就不给下一轮。
  最后一条与熔断同构:那里数"同一失败签名连续出现",这里数"提问没有推进决策"。
- `mission_define` —— 交出目标 + **完成条件清单(doneWhen)** + 约束 + 不做的事 +
  验证接缝 + 问答记录,进入 PLAN。complex 档(以及问过至少一轮的 standard)
  会先弹一次**范围确认**;被拒就停在 DEFINE,提问轮次不返还。

### 完成条件(doneWhen):DEFINE 唯一有机械后果的产出

DEFINE 的目标本身仍然判不了"够不够清楚"。但**判不了"清楚",不代表判不了"覆盖"**:

DEFINE 产出一张人话的完成条件清单(DW1、DW2…),PLAN 的每条 AC 必须声明 `covers`。
`core/coverage.ts` 两个方向都查 —— 每条 DW 至少被一条 AC 覆盖(**没漏**),
每条 AC 至少覆盖一条 DW(**没夹带**)。漏的那条就是"人以为会做、机器不会验"的部分;
孤儿 AC 则是 planner 在人批准的目标之外自己加了戏,而它会被冻结成只读。

覆盖校验只在 mission 经过 DEFINE 时跑。quick 档没有 DEFINE 相位(判定依据是 `--verify`
冻结的那条命令),但凡走过 DEFINE 的 mission,`doneWhen` 必须非空、每条 AC 必须带 `covers`。

连带的收益是升级阶梯三级第一次各有物理落点:
**L1 → 代码;L2 → `approach`(方案);L3 → `doneWhen` / `nonGoals`。**
"这次该升几级"从语义判断变成了"你要改哪个字段"。

## 计划评审:人可以打回,而且打回是有内容的

`mission_write_plan` 之后不是一个二值弹窗,而是一页可滚动的**计划评审页**
(`ui/plan-review.ts`,`Tab` 切五段):

```
╭─ 计划评审 · m-20260901-1402 · standard ──────────── 打回 1/3 ─╮
│  目标与边界   方案   验收标准   任务   verify.sh                │
├────────────────────────────────────────────────────────────────┤
│ 上次打回:AC2 那条根本不会红,换个能判别的写法                   │
├────────────────────────────────────────────────────────────────┤
│ 目标      把鉴权从 session 迁到 JWT                             │
│ 完成条件 ─────────────────────────────────                     │
│   DW1  旧 session 中间件不再被任何路由引用                      │
╰────────────────────────────────────────────────────────────────╯
 Enter 批准冻结   R 打回并写意见   Tab 切段   ↑↓ 滚动   Esc 取消
```

`R` 打回会收一段意见,原样回传给 planner,并写进 LOG.md 与 State Card
(`PREV REJECTION`)—— 所以换脑之后 planner 仍然读得到。原来的实现只回一个 bit
的"不行",planner 只能猜哪里不满意。

**连续打回到上限(`core/review.ts` 的 `PLAN_REJECT_CAP` = 3)直接转 L3 回 DEFINE**,
不再让 planner 重交:同一份问题定义下改了三版方案人都不满意,问题多半不在方案,
继续在 PLAN 里磨等于在错的问题上做高质量的工作。转 L3 时强制换脑。

冻结之后 `/mission plan` 可以只读打开同一页。

## 并行侦查(mission_scout)

写计划的时候常常同时卡着好几个关于本仓库的**事实问题**:旧 ORM 的私有 API 用在哪几处、
有没有现成的集成测试可以挂 AC、那个配置项是从哪读的。一个个自己 grep 过去是串行的,
而它们互相独立 —— 这正是可以并行的形状。

`mission_scout` 一次最多扇出 4 路,每路一个**只读**子 agent 查一个问题,
结论带出处一起回来。子 agent 只有 `read/grep/find/ls`,**没有 shell,也改不了任何文件**。

```
S1 与假设有出入
  问:旧 ORM 的私有 API 用在哪些文件、共几处?
  你的假设:3 处左右
  结论:11 处,集中在 src/repo 下的 4 个文件
  出处:src/repo/user.ts:88, src/repo/order.ts:31, …
S2 未查明(超过 180s 或被中止)
```

跑的时候看得见:工具调用块里逐路一行(谁回来了、谁还在跑、在读哪个文件),
输入框上方的常驻卡同时多出一行 `侦查扇出 ██────── 1/4 · 1m12s · S2 读 src/repo/user.ts`。

每个问题必须写清两件事,都是机械强制的:

- **`why`** —— 这个答案改变计划里的什么(哪条 AC、哪个 verify 分支、任务怎么拆)。
  改变不了计划的问题不值得花一路子 agent。
- **`assume`** —— 你现在假设答案是什么。它有两个用处:那一路超时了 planner 拿它兜底;
  而**假设与结论的差值**才是这次侦查真正买到的东西(上面 S1 那种)。

额度和 DEFINE 的提问同构:一轮最多 4 路,standard 1 轮、complex 2 轮;
把上一轮问过的问题换个措辞再问会被直接拒;第二轮的每个问题必须用 `follows`
挂在上一轮某个问题上 —— 挂不上说明它本来就该在第一轮问,不是上一轮答案打开的新问题。

**没有出处的结论不算结论**:子 agent 说查到了但一条出处都没给,系统一律降级成「未查明」。
未查明的那几条会明确标出来,并在计划里当风险项处理 —— 不能把一个未经核实的假设包装成 AC。

侦查是查证不是推理,`scout` 角色的默认 thinking 是 `low`;
在 `/missions` 的模型页把它指到一个便宜的小模型,扇出才划算(没配会告警)。

**和 spike 的分工是「答案在哪」,不是「有多难」**:代码里现成能读到的用 scout(一次工具调用),
要动手量一量或试一下才知道的用 spike(一整轮)。

## 探针任务(spike)

有些模糊不是描述不清,是**答案不在人那里,在代码里**:旧 API 到底用在 3 处还是 300 处、
瓶颈在 SQL 还是序列化、升级会报几个错。这类问题上 `mission_ask` 无效 —— 你问人,人也不知道。

没有 spike 时系统只有两个出口,都不对:planner 硬猜一个方案(猜错走 L2,烧掉整轮),
或者写一条含糊的 AC 把不确定性带进 DO(现在会被冻结基线打回)。

spike 是第三条路:**先花一小笔钱去看一眼,拿着结论回来重新规划。**
在计划里把任务标成 `kind: "spike"` 并写明 `question`(要回答的那一个问题),
`verify` 给空数组。三条约束都是机械的:

| 约束 | 实现 |
|---|---|
| 产物是书面结论,不是代码 | 闸门只放行写 `missions/spikes/<id>/<taskId>.md`;bash 的写操作(重定向 / `sed -i` / `rm`·`mv`·`cp` / `git apply`)一并挡住 |
| 一次 attempt,不进 ACT、不进熔断 | 探针的失败本身就是一条结论 |
| 强制以重写 PLAN 结尾 | 不论成败都回 PLAN,归档旧计划 + 强制换脑 |

第三条是关键:没有它,agent 会一边"调研"一边顺手把代码改了,最后你既没拿到干净的结论,
也没拿到干净的方案 —— 而且那些改动是在没有 AC 的状态下做的,等于绕过了整个验证闸门。

判定复用现有的证据分级:**hard** = 结论文件够不够实(≥80 字,机械、零模型成本);
**semi** = 独立验证者核对它有没有真的回答那个问题(答非所问、"需要进一步调研"、
或探针改了实现,都判 fail)。

**每个 mission 最多一个 spike**(记在 `state.spikesRun`,重写计划不会把额度还回来)——
再探一次在机制上等于无限期推迟动手;真是问题定义错了,走 L3 回 DEFINE。

## 冻结基线(I2)

`validatePlan` 只能证明 AC 指向的 verify 分支**存在**,证明不了它有判别力 ——
`ac1) exit 0 ;;` 是个完全合法的分支。所以人工确认之后、冻结之前,L0 把每条 AC
的分支各跑一遍:

| AC 的 `baseline` | 冻结时要求 | 用途 |
|---|---|---|
| `red`(缺省) | 必须失败 | 红→绿才是证据。一上来就绿 = 空壳,或这条 AC 不该进这个 mission |
| `green` | 必须已通过 | 回归项("现有测试不许挂")。此刻就红 = 基线本来就坏了,先修再冻结 |

外加一条:**至少要有一条 `red`** —— 全是回归项的 mission 不产出可验证的新东西。
分支跑不起来(exit 126/127)不算红。

不符就打回,计划不冻结、不落 MISSION.md,相位停在 PLAN,错误信息直接回给 planner。
判定见 `core/baseline.ts`(纯函数,9 条单测)。

反向作弊(把分支写成恒 `exit 1`)骗得过基线,但任务永远绿不了,熔断会把它推到停机 ——
代价落在作弊者自己身上,这是刻意的不对称。

基线**只在首次冻结跑**:L2/L3 重规划时世界已被执行者改过,红绿不再是干净信号,
再卡就会把重规划锁死(L2 不许改 AC,planner 无路可走)。

## 换脑(I5)

`agent_settled` 判定需要换脑 → 自动 followUp 触发 `/mission next` → 命令里
`ctx.newSession()` 创建干净会话(升级时只携带当前 generation 的 MISSION.md 投影、
LOG.md 失败记录和最后一次失败证据,不带污染对话)。请求先把一次性 token、父 session
和 revision 写入 SNAPSHOT;新会话携带 `pi-missions-handoff` marker。`session_start`
只有在 reason、父 session、token、revision 全部匹配时才发出 HANDOFF_DONE。
取消 newSession 会显式发 HANDOFF_CANCELLED,不会遗留永久硬阻断。

## 换机器接力

**状态在磁盘上(I1),但不跟着 git 走。** 换脑、重启、reload 都不丢进度;
换机器要**手动把状态搬过去**,`git clone` 带不过来。

这不是没做,是刻意的:`SNAPSHOT.json` 是 CAS revision 保护的状态机快照,**没有合并语义**。
两台机器各自 clone 到 revision 5、各自推进到 6,内容不同而编号相同,谁也不知道该信哪份;
`attempts` / 失败签名计数一旦被三方合并,熔断(I4)就成了随机数。所以 mission 只能
**串行交接**:文件搬过去,原机不再动它。

搬这几样到新机器的同一路径:

```bash
# 带外拷贝,不要 git add -f(理由见下)
rsync -a missions/state/CURRENT              新机器:<repo>/missions/state/
rsync -a missions/state/<id>/SNAPSHOT.json   新机器:<repo>/missions/state/<id>/
# LOG.md / archive/ / generations/ 建议本来就提交进 git,那就不用单独搬
```

然后在新机器上:

```
/mission resume <id>
```

**用 `resume`,不要指望自动附着** —— 原机若中断在换脑挂起中,自动附着会把你接进一个
"闸门硬阻断一切写操作"的状态,而 `/mission next` 的握手要比对原机的 session 文件,
永远对不上。`resume` 显式清挂起,这是设计好的出口。中断在 CHECK/ACT 的会退回 DO,
尝试次数不变(那一轮诊断白跑,是刻意的)。

**别用 `git add -f missions/state` 搬。** 除了上面的合并问题,状态件一旦被 git 跟踪,
SNAPSHOT 的每次重写都会出现在 `git diff` 里 —— 补证据闸门("工作区没改动就不许原样
重交")靠工作区树指纹判定,而那个指纹会因此每轮都变。这条已经修了(指纹显式排掉
`missions/state`),但提交状态件仍然会给你一堆无意义的 diff 噪音和随时可能的冲突。

## 与其它扩展共存(以及为什么不支持 sub-agent)

**mission 期间,其它扩展注册的工具全部不可用。** 相位切换用 `setActiveTools` 把工具集
改写成白名单,而白名单里只有 pi 的内置工具和本扩展的 `mission_*` —— 你装的 subagent、
todo、MCP 桥接注册的工具会在 mission 开始的那一刻被摘掉,**所有相位**都是,DO 也不例外。
mission 结束(done / halted)时按开工那一刻记下的现场还原,包括这些第三方工具;现场随
`missions/state/<id>/profile.json` 落盘,所以换脑与重启之后也还得回去。
(`profile.json` 不进版本控制,换机器时它不跟着走 —— 那种情况下恢复的是新机器上的当前现场。)

这是刻意的,不是没做完:**相位决定这一刻允许做什么**,而白名单之外的工具本扩展一无所知,
放行等于在能力矩阵上开一个自己也说不清的口子。

所以如果你要的是"多个 agent 并行铺开干活",那该用 subagent 类扩展,**另开一个会话**,
不要和 mission 混在一起 —— 两者解决的不是同一个问题:mission 用串行 + 可归因的证据换
"做完了"这句话的可信度,广泛并行换的是吞吐。

### 为什么不在 mission 里支持 sub-agent

判据不是"支不支持 sub-agent",而是这一条:

> **能写工作区的 sub-agent 一律不做;只读、且结论经结构化工具回到 L0 的 sub-agent 安全。**

理由是物理的:AC 冻结只读(I2)、机械升档(I7)、编辑级增量检查,三条全部挂在**宿主会话
的 `tool_call` / `tool_result` 钩子**上,而 sub-agent 的工具调用不经过这两个钩子 ——
无论它是独立 `pi` 进程还是 SDK 起的独立会话。让它写代码,等于:冻结件写保护拦不住它、
它改的文件不进 `touchedFiles` 这本账(升档判据恒为假)、编辑后的增量检查对它不存在。

只读的 sub-agent 没有这些问题,它退化成一次函数调用。这套系统已经在用两个,
都用在站得住的位置上:

| | 干什么 | 工具集 | 结论回到哪 |
|---|---|---|---|
| **Verifier** | CHECK 逐条核对冻结的 AC | 只读 + `mission_verdict` | `judge()` |
| **scout** | PLAN 并行查几个事实(见下) | 只读 + `mission_finding` | `evaluateScout()` / `interpretFinding()` |

两者**都没有 bash** —— 能跑任意命令就能写文件,那三条保证就又没了。

另外两件常被当成"缺 sub-agent"的事,各自已有答案,而且答案更强:

| 需求 | 通行做法 | pi-missions | 差别 |
|---|---|---|---|
| 上下文隔离 | 委派子任务、只回压缩结论 | **换脑**:整会话替换 + 从 SNAPSHOT 重附着 | 崩溃安全 —— 子 agent 的上下文是易失的 |
| 调研隔离 | 一个 scout agent 返回摘要 | 按代价排的三级阶梯:**自己读** → **`mission_scout` 并行侦查** → **spike** | 产物都在仓库里,可审计、可续、可回看 |

**写工作区的任务级并行不做。** 并行执行者共享同一个工作区,hard 证据不再可归因(T1 的分支红了
可能是 T2 改坏的),失败签名、冻结基线的红绿、regression 分类会同时失去意义 ——
而这些正是这套系统敢说"通过"的全部依据。
(`mission_scout` 的并行不在此列:它只读,谁也改不了谁看到的东西。)更细的代码落点见
[docs/ARCHITECTURE.md §8.7](./docs/ARCHITECTURE.md)。

## 配置

`<repo>/.pi/pi-missions.json`:

```jsonc
{
  "missionsDir": "missions",          // 目录名冲突时改
  "incrementalCheck": "npx tsc --noEmit",  // 编辑级反馈(§8.2),未配置则关闭
  "publicApiGlobs": ["src/api/**"],   // 升档判据
  "verifierTimeoutMs": 300000,
  "scoutTimeoutMs": 180000,           // 单路 scout;扇出是并行的,这也是整轮上限
  "contextWatermark": 0.5             // 超过即主动换脑
}
```

`<repo>/missions/models.json`(角色模型策略,I7):

```jsonc
{
  "planner":   { "provider": "anthropic", "model": "…", "thinking": "high" },
  "executor":  { "model": "…", "thinking": "medium" },
  "verifier":  { "model": "…", "thinking": "off" },
  "escalator": { "thinking": "high" },
  "scout":     { "model": "…", "thinking": "low" }   // 并行侦查,指个便宜的小模型
}
```

模型不可用时回退当前会话模型并显式警告(thinking 仍按角色设置),mission 不阻断。
mission 结束/中止时恢复你原来的模型与 thinking level。

verifier 的 thinking 默认 `off`(它只做核对,省钱),但**有些推理模型强制开思考**,
关掉会被 provider 直接打回一个 400。这时核验会自动改用 `low` 重试一次,并把 provider
的原话写进 LOG.md;两轮都不成才降级 hard-only。若该 mission 的判据只有一条 AI 判据
(quick 档),裁判不可用就等于没有证据来源 —— 此时直接停机报「核验裁判不可用」,
而不是回 DO 空转(见 ARCHITECTURE 的 `InconclusiveCause`)。

### 在面板里改(`/missions` → `Tab` 到「模型」页)

```
╭─ MISSIONS ────────────────────────────────────────────────────── 5 个角色 ─╮
│  任务   模型                                                               │
│                                                                            │
│   planner    ● anthropic/claude-opus-5            high         $0.4120     │
│ ▸ executor   ● anthropic/claude-sonnet-5          medium       $1.2030     │
│                DO 写代码(主力消耗)                                         │
│   verifier   ⚠ openai/… → anthropic/claude-opus-5 off(默认)    $0.0940     │
│   escalator  ○ anthropic/claude-opus-5(跟随会话)  high(默认)               │
│   scout      ● anthropic/claude-haiku-4-5         low(默认)     $0.0110     │
│                                                                            │
│ ● 已配置   ⚠ 配了但不可用(实际跟随会话)   ○ 未配置   写入 missions/models… │
╰────────────────────────────────────────────────────────────────────────────╯
 ↑↓ 导航   Enter 选模型   T thinking   X 清除   Tab 切页   Esc 关闭
```

`↑↓` 选角色(选中行展开该角色的职责说明)· `Enter` 选模型(可输入过滤)·
`T` 切 thinking · `X` 清除该行。

三个要点:

- **显示的是实际生效的值,不是配置值。** `⚠` 表示配了但该模型不可用 —— planner/executor/
  escalator 此时回退到会话模型,只在切换角色时警告一次;面板照抄配置的话,你会以为角色
  在用便宜模型,实际一直拿会话模型烧钱。**verifier 例外**:它配了但不可用时不会顶替,而是
  跳过语义核验、显式降级 hard-only(CHECK.json 与 LOG.md 留痕)—— 独立裁判的证据来源必须可审计。
- **模型列表来自 `ctx.scopedModels`**(pi 内置选择器同一套数据源),没有配 scoping 时
  退回完整目录。不手写模型名单。
- **窄屏优先保「实际用的是哪个」。** 列宽不够时先丢尾标、再丢花费、再缩 thinking;
  `配的是 A → 实际是 B` 放不下时截掉 A 而不是 B —— 截掉 B 就等于退回"照抄配置"。
- **改动会写进 LOG.md。** 尤其 verifier:mission 跑到一半换它,等于中途换裁判 ——
  此后的 semi 证据与之前不同源,审计链必须能解释这件事。改动写盘后,若改的正是当前
  相位的角色,立刻生效;否则等下一次相位切换。

## 代码结构

> 分层、相位状态机、术语表与不变量落点见 [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)。

```
src/
├── index.ts            # 装配:命令/工具/事件
├── runtime.ts          # core 与 pi 之间的哑管道(效果翻译、CHECK 执行、tick)
├── tools.ts            # 五个 LLM 工具
├── commands.ts         # /missions + /mission
├── core/               # ⚠️ 纯函数 + 单测,唯一的裁判
│   ├── machine.ts      # 相位状态机(熔断判定已并入 VERDICT 处理)
│   ├── breaker.ts      # 失败签名归一化 + 熔断 + 升级阶梯
│   ├── verdict.ts      # 证据分级与判定
│   ├── baseline.ts     # 冻结时的基线红绿校验(挡空壳 AC)
│   ├── tier.ts         # 三档与自动升档 + 进 DO 的准入守卫
│   ├── coverage.ts     # 完成条件 ↔ AC 的覆盖校验
│   └── review.ts       # 计划打回的记账与硬拦(3 次转 L3)
├── store/              # v2 Repository、不可变 generation、LOG、git、证据归档
├── roles/              # models.json 角色模型 + 进程内 Verifier AgentSession
├── hooks/              # tool_call 闸门 + 编辑级增量反馈
└── ui/                 # 主面板 + 计划评审页 + 状态视图 + verdict/状态卡片
templates/              # 相位提示词 + missions/README —— 每次 /mission new 按此重铺进目标仓库
```

## 测试

```bash
npm test    # core 单测 + runtime/UI 冒烟(node --test,无需构建)
```

## 已知限制

- mission 是**前台**的:运行时占用当前会话,一次一个。后台批量编排另开一个会话用
  subagent 类扩展 —— 但它与 mission 不能同时用,见「与其它扩展共存」。
- 相位切换用 `setActiveTools` 改写工具集,**所有相位**都会隐藏其它扩展的工具
  (白名单语义,DO 也不例外);mission 结束时按开工时记下的现场还原。见「与其它扩展共存」。
- 并行工具执行下 `tool_call` 不保证看到同批次兄弟工具结果;闸门只依赖 STATE。
- 失败签名归一化粒度(`core/breaker.ts` 的 `normalize()`)是最需要按实际数据调的参数。
- 内存态不可信:pi 在 newSession/reload/重启时重建扩展实例。所有关键路径
  (session_start、驱动类命令)都会从 CURRENT 指针 + SNAPSHOT.json 重附着(I1)。
- 独立 Verifier 是进程内 in-memory AgentSession(需要 pi ≥ 0.84.4 的 SDK),与主会话共享模型进程;quick 档不走它。

# pi-missions

双层循环工作流引擎,跑在 [pi](https://github.com/earendil-works/pi-coding-agent) 上。
外层 PDCA 管任务分解与进度追踪,内层操控循环管执行中的质量控制与自我修正。
提供 quick / standard / complex 三档。

**L0(扩展进程内的纯 TypeScript)是唯一的裁判;LLM 只是执行者。**
LLM 永远不能自己宣布"我做完了"——它只能提交,由 L0 依据证据判定。

```
/mission new "把登录鉴权从 session 迁移到 JWT"
   │  FRAME 相位:读代码 → 必要时问一轮(最多 3 个)→ mission_frame 定义问题
   │  PLAN  相位:LLM 只读分析 → mission_write_plan 原子提交
   │            (人工确认 → 基线跑:每条 AC 此刻必须是红的 → 冻结)
   ▼
   DO → mission_submit → CHECK(L0 亲自跑 verify.sh + 独立 Verifier 子进程)
   ▲                     │ pass → 下一任务;fail → ACT(诊断一轮)→ 回到 DO
   │                     │ 同一失败签名 ×N → 熔断升级:L2 改方案(回 PLAN,换脑)
   │                     │                          L3 改问题定义(回 FRAME,人工确认)
   └── 全部任务通过 → done,恢复现场
```

## 设计不变量

| # | 不变量 | 违反后果 |
|---|---|---|
| I1 | 状态是仓库里的文件,不是会话里的对话 | 会话一断,进度全丢 |
| I2 | 验收标准在 Plan 阶段冻结,执行期只读 | agent 做不出来就悄悄放宽标准 |
| I3 | 判定的证据必须来自执行者之外 | Check 变成自我表扬 |
| I4 | 熔断优先于重试:同一问题连续失败必须升级 | 在错误方案上无限打磨 |
| I5 | 每次升级必须换干净上下文 | 污染上下文里只得到同一错误的变体 |
| I6 | 不在仓库里的,对 Agent 等于不存在 | 换机器/换 agent 行为不一致 |
| I7 | 确定性判定归代码,语义判断归模型 | 又慢又贵 |
| I8 | 上下文按相位分层加载 | 注意力稀释,跳步骤 |
| I9 | 环境不一致判 INCONCLUSIVE,不判 FAIL | 环境漂移触发无效熔断 |

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

| 命令 | 作用 |
|---|---|
| `/missions` | 主面板:顶部新建,下方历史(从 `missions/state/*/STATE.json` 扫描重建) |
| `/mission new <目标> [--tier=standard\|complex]` | 新建并进入 PLAN 相位 |
| `/mission quick <任务> --verify "<命令>"` | 单任务快捷档,不落盘。**`--verify` 是判定的唯一依据,必须给**;不给则自动升 standard 走 PLAN |
| `/mission status` | 当前任务详情(页签浮层:概览/任务/验收/日志) |
| `/mission tier <quick\|standard\|complex\|off>` | 设定/清除待用档位:编辑器边框随档位换色,输入框预填命令 |
| `/mission next` | 换脑:创建干净会话继续(唯一解除 pendingHandoff 的出口) |
| `/mission verify` | do 相位手动触发一次 CHECK |
| `/mission escalate --level=2\|3` | 人工升级 |
| `/mission plan` | PLAN 相位编辑 MISSION.md |
| `/mission log [--task=T3]` | 查看 LOG.md |
| `/mission resume <id>` | 恢复历史任务到当前会话 |
| `/mission abort` | 终止当前任务(halted) |
| `/mission models` | 角色模型映射 + 按角色分账的花费 |

LLM 可调用的工具五个,按相位分发:`mission_ask` / `mission_frame`(FRAME)、
`mission_write_plan`(PLAN)、`mission_submit`(DO,无参数)、`mission_escalate`(ACT)。
状态推进由 L0 驱动。

## 仓库布局(I6 · 仓库即规范)

```
<repo>/
├── missions/
│   ├── README.md              # 工作流规则(脚手架自动铺设)
│   ├── phases/{frame,plan,do,check,act}.md  # 相位提示词,可定制
│   ├── scripts/
│   │   ├── verify.sh          # AC 的唯一执行入口,由 planner 起草、随 AC 冻结
│   │   ├── env-fingerprint.sh # 环境指纹(I9)
│   │   └── verifier-tools.ts  # 子进程 Verifier 的扩展
│   ├── models.json            # 角色模型映射(可选)
│   ├── plans/<id>/MISSION.md  # 冻结计划(正文给人,尾部 ```mission fence 给机器)
│   ├── spikes/<id>/<task>.md  # 探针结论(执行者唯一能写的产物)
│   └── state/<id>/            # STATE.json · LOG.md · evidence/ · archive/
```

- `MISSION.md` 建议提交;`missions/state/` 默认写入 `.git/info/exclude`(不动你的 `.gitignore`)。
- 非 git 仓库降级运行:AC 冻结只剩 L0 闸门,无 git 审计链,TUI 会提示。
- 目录名冲突时在 `.pi/pi-missions.json` 里改 `missionsDir`。

## 三档

| | quick | standard | complex |
|---|---|---|---|
| 入口 | `/mission quick --verify "<命令>"` | `/mission new` | `/mission new --tier=complex` |
| 起始相位 | PLAN(建好即冻结进 DO) | FRAME | FRAME |
| MISSION.md | 不落盘(升档时补落盘) | 落盘,任务级 | 落盘,里程碑分文件 |
| 验证 | hard(`--verify` 的命令,进 DO 前冻结) | hard + 子进程 semi | hard + semi + 里程碑回归 |
| 换脑 | 不换 | 水位/升级触发 | 每任务换 + 升级换 |
| 熔断阈值 | 2 | 3 | 3 |

**升档自动,降档手动。** 判据机械可测:attempts≥2、改动文件 >5、触及公开 API
(`publicApiGlobs` 配置)、2 次改方案(L2)。

**入口守卫(I2/I3):** `/mission quick` 不带 `--verify` 时不进 DO —— 判定依据必须先于执行
冻结,否则等于让执行者干完活再自己挑裁判。这种输入自动升 standard,由 PLAN 相位
写出可执行的 AC。判定见 `core/tier.ts` 的 `evaluateAdmission()`。

## 证据分级(I3)

- **hard**:L0 亲自执行 `verify.sh` 分支拿退出码,零模型成本;
- **semi**:独立 Verifier 子进程(`pi -p --no-extensions`,只有 read+bash)逐条核对 AC;
- **soft**:执行者自述,只能触发 ACT,永远不能触发 PASS。

环境指纹不符 → INCONCLUSIVE(不计入熔断);连续 3 次 INCONCLUSIVE → 停机等人。

## FRAME:先定义问题(I2 的入口条件)

AC 必须在 PLAN 冻结,而且必须可执行。需求模糊时根本写不出这样的 AC —— 此时 agent
的行为是可预测的:**它会编一条 AC 出来凑格式**("AC1: 用户体验良好"),整套判定
就建立在一条假标准上。

FRAME 把升级阶梯的 L3(改问题定义)提到最前面,于是三级阶梯不再是外挂机制,
而是相位图上的反向边 —— 升级就是往回走一格:

```
FRAME ──▶ PLAN ──▶ DO ⇄ CHECK ──▶ ACT
  ▲         ▲        ▲                │
  └─ L3 ────┴─ L2 ───┴──── L1 ────────┘
改问题定义   改方案        改实现
```

standard/complex 起于 FRAME(`core/machine.ts` 的 `START_PHASE`);quick 档没有 AC
要定义,建好即冻结进 DO。FRAME 只有只读工具加两个:

- `mission_ask` —— 把"不知道就写不出 AC"的问题交给人,**整个 mission 只许问一轮、
  最多 3 个**。这条由 L0 强制(`core/frame.ts` 的 `evaluateAsk`),第二次调用直接拒绝。
  问不完说明该退回去重新描述需求 —— 连环追问二十条比直接说"我没法定义"更糟。
- `mission_frame` —— 交出锐化后的目标 + 已确认的约束 + 明确不做的事,进入 PLAN。
  约束与边界写进 State Card 和 MISSION.md 的 `## Frame` 段。

**关于退出条件要诚实:** FRAME 的产出是一句话,不是可执行的东西,没有机械判据能证明
"这个目标已经足够清楚"。真正的过滤器仍在下游 —— `validatePlan` 与冻结基线。
FRAME 的价值是让"想不清楚"在烧掉一轮 PLAN 之前暴露,并且给人一次介入的机会;
这里唯一机械可测的是提问预算。

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
再探一次在机制上等于无限期推迟动手;真是问题定义错了,走 L3 回 FRAME。

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
`ctx.newSession()` 创建干净会话(升级时只携带 MISSION.md + LOG.md 失败记录 +
最后一次失败证据,不带污染对话)。pi 会在 newSession 后重建扩展实例,因此握手
走磁盘:新会话的 session_start 从 CURRENT 指针 + STATE.json 重附着并发出
HANDOFF_DONE。链路被打断时 pendingHandoff 硬阻断仍在,手动 `/mission next` 兜底。

## 配置

`<repo>/.pi/pi-missions.json`:

```jsonc
{
  "missionsDir": "missions",          // 目录名冲突时改
  "incrementalCheck": "npx tsc --noEmit",  // 编辑级反馈(§8.2),未配置则关闭
  "publicApiGlobs": ["src/api/**"],   // 升档判据
  "verifierTimeoutMs": 300000,
  "contextWatermark": 0.5             // 超过即主动换脑
}
```

`<repo>/missions/models.json`(角色模型策略,I7):

```jsonc
{
  "planner":   { "provider": "anthropic", "model": "…", "thinking": "high" },
  "executor":  { "model": "…", "thinking": "medium" },
  "verifier":  { "model": "…", "thinking": "off" },
  "escalator": { "thinking": "high" }
}
```

模型不可用时回退当前会话模型并显式警告(thinking 仍按角色设置),mission 不阻断。
mission 结束/中止时恢复你原来的模型与 thinking level。

## 代码结构

> 分层、相位状态机、术语表与不变量落点见 [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)。

```
src/
├── index.ts            # 装配:命令/工具/事件
├── runtime.ts          # core 与 pi 之间的哑管道(效果翻译、CHECK 执行、tick)
├── tools.ts            # 三个 LLM 工具
├── commands.ts         # /missions + /mission
├── core/               # ⚠️ 纯函数 + 单测,唯一的裁判
│   ├── machine.ts      # 相位状态机(熔断判定已并入 VERDICT 处理)
│   ├── breaker.ts      # 失败签名归一化 + 熔断 + 升级阶梯
│   ├── verdict.ts      # 证据分级与判定
│   ├── baseline.ts     # 冻结时的基线红绿校验(挡空壳 AC)
│   └── tier.ts         # 三档与自动升档 + 进 DO 的准入守卫
├── store/              # 仓库布局、MISSION.md fence、STATE.json、LOG.md、git、证据归档
├── roles/              # models.json 角色模型 + 子进程 Verifier
├── hooks/              # tool_call 闸门 + 编辑级增量反馈
└── ui/                 # 主面板 + verdict/状态卡片
templates/              # scaffold 进目标仓库的工作流文件
```

## 测试

```bash
npm test    # core 单测 + runtime/UI 冒烟(node --test,无需构建)
```

## 已知限制

- mission 是**前台**的:运行时占用当前会话,一次一个。后台批量编排请直接用 pi-subagents。
- 相位切换用 `setActiveTools` 改写工具集,plan/act/check 相位会隐藏其它扩展的工具。
- 并行工具执行下 `tool_call` 不保证看到同批次兄弟工具结果;闸门只依赖 STATE。
- 失败签名归一化粒度(`core/breaker.ts` 的 `normalize()`)是最需要按实际数据调的参数。
- 内存态不可信:pi 在 newSession/reload/重启时重建扩展实例。所有关键路径
  (session_start、驱动类命令)都会从 CURRENT 指针 + STATE.json 重附着(I1)。
- 子进程 Verifier 每次 CHECK 冷启动一个 pi 进程;quick 档不用它。

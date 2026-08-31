# pi-missions

双层循环工作流引擎,跑在 [pi](https://github.com/earendil-works/pi-coding-agent) 上。
外层 PDCA 管任务分解与进度追踪,内层操控循环管执行中的质量控制与自我修正。
提供 quick / standard / complex 三档。

**L0(扩展进程内的纯 TypeScript)是唯一的裁判;LLM 只是执行者。**
LLM 永远不能自己宣布"我做完了"——它只能提交,由 L0 依据证据判定。

```
/mission new "把登录鉴权从 session 迁移到 JWT"
   │  PLAN 相位:LLM 只读分析 → mission_write_plan 原子提交(人工确认后冻结 AC)
   ▼
   DO → mission_submit → CHECK(L0 亲自跑 verify.sh + 独立 Verifier 子进程)
   ▲                     │ pass → 下一任务;fail → ACT(诊断一轮)→ 回到 DO
   │                     │ 同一失败签名 ×N → 熔断升级:L2 改方案(回 PLAN,换脑)
   │                     │                          L3 改问题定义(人工确认)
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

```bash
pi install /path/to/pi-missions      # 本地路径
```

Node ≥ 22.6(core 单测用 `node --test` + type stripping)。

## 用法

| 命令 | 作用 |
|---|---|
| `/missions` | 主面板:顶部新建,下方历史(从 `missions/state/*/STATE.json` 扫描重建) |
| `/mission new <目标> [--tier=standard\|complex]` | 新建并进入 PLAN 相位 |
| `/mission quick <任务> [--verify "<命令>"]` | 单任务快捷档,不落盘 |
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

LLM 可调用的工具只有三个:`mission_write_plan`(PLAN)、`mission_submit`(DO)、
`mission_escalate`(ACT)。状态推进由 L0 驱动。

## 仓库布局(I6 · 仓库即规范)

```
<repo>/
├── missions/
│   ├── README.md              # 工作流规则(脚手架自动铺设)
│   ├── phases/{plan,do,check,act}.md   # 相位提示词,可定制
│   ├── scripts/
│   │   ├── verify.sh          # AC 的唯一执行入口,由 planner 起草、随 AC 冻结
│   │   ├── env-fingerprint.sh # 环境指纹(I9)
│   │   └── verifier-tools.ts  # 子进程 Verifier 的扩展
│   ├── models.json            # 角色模型映射(可选)
│   ├── plans/<id>/MISSION.md  # 冻结计划(正文给人,尾部 ```mission fence 给机器)
│   └── state/<id>/            # STATE.json · LOG.md · evidence/ · archive/
```

- `MISSION.md` 建议提交;`missions/state/` 默认写入 `.git/info/exclude`(不动你的 `.gitignore`)。
- 非 git 仓库降级运行:AC 冻结只剩 L0 闸门,无 git 审计链,TUI 会提示。
- 目录名冲突时在 `.pi/pi-missions.json` 里改 `missionsDir`。

## 三档

| | quick | standard | complex |
|---|---|---|---|
| 入口 | `/mission quick` | `/mission new` | `/mission new --tier=complex` |
| MISSION.md | 不落盘(升档时补落盘) | 落盘,任务级 | 落盘,里程碑分文件 |
| 验证 | hard(--verify 或 submit 时给命令) | hard + 子进程 semi | hard + semi + 里程碑回归 |
| 换脑 | 不换 | 水位/升级触发 | 每任务换 + 升级换 |
| 熔断阈值 | 2 | 3 | 3 |

**升档自动,降档手动。** 判据机械可测:attempts≥2、改动文件 >5、触及公开 API
(`publicApiGlobs` 配置)、2 次改方案(L2)。

## 证据分级(I3)

- **hard**:L0 亲自执行 `verify.sh` 分支拿退出码,零模型成本;
- **semi**:独立 Verifier 子进程(`pi -p --no-extensions`,只有 read+bash)逐条核对 AC;
- **soft**:执行者自述,只能触发 ACT,永远不能触发 PASS。

环境指纹不符 → INCONCLUSIVE(不计入熔断);连续 3 次 INCONCLUSIVE → 停机等人。

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
│   └── tier.ts         # 三档与自动升档
├── store/              # 仓库布局、MISSION.md fence、STATE.json、LOG.md、git、证据归档
├── roles/              # models.json 角色模型 + 子进程 Verifier
├── hooks/              # tool_call 闸门 + 编辑级增量反馈
└── ui/                 # 主面板 + verdict/状态卡片
templates/              # scaffold 进目标仓库的工作流文件
```

## 测试

```bash
npm test    # core 层 49 个单测(node --test,无需构建)
```

## 已知限制

- mission 是**前台**的:运行时占用当前会话,一次一个。后台批量编排请直接用 pi-subagents。
- 相位切换用 `setActiveTools` 改写工具集,plan/act/check 相位会隐藏其它扩展的工具。
- 并行工具执行下 `tool_call` 不保证看到同批次兄弟工具结果;闸门只依赖 STATE。
- 失败签名归一化粒度(`core/breaker.ts` 的 `normalize()`)是最需要按实际数据调的参数。
- 内存态不可信:pi 在 newSession/reload/重启时重建扩展实例。所有关键路径
  (session_start、驱动类命令)都会从 CURRENT 指针 + STATE.json 重附着(I1)。
- 子进程 Verifier 每次 CHECK 冷启动一个 pi 进程;quick 档不用它。

# pi-missions 技术报告(新成员概览)

> 本文面向刚接手本仓库的新成员,做概览级介绍。依据 `README.md`、`CLAUDE.md`、
> `docs/ARCHITECTURE.md` 归纳;更深的结构剖析(精确到文件 + 符号名)以
> `docs/ARCHITECTURE.md` 为准,与代码不符时以代码为准。

## 项目定位

pi-missions 是一个**跑在 [pi](https://github.com/earendil-works/pi-coding-agent) 上的扩展包**,
不是应用、也不是库。它把"agent 做任务"改造成一个由纯代码裁判的状态机:
外层是 **PDCA** 循环,管任务分解与进度追踪;内层是操控循环,管执行过程中的质量
控制与自我修正 —— 合起来就是**双层循环工作流引擎**。

它的一句话核心断言:**L0(扩展进程内的纯 TypeScript,即 `src/core/`)是唯一的裁判,
LLM 只是执行者。** LLM 只能提交(mission_submit),永远不能自己宣布"我做完了";
判定必须依据来自执行者之外的证据。

使用上提供 quick / standard / complex 三档,按任务规模选:quick 走内联提示词,
standard/complex 走完整的相位流程与脚手架。入口命令是 `/missions` 与
`/mission new "任务描述"`。

## 工作流机制

一次 mission 的生命周期由六个相位组成,状态机在 `src/core/machine.ts`:

| 相位 | PDCA | 谁在动 | 说明 |
|---|---|---|---|
| DEFINE | — | LLM(planner) | 澄清目标、提出完成条件(doneWhen),必要时向人提问 |
| PLAN | P | LLM(planner) | 只读分析,写方案 + 验收标准(AC)+ verify.sh,原子提交;人工批准后冻结 |
| DO | D | LLM(executor) | 按任务执行,完成后 `mission_submit` |
| CHECK | C | **L0,没有 LLM 回合** | 亲自跑 verify.sh 分支 + 进程内独立 Verifier,依据证据判定 pass/fail |
| ACT | A | LLM(escalator),仅一轮 | fail 时诊断一轮,决定重试、升级(L2 改方案 / L3 改问题定义)还是停机 |
| done / halted | — | — | 全部通过后收尾,恢复用户原工具集 |

几个贯穿全程的机制:

- **验证接缝**:每条 AC 映射到 verify.sh 的一个分支,能跑出退出码;冻结前系统跑
  基线校验,默认每条 AC 此刻必须是红的(红→绿才是证据),回归型 AC 显式声明 `green`。
- **熔断与升级**:同一失败签名连续出现会熔断,升级就是状态机往回走一格 ——
  L2 回 PLAN 改方案,L3 回 DEFINE 改问题定义;每次升级都换干净上下文。
- **状态落盘**:所有状态都在仓库的 `missions/` 目录里(指针 + SNAPSHOT.json +
  LOG.md),不在会话对话里,所以换脑、reload、重启都不丢进度。
  换机器是**串行交接**,不是 git 同步 —— SNAPSHOT 不进版本控制(见 ARCHITECTURE 8.8)。

## 模块地图

按 `CLAUDE.md` 的分层清单,`src/` 与配套目录各自职责如下(入口是 `src/index.ts`):

| 模块 | 职责 |
|---|---|
| `src/index.ts` | 装配层:挂 pi 事件(session_start、tool_call 等)、注册工具与命令、entry renderer |
| `src/runtime.ts` | 哑管道:采证据 → 调 core 的 judge() → 把事件喂给状态机 → 把返回的 Effect[] 翻译成 pi 调用。**刻意不做任何判定** |
| `src/phase-prompts.ts` | 相位提示词的选取:按判定装置分流,standard 读盘,quick 走内联 |
| `src/core/` | 纯函数,唯一裁判。不 import pi、不读文件、不调网络;含相位状态机(`machine.ts`)、熔断(`breaker.ts`)、判定(`verdict.ts`)、基线(`baseline.ts`)、档位(`tier.ts`)等,每个判定都有单测 |
| `src/store/` | v2 Repository:计划、状态、日志、证据、git/scaffold 的仓库读写 |
| `src/roles/` | models.json 的角色模型映射 + 进程内 Verifier AgentSession |
| `src/hooks/` | tool_call 闸门 + 编辑级增量反馈;闸门只依赖 STATE,不依赖上一个工具的结果 |
| `src/ui/` | TUI 纯函数渲染:`chrome.ts`(盒框架积木)、`panel.ts`(/missions 主面板)、plan-review(冻结前评审页)、ask-review、status-view、dashboard 等 |
| `templates/` | scaffold 铺进目标仓库的工作流文件(standard/complex 的相位提示词、脚本) |
| `skills/` | 随包分发的 pi skill(入场导览:该不该开 mission、选哪档) |

数据流向一句话:pi 事件 → `src/index.ts` 装配层 → `src/runtime.ts` 哑管道 →
`src/core/` 判定 → Effect 翻译回 pi 调用与落盘;状态永远在 `missions/` 目录,不在内存里。

## 开发与验证

本仓库无构建步骤,pi 直接跑 `.ts`;要求 Node ≥ 22.6。常用命令(见 `CLAUDE.md`):

```bash
npm test                                                      # 全部:core 单测 + runtime/UI 冒烟
node --test src/core/__tests__/breaker.test.ts                # 跑单个测试文件
node --test --test-name-pattern="熔断" src/core/__tests__/breaker.test.ts   # 跑单个用例(名字是中文)
npx tsc --noEmit                                              # 类型检查(tsconfig 只 include src/)
```

- `npm test`:core 的纯函数单测 + `test/runtime.smoke.test.ts`(mock pi/ctx 驱动真实
  Runtime 走完整循环)+ UI 渲染测试。
- `node --test ...`:core 单测无外部依赖、跑得快;判定逻辑的改动必须在这里有覆盖。
- `npx tsc --noEmit`:只做类型检查,不产出构建物。

手工装载扩展到目标仓库试跑(临时装载,不落设置):

```bash
pi -e /absolute/path/to/pi-missions
```

然后在那边用 `/missions` 或 `/mission new "…"`。注意:**别在本仓库里跑 mission** ——
它会把 `missions/` 脚手架铺到这里。

## 硬约束摘要

改代码前必须守住的红线(来源:`CLAUDE.md` 分层与硬约束、`docs/ARCHITECTURE.md` 不变量章节):

1. **`src/core/` 必须保持纯净**:不 import pi、不读文件、不调网络、除事件携带的
   `at` 之外不依赖环境。这是"core 纯 TypeScript 是唯一裁判"的物理保证。
2. **状态推进只走 `Runtime.applyEvent()`**:它是唯一漏斗(transition → 落盘 →
   翻译 Effect → 刷 widget);非法迁移不抛异常、状态不变。不要在别处直接改 state。
3. **内存态不可信**:pi 在 newSession/reload/重启时重建扩展实例,关键路径都从
   `missions/state/CURRENT` 指针 + SNAPSHOT.json **重附着**(`ensureAttached()`)。
4. **闸门只依赖 STATE**(`src/hooks/gate.ts`):不依赖"上一个工具的结果" ——
   并行工具执行时序不保证;相位能力矩阵在 `toolsForPhase()`。
5. **AC 冻结后只读**:工具集切换 + gate 拦 `missions/state/` 的编辑 + bash 写操作
   粗检,三道锁;别加绕过任何一道的"方便入口"。
6. **`mission_submit` 不接受任何参数**:判定依据必须先于执行冻结(I2/I3);
   任何让执行者事后补判定标准的改动都是在拆这套设计。
7. **UI 层三个坑**(历史事故):主题色名写错会炸整个 pi 进程;行宽越界同样炸 TUI
   (用 `chrome.ts` 的 `clip()`/`pad()`);拼装差一列会把盒子撕开
   (`test/render.test.ts` 是防线)。长文本一律折行不截断。

提交约定:Conventional Commits + 中文正文,scope 用模块名(如 `fix(ui):`)。

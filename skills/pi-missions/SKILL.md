---
name: pi-missions
description: 用 pi-missions 工作流引擎推进有明确完成判据的任务(PDCA 双循环:L0 纯代码裁判,LLM 只是执行者)。当任务多步骤、可验证、值得留档时使用;一次性问答或纯探索不用。提供入场决策:该不该开 mission、quick/standard/complex 三档怎么选、入口命令怎么写。
---

# pi-missions 入场导览

这份 skill 只回答一个问题:**当前这个任务,要不要开 mission、开哪一档**。
进入 mission 之后的行为规范由系统按相位(DEFINE/PLAN/DO/CHECK/ACT)自动注入,不在这里,
也不要凭这份文档猜相位内的做法。

## 什么时候开 mission

开的信号(满足其一就值得考虑):

- 任务要动多处代码,或需要「先探明再动手」——DO 之前有 DEFINE/PLAN 兜底;
- 完成与否能被**客观判定**(测试通过、命令退出码、文件存在且内容匹配)——mission 的裁判是代码不是模型自评;
- 中途可能换脑/换人接着干——状态落在仓库 `missions/` 里,进度即文件。

不开的场合:一次性问答、读代码解释、临时探查、改完即弃的脚本。直接做,别上流程。

## 三档怎么选

判据只有一条:**动手之前,你能不能把「做完长什么样」写成一条能跑的命令?**

| 档 | 判据 | 入口 |
|---|---|---|
| quick | 能写成一条命令(退出码即判定) | `/mission quick <任务> --verify "<命令>"` |
| standard | 写不出一条命令,但说得清完成条件 | `/mission new <目标>` |
| complex | 需要里程碑分解 + 方案评审 | `/mission new --tier=complex <目标>` |

注意:

- quick 的 `--verify` 是判定的唯一依据,**必须给**;不给会自动升 standard 走 DEFINE/PLAN,
  这不是报错,是设计(判定依据必须先于执行冻结)。
- 语义判定(「页面更好用了」)不属于 quick——把语义转写成命令(测试/grep/curl 断言)才能进快车道;
  转不动就说明该走 standard。
- 档位拿不准就选 standard,DEFINE 阶段的提问会把模糊目标锐化掉。

## 入口与查看

- `/mission quick <任务> --verify "<命令>"` —— 单任务快捷档,不落盘
- `/mission new <目标>` —— standard/complex,起于 DEFINE
- `/missions` —— 面板:所有 mission 的状态、成本、恢复/中止
- `/mission status` —— 当前 mission 的详情卡片
- `/mission tier <quick|standard|complex>` —— 设定待用档位,之后直接输入目标回车即开(Esc 取消)

## 硬性规则(违反了会被闸门拦,别试)

- `mission_submit` 不接受任何参数 —— 完成判定依据先于执行冻结,执行者不能事后补标准;
- AC 冻结后只读,要改走升级(L1 重试 / L2 改方案 / L3 重定义问题);
- 一个仓库同时只推进一个 mission;并行的正确姿势是 git worktree 分开;
- 看到「换脑(handoff)」提示就 `/mission next` —— 上下文水位到了,状态在盘上,丢不了。

# Mission: 2026-09-02-mission-mtkbyu2u

tier: standard
goal: 为 pi-missions 项目产出一份面向新成员的概览级技术报告(Markdown,落在本仓库文档目录),涵盖项目定位、双层循环工作流、模块地图、测试与开发流程、关键硬约束

## Frozen Acceptance Criteria

> 本节只读。修改必须走 L3 升级,并以 `mission-escalate(L3):` 前缀单独提交。


## Define

> 问题定义(DEFINE 相位产出)

完成条件(每条都必须被上面的 AC 覆盖):

- DW1: docs/ 下新增一份中文 Markdown 技术报告(如 docs/TECH-REPORT.md,最终路径由 PLAN 定),内容面向新成员:项目是什么、双层循环工作流如何运转、分层结构(core/runtime/store/ui 等)与各层职责
- DW2: 报告包含模块地图:按 src/ 目录逐层说明各目录做什么、入口在哪(以 README/CLAUDE.md/ARCHITECTURE.md 为依据)
- DW3: 报告包含'怎么跑起来/怎么验证':如何装载扩展到目标仓库、npm test / 单测 / tsc --noEmit 等命令与含义
- DW4: 报告包含关键硬约束摘要(如 core 纯净、状态推进只走 applyEvent、AC 冻结只读等),来源可追溯到 README/CLAUDE.md/ARCHITECTURE.md
- DW5: 报告中所有事实性陈述与 README.md / CLAUDE.md / docs/ARCHITECTURE.md 不冲突,引用文件名与符号名真实存在

- 约束:报告面向新成员,概览级深度,依据 README.md / CLAUDE.md / docs/ARCHITECTURE.md 归纳
- 约束:产出为 Markdown 文件,路径由 PLAN 确定为 docs/ 下某个文件名
- 约束:本仓库文档与注释均为中文,报告保持中文
- 约束:不写代码、不改源码:这是一个纯文档产出的 mission
- 不做:不精确到文件+符号名的深度架构剖析(概览级即可)
- 不做:不评估技术债、成熟度或风险(那是技术评审报告)
- 不做:不写面向外部协作方的接口文档
- 不做:不改任何源码与现有文档
- 接缝:文件级验收:检查报告 Markdown 文件存在、包含约定章节(可用 grep 匹配章节标题/关键术语计数),并抽查其中的事实陈述与 README/CLAUDE.md/ARCHITECTURE.md 一致

<details><summary>DEFINE 问答记录</summary>

- 问:技术报告的读者是谁?
  答:新成员上手(推荐项被选中):写清 pi-missions 是什么、分层、模块地图、怎么跑测试
- 问:报告落在哪、什么格式?
  答:仓库根/文档目录下一个 Markdown 文件(推荐项被选中),如 docs/TECH-REPORT.md
- 问:深度与事实校验标准?
  答:概览级,按 README/CLAUDE.md 归纳即可

</details>

## Tasks


```mission
{
  "missionId": "2026-09-02-mission-mtkbyu2u",
  "tier": "standard",
  "goal": "为 pi-missions 项目产出一份面向新成员的概览级技术报告(Markdown,落在本仓库文档目录),涵盖项目定位、双层循环工作流、模块地图、测试与开发流程、关键硬约束",
  "definition": {
    "constraints": [
      "报告面向新成员,概览级深度,依据 README.md / CLAUDE.md / docs/ARCHITECTURE.md 归纳",
      "产出为 Markdown 文件,路径由 PLAN 确定为 docs/ 下某个文件名",
      "本仓库文档与注释均为中文,报告保持中文",
      "不写代码、不改源码:这是一个纯文档产出的 mission"
    ],
    "nonGoals": [
      "不精确到文件+符号名的深度架构剖析(概览级即可)",
      "不评估技术债、成熟度或风险(那是技术评审报告)",
      "不写面向外部协作方的接口文档",
      "不改任何源码与现有文档"
    ],
    "doneWhen": [
      {
        "id": "DW1",
        "text": "docs/ 下新增一份中文 Markdown 技术报告(如 docs/TECH-REPORT.md,最终路径由 PLAN 定),内容面向新成员:项目是什么、双层循环工作流如何运转、分层结构(core/runtime/store/ui 等)与各层职责"
      },
      {
        "id": "DW2",
        "text": "报告包含模块地图:按 src/ 目录逐层说明各目录做什么、入口在哪(以 README/CLAUDE.md/ARCHITECTURE.md 为依据)"
      },
      {
        "id": "DW3",
        "text": "报告包含'怎么跑起来/怎么验证':如何装载扩展到目标仓库、npm test / 单测 / tsc --noEmit 等命令与含义"
      },
      {
        "id": "DW4",
        "text": "报告包含关键硬约束摘要(如 core 纯净、状态推进只走 applyEvent、AC 冻结只读等),来源可追溯到 README/CLAUDE.md/ARCHITECTURE.md"
      },
      {
        "id": "DW5",
        "text": "报告中所有事实性陈述与 README.md / CLAUDE.md / docs/ARCHITECTURE.md 不冲突,引用文件名与符号名真实存在"
      }
    ],
    "verifySeam": "文件级验收:检查报告 Markdown 文件存在、包含约定章节(可用 grep 匹配章节标题/关键术语计数),并抽查其中的事实陈述与 README/CLAUDE.md/ARCHITECTURE.md 一致",
    "resolved": [
      {
        "q": "技术报告的读者是谁?",
        "a": "新成员上手(推荐项被选中):写清 pi-missions 是什么、分层、模块地图、怎么跑测试"
      },
      {
        "q": "报告落在哪、什么格式?",
        "a": "仓库根/文档目录下一个 Markdown 文件(推荐项被选中),如 docs/TECH-REPORT.md"
      },
      {
        "q": "深度与事实校验标准?",
        "a": "概览级,按 README/CLAUDE.md 归纳即可"
      }
    ],
    "at": 1788367818442
  },
  "acceptanceCriteria": [],
  "milestones": [],
  "verifyScript": "",
  "createdAt": 1788367722438
}
```

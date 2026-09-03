# Mission: 2026-09-02-mission-mtkbyu2u

tier: standard
goal: 产出面向新成员的概览级技术报告 docs/TECH-REPORT.md,涵盖项目定位、双层循环工作流、模块地图、开发与验证流程、硬约束

## Frozen Acceptance Criteria

> 本节只读。修改必须走 L3 升级,并以 `mission-escalate(L3):` 前缀单独提交。

- AC1 (verify: `ac1`, baseline: red, 覆盖: DW1+DW2): docs/ 下存在中文技术报告(TECH-REPORT.md),含「项目定位」「工作流机制」章节:提到 pi-missions 是跑在 pi 上的扩展包、双层循环、PDCA 相位与核心断言(core 纯 TypeScript 是唯一裁判)
- AC2 (verify: `ac2`, baseline: red, 覆盖: DW2): 报告含「模块地图」章节,覆盖分层清单中的目录:src/index.ts、runtime、phase-prompts、core、store、roles、hooks、ui、templates、skills,并说明各自职责
- AC3 (verify: `ac3`, baseline: red, 覆盖: DW3): 报告含「开发与验证」章节,列出可运行的命令:npm test、node --test 单文件、test-name-pattern 单用例、npx tsc --noEmit,以及 pi -e 装载方法
- AC4 (verify: `ac4`, baseline: red, 覆盖: DW4): 报告含「硬约束」章节,至少覆盖 6 条:core 纯净、状态推进只走 Runtime.applyEvent、内存态不可信(重附着)、闸门只依赖 STATE、AC 冻结后只读、mission_submit 无参数
- AC5 (verify: `ac5`, baseline: red, 覆盖: DW5): 报告中引用的文件/目录/符号名都真实存在,与 README/CLAUDE/ARCHITECTURE 无事实冲突

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

- [ ] T1 通读 README.md、CLAUDE.md、docs/ARCHITECTURE.md、src/ 目录结构,提取模块地图与硬约束素材 **[spike]** —— 要回答:按 CLAUDE.md 分层清单读源码,每层实际有哪些主要文件/符号,有没有 README/CLAUDE 已过时的陈述?(产出书面结论,完成后重写计划)
- [ ] T2 撰写 docs/TECH-REPORT.md(五个章节:项目定位、工作流机制、模块地图、开发与验证、硬约束) (verify: `ac1`, `ac2`, `ac3`, `ac4`, `ac5`)

```mission
{
  "missionId": "2026-09-02-mission-mtkbyu2u",
  "tier": "standard",
  "goal": "产出面向新成员的概览级技术报告 docs/TECH-REPORT.md,涵盖项目定位、双层循环工作流、模块地图、开发与验证流程、硬约束",
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
  "acceptanceCriteria": [
    {
      "baseline": "red",
      "covers": [
        "DW1",
        "DW2"
      ],
      "id": "AC1",
      "text": "docs/ 下存在中文技术报告(TECH-REPORT.md),含「项目定位」「工作流机制」章节:提到 pi-missions 是跑在 pi 上的扩展包、双层循环、PDCA 相位与核心断言(core 纯 TypeScript 是唯一裁判)",
      "verify": "ac1"
    },
    {
      "baseline": "red",
      "covers": [
        "DW2"
      ],
      "id": "AC2",
      "text": "报告含「模块地图」章节,覆盖分层清单中的目录:src/index.ts、runtime、phase-prompts、core、store、roles、hooks、ui、templates、skills,并说明各自职责",
      "verify": "ac2"
    },
    {
      "baseline": "red",
      "covers": [
        "DW3"
      ],
      "id": "AC3",
      "text": "报告含「开发与验证」章节,列出可运行的命令:npm test、node --test 单文件、test-name-pattern 单用例、npx tsc --noEmit,以及 pi -e 装载方法",
      "verify": "ac3"
    },
    {
      "baseline": "red",
      "covers": [
        "DW4"
      ],
      "id": "AC4",
      "text": "报告含「硬约束」章节,至少覆盖 6 条:core 纯净、状态推进只走 Runtime.applyEvent、内存态不可信(重附着)、闸门只依赖 STATE、AC 冻结后只读、mission_submit 无参数",
      "verify": "ac4"
    },
    {
      "baseline": "red",
      "covers": [
        "DW5"
      ],
      "id": "AC5",
      "text": "报告中引用的文件/目录/符号名都真实存在,与 README/CLAUDE/ARCHITECTURE 无事实冲突",
      "verify": "ac5"
    }
  ],
  "milestones": [
    {
      "id": "M1",
      "tasks": [
        {
          "id": "T1",
          "kind": "spike",
          "question": "按 CLAUDE.md 分层清单读源码,每层实际有哪些主要文件/符号,有没有 README/CLAUDE 已过时的陈述?",
          "title": "通读 README.md、CLAUDE.md、docs/ARCHITECTURE.md、src/ 目录结构,提取模块地图与硬约束素材",
          "verify": []
        },
        {
          "id": "T2",
          "title": "撰写 docs/TECH-REPORT.md(五个章节:项目定位、工作流机制、模块地图、开发与验证、硬约束)",
          "verify": [
            "ac1",
            "ac2",
            "ac3",
            "ac4",
            "ac5"
          ]
        }
      ],
      "title": "撰写技术报告"
    }
  ],
  "verifyScript": "#!/usr/bin/env bash\n# 技术报告验收:docs/TECH-REPORT.md\nREPORT=\"docs/TECH-REPORT.md\"\nfail() { echo \"FAIL: $1\"; exit 1; }\n[ -f \"$REPORT\" ] || fail \"报告文件不存在: $REPORT\"\n\ncase \"$1\" in\n  ac1)\n    grep -q \"pi-missions\" \"$REPORT\" || fail \"未提及 pi-missions\"\n    grep -q \"双层\" \"$REPORT\" || fail \"未描述双层循环\"\n    for kw in \"DEFINE\" \"PLAN\" \"ACT\" \"唯一裁判\"; do\n      grep -q \"$kw\" \"$REPORT\" || fail \"缺少关键词: $kw\"\n    done\n    ;;\n  ac2)\n    for m in \"src/index.ts\" \"runtime\" \"core\" \"store\" \"hooks\" \"ui\" \"templates\" \"skills\" \"phase-prompts\" \"roles\"; do\n      grep -q \"$m\" \"$REPORT\" || fail \"模块地图缺少: $m\"\n    done\n    ;;\n  ac3)\n    grep -q \"npm test\" \"$REPORT\" || fail \"缺 npm test\"\n    grep -q \"node --test\" \"$REPORT\" || fail \"缺 node --test\"\n    grep -q \"tsc --noEmit\" \"$REPORT\" || fail \"缺 tsc --noEmit\"\n    grep -q -- \"-e\" \"$REPORT\" || fail \"缺 pi -e 装载方法\"\n    ;;\n  ac4)\n    for kw in \"纯净\" \"applyEvent\" \"不可信\" \"STATE\" \"冻结\" \"mission_submit\"; do\n      grep -q \"$kw\" \"$REPORT\" || fail \"硬约束缺少: $kw\"\n    done\n    ;;\n  ac5)\n    for p in \"src/index.ts\" \"src/runtime.ts\" \"src/core\" \"src/store\" \"src/hooks\" \"src/ui\" \"templates\" \"skills\" \"docs/ARCHITECTURE.md\"; do\n      [ -e \"$p\" ] || fail \"报告中引用的路径不存在: $p\"\n    done\n    grep -q \"ARCHITECTURE\" \"$REPORT\" || fail \"报告未引用 ARCHITECTURE.md 作为依据\"\n    ;;\n  *)\n    fail \"未知分支: $1\"\n    ;;\nesac\necho \"PASS: $1\"\nexit 0",
  "createdAt": 1788367722438
}
```

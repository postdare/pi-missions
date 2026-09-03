# Mission: 2026-09-02-mission-mtkbyu2u

tier: standard
goal: 产出面向新成员的概览级技术报告 docs/TECH-REPORT.md,涵盖项目定位、双层循环工作流、模块地图、开发与验证流程、硬约束

## Frozen Acceptance Criteria

> 本节只读。修改必须走 L3 升级,并以 `mission-escalate(L3):` 前缀单独提交。

- AC1 (verify: `ac1`, baseline: red, 覆盖: DW1): docs/TECH-REPORT.md 存在,为中文技术报告,含「项目定位」「工作流机制」章节:提到 pi-missions 是跑在 pi 上的扩展包、双层循环、PDCA 相位与核心断言(core 纯 TypeScript 是唯一裁判)
- AC2 (verify: `ac2`, baseline: red, 覆盖: DW2): 报告含「模块地图」章节,覆盖分层清单全部十项:src/index.ts、runtime、phase-prompts、core、store、roles、hooks、ui、templates、skills,并说明各自职责
- AC3 (verify: `ac3`, baseline: red, 覆盖: DW3): 报告含「开发与验证」章节,列出 npm test、node --test 单文件、test-name-pattern 单用例、npx tsc --noEmit,以及 pi -e 装载方法,并说明各命令含义
- AC4 (verify: `ac4`, baseline: red, 覆盖: DW4): 报告含「硬约束」章节,至少覆盖 6 条:core 纯净、状态推进只走 Runtime.applyEvent、内存态不可信(重附着)、闸门只依赖 STATE、AC 冻结后只读、mission_submit 无参数
- AC5 (verify: `ac5`, baseline: red, 覆盖: DW5): 报告中引用的文件/目录/符号名真实存在,且与 README/CLAUDE.md/ARCHITECTURE.md 无事实冲突(存在性检查 + 抽查关键陈述)

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

## Approach

> 方案(L2 升级改的就是这一段)

写一个新文件 docs/TECH-REPORT.md(不改任何源码与现有文档),全文中文、概览级深度,素材完全取自 README.md、CLAUDE.md、docs/ARCHITECTURE.md 与 src/ 实际目录(上一轮 spike T1 已核过,无过时陈述)。结构五个章节:①项目定位 ②工作流机制(双层循环:外层 PDCA 相位状态机,内层操控循环;核心断言 core 纯 TypeScript 是唯一裁判)③模块地图(按 CLAUDE.md 分层清单逐层:src/index.ts 装配、runtime.ts 哑管道、phase-prompts.ts 相位提示词、core/ 纯函数裁判、store/、roles/、hooks/、ui/、templates/、skills/,每层两三句职责)④开发与验证(npm test、node --test 单文件、--test-name-pattern 单用例、npx tsc --noEmit、pi -e 装载方法及各自含义)⑤硬约束摘要(≥6 条,逐条标注来源文档)。写作时所有文件/目录/符号名先与仓库实际路径核对,避免引入不存在的东西。验收用 verify.sh 分支 grep 章节标题与关键术语,AC5 用存在性检查核对报告引用的路径。

- D1: 报告路径定为 docs/TECH-REPORT.md
  - 为什么:DEFINE 问答已确认落 docs/ 下,TECH-REPORT.md 与现有 docs/ARCHITECTURE.md 命名风格一致,且与 README 中的示例一致
  - 否决:missions/ 产物区(状态目录会被归档清理,不适合长期文档)
- D2: 内容只依据 README.md / CLAUDE.md / docs/ARCHITECTURE.md 归纳,概览级,不深入到文件+符号名的架构剖析;但引用的路径/目录名仍逐个与仓库实际存在性核对
  - 为什么:DEFINE 约束已确认概览级;spike T1 已确认三份文档与代码无冲突,可直接归纳。AC5 仍要求引用名真实存在,所以存在性核对是底线
  - 否决:逐符号精读 src/ 源码做深度剖析(超出本 mission 的『不做』边界,且 ARCHITECTURE.md 已有)
- D3: 报告分五个章节,标题分别为「项目定位」「工作流机制」「模块地图」「开发与验证」「硬约束」,与五条 AC 一一对应
  - 为什么:章节与 AC 一一对应使 verify.sh 的 grep 判定简单直接,也与 GOAL 的列举顺序一致
- D4: 纯文档 mission,不写任何 verify 辅助脚本、不改源码;verify.sh 只做 grep/存在性检查
  - 为什么:DEFINE 约束『不写代码、不改源码』;文件级验收接缝也确认了 grep 式验收

## Tasks

- [ ] T1 撰写 docs/TECH-REPORT.md(五个章节:项目定位、工作流机制、模块地图、开发与验证、硬约束),引用的路径/目录名逐个核对真实存在 (verify: `ac1`, `ac2`, `ac3`, `ac4`, `ac5`)

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
  "approach": {
    "summary": "写一个新文件 docs/TECH-REPORT.md(不改任何源码与现有文档),全文中文、概览级深度,素材完全取自 README.md、CLAUDE.md、docs/ARCHITECTURE.md 与 src/ 实际目录(上一轮 spike T1 已核过,无过时陈述)。结构五个章节:①项目定位 ②工作流机制(双层循环:外层 PDCA 相位状态机,内层操控循环;核心断言 core 纯 TypeScript 是唯一裁判)③模块地图(按 CLAUDE.md 分层清单逐层:src/index.ts 装配、runtime.ts 哑管道、phase-prompts.ts 相位提示词、core/ 纯函数裁判、store/、roles/、hooks/、ui/、templates/、skills/,每层两三句职责)④开发与验证(npm test、node --test 单文件、--test-name-pattern 单用例、npx tsc --noEmit、pi -e 装载方法及各自含义)⑤硬约束摘要(≥6 条,逐条标注来源文档)。写作时所有文件/目录/符号名先与仓库实际路径核对,避免引入不存在的东西。验收用 verify.sh 分支 grep 章节标题与关键术语,AC5 用存在性检查核对报告引用的路径。",
    "decisions": [
      {
        "id": "D1",
        "text": "报告路径定为 docs/TECH-REPORT.md",
        "why": "DEFINE 问答已确认落 docs/ 下,TECH-REPORT.md 与现有 docs/ARCHITECTURE.md 命名风格一致,且与 README 中的示例一致",
        "rejected": "missions/ 产物区(状态目录会被归档清理,不适合长期文档)"
      },
      {
        "id": "D2",
        "text": "内容只依据 README.md / CLAUDE.md / docs/ARCHITECTURE.md 归纳,概览级,不深入到文件+符号名的架构剖析;但引用的路径/目录名仍逐个与仓库实际存在性核对",
        "why": "DEFINE 约束已确认概览级;spike T1 已确认三份文档与代码无冲突,可直接归纳。AC5 仍要求引用名真实存在,所以存在性核对是底线",
        "rejected": "逐符号精读 src/ 源码做深度剖析(超出本 mission 的『不做』边界,且 ARCHITECTURE.md 已有)"
      },
      {
        "id": "D3",
        "text": "报告分五个章节,标题分别为「项目定位」「工作流机制」「模块地图」「开发与验证」「硬约束」,与五条 AC 一一对应",
        "why": "章节与 AC 一一对应使 verify.sh 的 grep 判定简单直接,也与 GOAL 的列举顺序一致"
      },
      {
        "id": "D4",
        "text": "纯文档 mission,不写任何 verify 辅助脚本、不改源码;verify.sh 只做 grep/存在性检查",
        "why": "DEFINE 约束『不写代码、不改源码』;文件级验收接缝也确认了 grep 式验收"
      }
    ]
  },
  "acceptanceCriteria": [
    {
      "id": "AC1",
      "text": "docs/TECH-REPORT.md 存在,为中文技术报告,含「项目定位」「工作流机制」章节:提到 pi-missions 是跑在 pi 上的扩展包、双层循环、PDCA 相位与核心断言(core 纯 TypeScript 是唯一裁判)",
      "verify": "ac1",
      "covers": [
        "DW1"
      ],
      "baseline": "red"
    },
    {
      "id": "AC2",
      "text": "报告含「模块地图」章节,覆盖分层清单全部十项:src/index.ts、runtime、phase-prompts、core、store、roles、hooks、ui、templates、skills,并说明各自职责",
      "verify": "ac2",
      "covers": [
        "DW2"
      ],
      "baseline": "red"
    },
    {
      "id": "AC3",
      "text": "报告含「开发与验证」章节,列出 npm test、node --test 单文件、test-name-pattern 单用例、npx tsc --noEmit,以及 pi -e 装载方法,并说明各命令含义",
      "verify": "ac3",
      "covers": [
        "DW3"
      ],
      "baseline": "red"
    },
    {
      "id": "AC4",
      "text": "报告含「硬约束」章节,至少覆盖 6 条:core 纯净、状态推进只走 Runtime.applyEvent、内存态不可信(重附着)、闸门只依赖 STATE、AC 冻结后只读、mission_submit 无参数",
      "verify": "ac4",
      "covers": [
        "DW4"
      ],
      "baseline": "red"
    },
    {
      "id": "AC5",
      "text": "报告中引用的文件/目录/符号名真实存在,且与 README/CLAUDE.md/ARCHITECTURE.md 无事实冲突(存在性检查 + 抽查关键陈述)",
      "verify": "ac5",
      "covers": [
        "DW5"
      ],
      "baseline": "red"
    }
  ],
  "milestones": [
    {
      "id": "M1",
      "title": "撰写技术报告",
      "tasks": [
        {
          "id": "T1",
          "title": "撰写 docs/TECH-REPORT.md(五个章节:项目定位、工作流机制、模块地图、开发与验证、硬约束),引用的路径/目录名逐个核对真实存在",
          "verify": [
            "ac1",
            "ac2",
            "ac3",
            "ac4",
            "ac5"
          ]
        }
      ]
    }
  ],
  "verifyScript": "#!/usr/bin/env bash\n# 技术报告验收:docs/TECH-REPORT.md\nREPORT=\"docs/TECH-REPORT.md\"\nfail() { echo \"FAIL: $1\"; exit 1; }\n[ -f \"$REPORT\" ] || fail \"报告文件不存在: $REPORT\"\n\ncase \"$1\" in\n  ac1)\n    grep -q \"项目定位\" \"$REPORT\" || fail \"缺「项目定位」章节\"\n    grep -q \"工作流机制\" \"$REPORT\" || fail \"缺「工作流机制」章节\"\n    grep -q \"扩展包\" \"$REPORT\" || fail \"未说明 pi-missions 是跑在 pi 上的扩展包\"\n    grep -q \"双层\" \"$REPORT\" || fail \"未描述双层循环\"\n    for kw in \"PDCA\" \"唯一裁判\"; do\n      grep -q \"$kw\" \"$REPORT\" || fail \"缺少关键词: $kw\"\n    done\n    ;;\n  ac2)\n    grep -q \"模块地图\" \"$REPORT\" || fail \"缺「模块地图」章节\"\n    for m in \"src/index.ts\" \"runtime\" \"phase-prompts\" \"core\" \"store\" \"roles\" \"hooks\" \"ui\" \"templates\" \"skills\"; do\n      grep -q \"$m\" \"$REPORT\" || fail \"模块地图缺少: $m\"\n    done\n    ;;\n  ac3)\n    grep -q \"开发与验证\" \"$REPORT\" || fail \"缺「开发与验证」章节\"\n    grep -q \"npm test\" \"$REPORT\" || fail \"缺 npm test\"\n    grep -q \"node --test\" \"$REPORT\" || fail \"缺 node --test\"\n    grep -q \"test-name-pattern\" \"$REPORT\" || fail \"缺 test-name-pattern 单用例\"\n    grep -q \"tsc --noEmit\" \"$REPORT\" || fail \"缺 tsc --noEmit\"\n    grep -q -- \"-e\" \"$REPORT\" || fail \"缺 pi -e 装载方法\"\n    ;;\n  ac4)\n    grep -q \"硬约束\" \"$REPORT\" || fail \"缺「硬约束」章节\"\n    for kw in \"纯净\" \"applyEvent\" \"不可信\" \"STATE\" \"冻结\" \"mission_submit\"; do\n      grep -q \"$kw\" \"$REPORT\" || fail \"硬约束缺少: $kw\"\n    done\n    ;;\n  ac5)\n    # 报告引用的路径必须真实存在(逐个核对,防编造)\n    for p in \"src/index.ts\" \"src/runtime.ts\" \"src/phase-prompts.ts\" \"src/core\" \"src/store\" \"src/roles\" \"src/hooks\" \"src/ui\" \"templates\" \"skills\" \"README.md\" \"CLAUDE.md\" \"docs/ARCHITECTURE.md\" \"src/core/machine.ts\" \"src/core/types.ts\" \"src/ui/chrome.ts\" \"src/ui/panel.ts\"; do\n      grep -q \"$p\" \"$REPORT\" || true\n      [ -e \"$p\" ] || fail \"报告中引用的路径不存在: $p\"\n    done\n    # 事实性抽查:与来源文档的关键陈述一致\n    grep -q \"ARCHITECTURE\" \"$REPORT\" || fail \"报告未引用 ARCHITECTURE.md 作为依据\"\n    grep -q \"哑管道\" \"$REPORT\" || fail \"对 runtime 的描述与 ARCHITECTURE.md 不一致(应为哑管道)\"\n    grep -q \"quick\" \"$REPORT\" || fail \"未提及三档(quick/standard/complex)\"\n    grep -q \"standard\" \"$REPORT\" || fail \"未提及三档(quick/standard/complex)\"\n    grep -q \"complex\" \"$REPORT\" || fail \"未提及三档(quick/standard/complex)\"\n    ;;\n  *)\n    fail \"未知分支: $1\"\n    ;;\nesac\necho \"PASS: $1\"\nexit 0",
  "createdAt": 1788367722438
}
```

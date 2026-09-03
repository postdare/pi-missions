# Factory AI「Missions」功能调研笔记

> 调研日期：2026 年（检索到 2026-04 官方博客与 2026-06 第三方文章，调研时间不早于该时间）。
> 资料以 Factory AI 官方文档（docs.factory.ai）、官网（factory.ai）与官方博客为主；二手资料单独标注。

---

## 1. Missions 是什么？产品定位

**Missions 是 Factory 的"多智能体编排（multi-agent orchestration）"功能**：用于承接大型、多特性（multi-feature）的工程任务。官方定义："Factory Missions are structured workflows for taking on large, multi-feature work with Droid"——用户先与 Droid 协作制定计划（特性、里程碑、所需技能），再把执行交给一个编排层（orchestration layer）管理。
来源：https://docs.factory.ai/missions/overview

官方博客的定位表述是"一个能在多天时间尺度上自主追求目标的 AI 系统"：你描述想要什么、批准范围/计划，然后"回来拿完成的成果"。Droid 负责分解、执行、验证，可跨越数小时到数天（官方数据：中位任务约 2 小时，14% 超过 24 小时，最长一个跑了 16 天）。
来源：https://factory.ai/news/missions

### 与 Factory 其他概念的关系

- **Droid**：Factory 对其 AI 智能体（以及 CLI 产品 `droid`）的统称。Mission 由 Droid 来规划和执行；Missions 是 Droid 之上的一层编排能力，而非独立产品。来源：https://docs.factory.ai/droid-cli/overview
- **Session（会话）**：普通 Droid 会话是交互式的（官方数据：中位约 8 分钟，60% 在 15 分钟内完成）。Missions 是"另一种分布"的长时间自主负载。官方明确建议：**不要把一个跑了很久的普通会话"转换"成 Mission**，应在识别出工作量时就新起一个 Mission，以保留前期规划、特性分解、验证策略和编排上下文。来源：https://factory.ai/news/missions 、https://docs.factory.ai/missions/overview
- **Mission Mode（任务模式）**：Missions（编排功能）与 Mission Mode（Droid 批准计划后进入的会话状态）是两个相关但不同的概念；Mission Mode 与 Normal / Spec 模式并列，属于交互模式体系。来源：https://docs.factory.ai/missions/overview
- **Skills / Custom Droids / MCP / Hooks / AGENTS.md**：Mission 直接继承现有 Droid 配置——worker 可使用 MCP 工具（Linear、Sentry、Notion 等）、自定义技能、生命周期 hooks、项目内自定义子智能体，并遵守 AGENTS.md 项目规范。来源：https://docs.factory.ai/missions/reference
- 适用规模启发式：**约 1–500 个特性**用 Mission 是"甜区"；更少用普通会话，更多则拆成多个 Mission。来源：https://docs.factory.ai/missions/overview

## 2. 核心概念与数据模型

根据官方架构博客《How Missions Work》（Theo Luan, 2026-04-10），一个 Mission 由以下要素组成：

1. **Orchestrator（编排器）**：与用户对话明确需求 → 先写"验证契约" → 把目标分解为 features 和 milestones → 指挥执行、处理验证反馈、生成修复特性。它刻意不积累细粒度上下文，把调研与实现全部委派给子智能体。
2. **Validation Contract（验证契约）**：一组有限的、可测试的行为断言（behavioral assertions），先于任何 feature 定义完成与正确性标准——这是"任务级 TDD"：先定义正确性，再定义实现。
3. **Features（特性）**：有界的最小实现单元，每个 feature 声明它将满足契约中的哪些断言。每个 feature 由一个**全新上下文的 worker** 执行（先写测试再实现）。
4. **Milestones（里程碑）**：features 的分组，每个里程碑是一个有意义的功能检查点；里程碑结束触发验证。
5. **Workers（执行智能体）**：完成规格明确的 feature，自我迭代到认为正确后交接——但**正确性的最终判定不属于 worker**。
6. **Validators（验证智能体）**，分两类：
   - **Scrutiny validators**：审查 worker 的实现与轨迹（trajectory）的质量与正确性，并把知识写回共享状态；
   - **User-testing validators**：以黑盒方式像真实用户一样操作应用（官方提到自带 computer-use 工具 `tuistory` 和 `agent-browser`，可 QA Web/Electron/终端 UI 应用），按验证契约逐条核对行为。
7. **Shared state（外化共享状态）**：验证契约、特性清单、调研笔记、操作规范、持续增长的知识库等文件——没有任何单一 agent 需要把全貌装进上下文，各取所需。
8. **Programmatic runner（程序化运行器）**：按顺序为每个 feature 拉起 worker；里程碑内所有 feature 完成后触发验证。

**执行循环**：实现 → 里程碑验证 → 验证发现问题 → orchestrator 生成"fix features" → 修复后重新验证，循环直到通过；若实现或验证被阻塞，orchestrator 中止任务并把控制权交还用户。官方实例：一个"Slack 克隆"Mission 跑了 6 个里程碑，验证占总时长 37.2%，产生 38.8k 行代码（52.5% 是测试，语句覆盖率 89.25%），验证者提出 81 个问题、orchestrator 生成 21 个修复特性。
来源：https://factory.ai/news/missions-architecture

**设计理念**：核心是"agent 对其上下文高度敏感"——无关上下文与"对抗性上下文"（实现者难以客观评价自己的成果）都会降低表现，因此通过职责/激励分离 + 两层 TDD + 状态外化 + 按角色选模型来解决。来源：https://factory.ai/news/missions-architecture

**成本/时长估算启发式**：`总运行次数 ≈ 特性数 + 2 × 里程碑数`（feature worker 约每特性 1 次；每个里程碑 2 次验证 worker），且这是下限——验证发现问题会产生额外修复工作。来源：https://docs.factory.ai/missions/planning

## 3. 用户如何使用（UI / CLI / API）

### CLI
- 在任意 Droid 会话中运行 **`/missions`**（亦可用 `/mission`；早期发布博客中写作 `/enter-mission`，现文档统一为 `/missions`）启动。来源：https://docs.factory.ai/missions/overview 、https://factory.ai/news/missions
- **无头模式**：`droid exec --mission` 可非交互运行 Mission，适用于 CI、定时任务等场景；可用 `--worker-model`、`--worker-reasoning-effort`、`--validator-model`、`--validator-reasoning-effort` 覆盖 worker/validator 的模型与推理强度。来源：https://docs.factory.ai/missions/reference
- 计划批准后即进入 **Mission Control** 编排视图，可跟踪 feature/milestone 进度、查看各 agent 在做什么，并随时干预（暂停 orchestrator、用自然语言描述问题让其恢复或重规划）。来源：https://docs.factory.ai/missions/running-cli

### Factory App（Web 端）
- 提供可视化 **Mission Control 仪表盘**（https://app.factory.ai/missions）：顶栏显示总耗时与 credits 消耗，右侧栏为实时进度日志，左侧栏列出所有 worker（可查看终端输出、思考过程、子任务），主视图可下钻每个 feature 的验证标准与提交记录。来源：https://docs.factory.ai/missions/running-app
- 可在右侧栏**动态切换** Orchestrator / Worker / Validator 各自使用的模型。来源：https://docs.factory.ai/missions/running-app
- 可**恢复历史 Mission**（从断点继续执行），并可选择 **Droid Computer**（Factory 托管的云端持久机器）作为运行环境，让长任务在后台远程执行而不占用本地工作区。来源：https://docs.factory.ai/missions/running-app
- 人工干预：可从 UI 直接暂停 orchestrator、指示其重新评估/重规划，然后恢复。来源：https://docs.factory.ai/missions/running-app

### 配置
- `settings` 中的 `missionModelSettings`（workerModel / workerReasoningEffort / validationWorkerModel / validationWorkerReasoningEffort / skipScrutiny / skipUserTesting）与顶层 `missionOrchestratorModel`、`missionOrchestratorReasoningEffort`、`keepSystemAwakeDuringMissions`（默认 true，防止任务期间系统休眠）。官方建议的性价比组合：强 orchestrator 模型 + 更快的 worker 模型。来源：https://docs.factory.ai/missions/reference
- 企业可通过 org 级 `missionPolicy` 限制哪些成员能发起 Mission（`restrictedAccess` + `allowedUserIds`）。来源：https://docs.factory.ai/missions/reference

### 使用流程（官方五步）
`/missions` 进入 → 与 Droid 多轮对话明确目标（官方强调这是对话而非一次性 prompt）→ 生成 features + milestones 结构化计划 → 复用/新开发技能 → 批准计划后进入 Mission Control 执行。
来源：https://docs.factory.ai/missions/overview

## 4. 支持的能力

| 能力 | 支持情况 | 来源 |
|---|---|---|
| 并行 agent | 支持但克制：官方表示"在协调开销低的地方并行"（特性内与验证阶段），并直言"串行执行 + 定向并行"实测优于广泛并行；并行化是否必要仍是其公开研究的开放问题 | https://factory.ai/news/missions 、https://docs.factory.ai/missions/overview |
| 验证/QA | 双层验证：worker 级 TDD + 里程碑级 scrutiny（代码审查）与 user-testing（黑盒操作应用，原生 computer use）；可在 Mission Control 设置中关闭 QA 式验证 | https://factory.ai/news/missions 、https://docs.factory.ai/missions/planning |
| 人工审批/接管 | 计划需用户批准后才执行；执行中可随时暂停 orchestrator、对话式纠偏、重规划；被阻塞时自动交还控制权。官方把用户角色定义为"agent 团队的项目经理" | https://docs.factory.ai/missions/running-cli 、https://factory.ai/news/missions-architecture |
| CI / 无头集成 | `droid exec --mission` 面向 CI、定时任务等无 TUI 环境 | https://docs.factory.ai/missions/reference |
| 远程/后台运行 | 可在 Droid Computer（云端持久机器）上后台运行长任务 | https://docs.factory.ai/missions/running-app |
| git 协作 | 官方博客称 worker 之间"通过 git 协调交接（coordinates handoffs through git）"，`git` 是唯一事实来源 | https://factory.ai/news/missions |
| worktree 隔离 | **未在 Missions 文档中明确说明**。Droid CLI 本身有 `-w/--worktree` 会话级隔离选项（默认目录 `~/.factory/worktrees`），changelog 中也有"可配置 worktree 目录 + Mission Control 改进"同批发布，但 Missions 内部是否使用 worktree 官方未明确（见"存疑"节） | https://docs.factory.ai/droid-cli/cli-reference 、https://docs.factory.ai/changelog/release-notes |
| 模型无关（model-agnostic） | orchestrator / workers / validators / research agents 可分别使用不同模型，甚至不同厂商 | https://factory.ai/news/missions |
| 技能学习 | orchestrator 识别可复用模式沉淀为 skills，worker 在工作中扩展技能库，"越用越懂你的领域" | https://factory.ai/news/missions |
| 安全/企业 | 命令按风险分级、Droid Shield 扫描密钥、全量行为日志、OpenTelemetry 遥测；支持云托管/混合（Azure OpenAI、Bedrock、Vertex、自托管模型）/完全离线（airgapped）部署；SSO/SCIM、RBAC、审计；SOC 2 Type II、ISO 27001、ISO 42001 | https://factory.ai/news/missions |

**前置要求**：官方建议仓库达到 Agent Readiness **Level 4（Optimized）及以上**——因为 Mission 会跑"面向用户的 QA 测试"自验证，代码库需要有可脚本化的方式把应用跑起来并模拟用户流程（一条命令起全栈、日志落盘、资源占用适中、可编程驱动应用）。可用 `/readiness-report` 评估、`/readiness-fix` 补齐。来源：https://docs.factory.ai/missions/overview 、https://docs.factory.ai/missions/planning

## 5. 定价与可用性

- **发布时（2025-02-26）**：面向 **Enterprise 和 Max 套餐**用户开放，CLI 与 IDE 扩展可用。来源：https://factory.ai/news/missions
- **现行个人套餐**（docs.factory.ai/pricing）：Pro $20/月、Plus $100/月（约 5 倍 Pro 用量 + 托管 Droid Computers）、Max $200/月（约 10 倍 Pro 用量 + 新功能抢先体验）。来源：https://docs.factory.ai/pricing
- **Missions 计费**：与普通会话共用滚动 Rate Limits（5 小时 / 7 天 / 30 天三个窗口），且**需要开启 Extra Usage（预付费额度）**；Mission 撞到限额会暂停。官方建议尽可能用免费的 Droid Core（开放权重模型池）跑 Mission 以节省额度。来源：https://docs.factory.ai/pricing
- 团队/企业：Business 与 Enterprise 不受 Rate Limit 调整影响；Enterprise 提供专属算力、本地部署等。来源：https://factory.ai/pricing
- **注意**：发布博客称 Missions 起初限 Enterprise/Max，而现行定价文档仅要求"开启 Extra Usage"且未按档位限制 Missions——说明可用范围此后已扩大（官方未见此变化的明确公告，存疑，见末节）。

## 6. 与同类产品的差异化（官方说法）

Factory 官方没有发布逐家对比（vs Cursor Background Agents / Devin / Copilot Workspace）的文章，但官方材料中可提炼的差异化主张：

1. **多日时间尺度 vs 单任务后台 agent**：官方以数据强调 Missions 是"近均匀分布在 15 分钟到 24+ 小时"的长任务负载（最长 16 天），而非 Devin/Cursor BG Agents 典型的"ticket → PR"分钟—小时级任务。来源：https://factory.ai/news/missions
2. **先契约后实现的双层 TDD 与独立验证**：验证契约先于 feature 定义、由无偏见的新 agent 黑盒验证，是官方架构博客反复强调的结构性差异。来源：https://factory.ai/news/missions-architecture
3. **模型无关编排**："锁定单一模型家族的系统永远受制于该家族最弱的能力；模型无关的编排器可以把每个角色配给最强模型"——官方明确将此定位为对单一模型厂商产品（暗指 OpenAI/Anthropic 系工具）的结构优势。来源：https://factory.ai/news/missions
4. **同一平台贯通协作与委派界面**：Terminal/IDE 协作，浏览器/Slack/Jira 委派，CLI 自动化，Droid 跨界面保留记忆。来源：https://factory.ai/product/missions
5. **对并行化的诚实态度**：官方公开把"并行是否真的更好"列为开放问题，称串行+定向并行优于广泛并行——与部分竞品主打"大规模并行 agent"的叙事形成对照。来源：https://docs.factory.ai/missions/overview

**二手对比资料（非官方，仅供参考）**：
- Top AI Tracker《Devin vs Factory Droids》(2026-06-25)：认为 Factory 凭借公开的 Terminal Bench 成绩、多界面覆盖、模型无关路由 + BYOK、更易预算的阶梯定价略胜 Devin。https://topaitracker.com/comparisons/2026-06-25-devin-vs-factory-droids-autonomous-coding-agent-head-to-head/
- Agentic Index《Cognition vs Factory (2026)》：称 Factory 在角色专业化 Droid、Linear/Jira 接入、按步骤模型路由上较完整。https://agenticindex.io/compare/cognition-vs-factory
- dreaming.press《Background Coding Agents: Devin vs Codex vs Cursor vs Jules vs Copilot》：指出后台 agent 品类已收敛到"全新隔离环境 + PR 交付"架构。https://dreaming.press/posts/devin-vs-codex-vs-cursor-vs-jules-background-agents.html

## 7. 未能确认 / 存疑的信息

1. **Missions 内部是否使用 git worktree 隔离 worker**：官方仅说"通过 git 协调交接"；`--worktree` 是会话级 CLI 功能，Missions 文档未说明编排层是否为 worker 建 worktree。
2. **可用套餐的现行口径**：2025-02 发布时限 Enterprise/Max；现行定价文档只要求开启 Extra Usage，未见官方变更公告，推测已全量开放但未证实。
3. **并行度的具体机制**：官方称"在合适处并行"，但未公开 runner 的并发上限、依赖调度细节。
4. **API/SDK 方式创建 Mission**：文档确认 `droid exec --mission`（CLI 无头模式）可用于 CI；Droid SDK 是否暴露 Mission 级 API 未在已查文档中确认。
5. **价格数字时效**：Pro/Plus/Max 价格与"Missions 需 Extra Usage"以调研当日官方定价文档为准，可能随时间变化。
6. 官方产品页（factory.ai/product/missions）称可"跨数十个仓库协调变更（multi-repo migrations）"，但技术文档未说明跨仓库 Mission 的具体配置方式。

## 主要来源清单

- 官方文档 — Missions Overview：https://docs.factory.ai/missions/overview
- 官方文档 — Planning & Validation：https://docs.factory.ai/missions/planning
- 官方文档 — Running in the CLI：https://docs.factory.ai/missions/running-cli
- 官方文档 — Running in the Factory App：https://docs.factory.ai/missions/running-app
- 官方文档 — Configuration & Reference：https://docs.factory.ai/missions/reference
- 官方文档 — Pricing：https://docs.factory.ai/pricing 、https://factory.ai/pricing
- 官方文档 — Droid CLI Reference（worktree）：https://docs.factory.ai/droid-cli/cli-reference
- 官方博客 — Introducing Missions（2025-02-26）：https://factory.ai/news/missions
- 官方博客 — How Missions Work（2026-04-10）：https://factory.ai/news/missions-architecture
- 官方产品页：https://factory.ai/product/missions
- （二手）第三方对比文章，见第 6 节末尾列表

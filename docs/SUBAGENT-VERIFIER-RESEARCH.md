# Verifier 改用 sub-agent 的可行性调研

> 调研基线：`@earendil-works/pi-coding-agent@0.84.4`，2026-09-01。
>
> **状态:已实施。** 子进程 Verifier 已删除,现行为进程内 SDK `AgentSession`
> (`src/roles/verifier.ts`),只读工具白名单 + 结构化 `mission_verdict`,
> 旧文本协议与 `verifier-tools.ts` 模板一并移除。下文保留作决策依据。

## 结论

**可行，但不应直接接入 pi 官方 `subagent` 示例。**

推荐只把当前语义 Verifier 从 `pi.exec("pi", ...)` 改为 **进程内 SDK
`AgentSession`**。hard 验证脚本继续由 L0 直接执行，不能改成由 LLM agent
执行或解释。

目标形态：

```text
Runtime.runCheck()
  ├─ hard branches ── pi.exec(verify.sh) ── Evidence(level=hard)
  └─ semantic verifier
       └─ createAgentSession()             ── Evidence(level=semi)
            tools: read/grep/find/ls/mission_verdict
            session: in-memory
            resources: no extensions/skills/prompts/context
```

这条路径能去掉：

- 第二个 `pi` CLI 的启动与资源初始化；
- JSONL stdout/stderr 管道；
- `MISSION_VERDICT::<base64>` 文本协议；
- `verifier-tools.ts` 子进程扩展脚手架。

但它不会消除模型推理耗时，而且会把故障隔离从“进程级”降低为“会话级”。

## “sub-agent”需要先区分三种含义

### 1. Factory Droid 的 Task/subagent

这是开发 Droid 的编排能力，不属于 pi 扩展运行时 API。`pi-missions`
不能在用户的 pi 进程内调用本次开发会话中的 `Task` 工具。

### 2. pi 官方 subagent 示例

pi 核心默认不内置 sub-agent 调度。官方 README 明确说明 pi 跳过了
sub agents 等功能，由扩展或第三方包实现：

- `node_modules/@earendil-works/pi-coding-agent/README.md:15-19`

官方示例虽然名为 subagent，但每个 agent 仍是一个独立 `pi` 进程：

- `examples/extensions/subagent/README.md` 的 Features 和 Security Model；
- `examples/extensions/subagent/index.ts:270-444` 使用
  `node:child_process.spawn()`，再解析 JSON mode 事件；
- 同一示例通过 `AbortSignal` 向子进程发送 SIGTERM/SIGKILL，并自行汇总
  usage 和输出。

因此，把当前 `pi.exec` 换成该 subagent 示例，能获得更丰富的工具卡片和流式
展示，但**不能解决子进程启动、stdout 协议和进程管理问题**。

另外，`subagent` 是一个给主 LLM 调用的注册工具。pi 的 Extension API 可以
`registerTool()` 和查询工具，但没有“从另一个扩展直接调用已注册工具”的公开入口：

- `dist/core/extensions/types.d.ts:941-999`

让主 LLM 再决定是否调用 verifier subagent，会把 CHECK 调度权从 L0
转交给 LLM，违反本项目“L0 是唯一裁判”的约束。

### 3. pi SDK 的进程内 AgentSession

这是适合当前需求的实现。

pi 官方 RPC 文档明确建议 Node.js/TypeScript 集成直接使用 `AgentSession`，
而不是启动 subprocess：

- `docs/rpc.md:1-5`

公开 SDK 提供：

- `createAgentSession()`：创建独立 agent 会话；
- `SessionManager.inMemory()`：不产生 verifier 会话文件；
- `tools`：只启用指定工具；
- `customTools`：直接注入结构化 `mission_verdict`；
- `subscribe()`：接收文本、工具调用、结束、usage 等事件；
- `prompt()`：运行 verifier；
- `abort()` 与 `dispose()`：超时取消和资源回收。

来源：

- `docs/sdk.md:44-114`
- `docs/sdk.md:560-610`
- `docs/sdk.md:960-1020`
- `dist/core/sdk.d.ts:1-105`
- `dist/core/agent-session.d.ts:281-364,445-450`

## 对现有不变量的影响

| 不变量/能力 | SDK AgentSession | 说明 |
|---|---|---|
| L0 唯一推进状态 | 保持 | Runtime 仍主动启动 verifier，并把 semi evidence 交给 `judge()` |
| Verifier 独立上下文 | 保持 | 使用新的 in-memory `AgentSession`，不注入 DO 会话历史 |
| Verifier 不写实现 | 可加强 | 不给 edit/write；建议连原生 bash 也不给 |
| 结构化 verdict | 改善 | custom tool 直接捕获 typed payload，无 base64/stdout 解析 |
| 实时进度 | 改善 | `session.subscribe()` 可直接更新 CHECK.json/widget |
| 超时/取消 | 可保持 | 定时触发 `await session.abort()`，finally 中 `dispose()` |
| verifier 崩溃隔离 | 变弱 | 同进程 SDK 异常可能影响宿主，必须全边界 catch |
| pi 进程退出后的恢复 | 不变 | AgentSession 仍是瞬时工作；CHECK 重启后回 DO |
| 模型与认证 | 可保持 | 显式选择 configured verifier model，未配置时使用当前模型 |

## 工具安全：不要直接开放原生 bash

当前子进程通过 `verifier-tools.ts` 隐藏 edit/write，但开放的 bash 仍能写文件。
“没有写工具”等于只做 UI 级约束，不是能力级只读。

SDK 迁移时建议语义 Verifier 只开放：

```text
read, grep, find, ls, mission_verdict
```

hard 测试、构建和其他命令已经由 Runtime 执行并作为输入交给 Verifier。语义核验
主要检查 diff、实现与 AC 是否一致，不需要再次拥有任意 shell。

如果确实需要额外抽查命令，应提供白名单 custom tool，而不是原生 bash。例如仅允许
调用冻结的 `verify.sh <known-branch>`，并拒绝重定向、管道和任意参数。

## 方案比较

| 方案 | 子进程 | 隔离 | 实时事件 | L0 可直接调用 | 建议 |
|---|---:|---|---|---:|---|
| 保持 `pi.exec("pi")` | 是 | 进程级 | 需解析 JSON/stdout | 是 | 作为回滚路径 |
| 官方 subagent 示例 | 是 | 进程级 | 好 | 否 | 不采用 |
| pi RPC client | 是 | 进程级 | 好 | 是 | 没有解决核心问题 |
| SDK `AgentSession` | 否 | 会话级 | 好 | 是 | **推荐 PoC** |
| 主会话调用 subagent tool | 通常是 | 独立上下文 | 好 | 否 | 违反 L0 调度约束 |

## 推荐 PoC

### 范围

只替换 `src/roles/verifier.ts` 的执行内核，不改：

- hard branch 执行；
- `Evidence`/`judge()`；
- CHECK 状态机；
- PASS/FAIL/INCONCLUSIVE 的 L0 规则。

保留配置开关：

```json
{
  "verifierBackend": "subprocess"
}
```

PoC 增加 `"sdk"`，默认暂不切换。验证达标后再将默认值改为 `"sdk"`。

### 实现步骤

1. 提取 `VerifierBackend` 接口，保持现有 `VerifierRunResult`。
2. 新建 `runSdkVerifier()`：
   - 构造无扩展、无 skill、无 prompt、无 context file 的 `ResourceLoader`；
   - 使用 `SettingsManager.inMemory()` 和 `SessionManager.inMemory(cwd)`；
   - 显式传入 verifier model、thinking 和 tool allowlist；
   - 用 custom `mission_verdict` tool 捕获并校验 verdict 数组；
   - 订阅 agent/tool/usage 事件，转换为 CHECK 进度；
   - timeout 时 `abort()`，finally 中 unsubscribe + `dispose()`。
3. 保留 `runSubprocessVerifier()` 作为 feature flag 回滚。
4. 删除子进程协议前，先跑双后端契约测试，确保输出等价。

### 必测场景

- verdict 正常提交；
- agent 正常结束但未调用 verdict；
- typed payload 非法；
- 模型/认证不可用；
- tool 执行失败；
- timeout 与人工 abort；
- Runtime 已切换 mission 时旧 verifier 不污染新状态；
- `dispose()` 后无 listener/timer；
- verifier 只能看到允许的工具；
- verifier 不能修改工作区；
- usage、工具调用和阶段能实时更新 UI。

### 验收指标

先在同一仓库、同一模型、同一 brief 上各运行至少 20 次：

| 指标 | 目标 |
|---|---|
| 启动到首个 agent event | SDK P50 明显低于 subprocess |
| 总耗时 | 不劣于 subprocess；模型推理占主导时允许差异较小 |
| verdict 解析失败率 | 0 |
| 超时后遗留进程/会话/计时器 | 0 |
| 工作区写入 | 0 |
| evidence 语义一致率 | 100% |
| CHECK 期间 slash command 响应 | 不受阻塞 |

不要预设“进程内一定快很多”。SDK 能确定消除 CLI、资源扫描和 JSONL
序列化的固定成本，但总耗时仍主要取决于模型首 token 和工具调用。

## 风险与缓解

### SDK 与宿主版本耦合

`AgentSession` 是公开 SDK，但本项目 peer dependency 目前是 `"*"`。实现会依赖
0.84.4 的事件和创建参数。应增加最低兼容版本或启动时能力检测，并保留 subprocess
回滚。

### 同进程故障传播

创建、事件回调、custom tool、abort、dispose 全部要有独立 try/catch。事件回调不能
直接推进 mission，只能更新临时进度。最终状态仍只由 `runCheck()` 消费
`VerifierRunResult` 后推进。

### 资源递归加载

不能使用默认 `DefaultResourceLoader` 发现路径，否则可能再次加载
`pi-missions`。应使用显式空 ResourceLoader，或至少配置：

```text
noExtensions, noSkills, noPromptTemplates, noThemes, noContextFiles
```

并覆盖 system prompt，只保留 verifier 规则。

### 模型选择和认证差异

SDK 要显式复刻当前 CLI 的模型选择：

- 配置了 `provider/model`：从 `ModelRuntime` 精确解析；
- 未配置：继承当前 session model 与 thinking；
- 模型不存在或认证不可用：返回 `failed`，由 Runtime 降级 hard-only。

## 最终建议

**Go：做一个受 feature flag 保护的 SDK AgentSession PoC。**

**No-Go：不要把 hard scripts agent 化，也不要让主 LLM 调用通用 subagent
工具来决定 CHECK。**

迁移成功后的准确命名建议是“进程内 Verifier Agent”，而不是声称接入了 pi
原生 sub-agent。pi 0.84.4 没有原生 sub-agent 调度器；这里使用的是公开 SDK
创建的独立 AgentSession。

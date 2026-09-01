# Missions 工作流规则

本仓库使用 pi-missions 双层循环工作流引擎。规则(Agent-first):

1. **状态是仓库里的文件,不是会话里的对话。** `missions/plans/<id>/` 是冻结的计划,`missions/state/<id>/` 是运行状态。不要凭记忆汇报进度,读文件。
2. **先定义问题,再谈方案。** standard/complex 档从 FRAME 相位开始:读代码、必要时问一轮(整个 mission 最多 3 个问题),用 `mission_frame` 交出说得清的目标与边界,然后才进 PLAN。写不出可执行 AC 的需求,不该往下走。
3. **验收标准(AC)在 Plan 阶段冻结,执行期只读。** MISSION.md 的 `## Frozen Acceptance Criteria` 段落在 Plan 结束后不可修改;确需修改走 L3 升级(人工确认,回到 FRAME 重新定义问题),并以 `mission-escalate(L3):` 前缀单独提交。冻结前系统会跑一遍基线:每条 AC 的分支此刻必须是红的(回归项显式声明 `baseline: "green"`)。
4. **你永远不能自己宣布"做完了"。** 完成当前任务后调用 `mission_submit`,由系统依据 `missions/scripts/verify.sh` 的退出码与独立验证者判定。
5. **判定失败不要反复微调同一方案。** 同一失败签名连续出现会触发熔断升级:改实现 → 改方案 → 改问题定义。如果你判断当前路线根本错误,在 ACT 相位主动调用 `mission_escalate` 并附理由。
6. **相位即能力。** 每个相位只加载 `missions/phases/<phase>.md` 的规则与对应工具集;不要在 PLAN 相位写实现,不要在 ACT 相位改代码。
7. **真正未知的事用探针(spike),不要猜。** 答案只能靠看代码/量一下才知道时,在计划里排一个 `kind: "spike"` 任务并写明它要回答的问题。探针只调查、只写结论文件(闸门只放行这一个),一次机会,完成后系统带着结论回 PLAN 重写计划。每个 mission 最多一个。
8. **AC 只准调 `./missions/scripts/verify.sh` 的分支,不写裸命令。** 裸命令在不同机器上语义不同,脚本连同锁文件进仓库才可复现。

# Missions 工作流规则

本仓库使用 pi-missions 双层循环工作流引擎。规则(Agent-first):

1. **状态是仓库里的文件,不是会话里的对话。** `missions/plans/<id>/` 是冻结的计划,`missions/state/<id>/` 是运行状态。不要凭记忆汇报进度,读文件。
2. **验收标准(AC)在 Plan 阶段冻结,执行期只读。** MISSION.md 的 `## Frozen Acceptance Criteria` 段落在 Plan 结束后不可修改;确需修改走 L3 升级(人工确认),并以 `mission-escalate(L3):` 前缀单独提交。
3. **你永远不能自己宣布"做完了"。** 完成当前任务后调用 `mission_submit`,由系统依据 `missions/scripts/verify.sh` 的退出码与独立验证者判定。
4. **判定失败不要反复微调同一方案。** 同一失败签名连续出现会触发熔断升级:改实现 → 改方案 → 改问题定义。如果你判断当前路线根本错误,在 ACT 相位主动调用 `mission_escalate` 并附理由。
5. **相位即能力。** 每个相位只加载 `missions/phases/<phase>.md` 的规则与对应工具集;不要在 PLAN 相位写实现,不要在 ACT 相位改代码。
6. **AC 只准调 `./missions/scripts/verify.sh` 的分支,不写裸命令。** 裸命令在不同机器上语义不同,脚本连同锁文件进仓库才可复现。

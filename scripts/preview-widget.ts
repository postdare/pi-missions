/**
 * widget 离线预览:不起 pi,直接把常驻状态卡渲染到 stdout。
 * 这是唯一没有真机交互的渲染路径,改 dashboard.ts 的 renderWidgetCard 后先看这里。
 *
 * 用法:
 *   node --experimental-strip-types scripts/preview-widget.ts            # 120 列,执行中
 *   COLUMNS=56 node --experimental-strip-types scripts/preview-widget.ts  # 窄终端
 *   node --experimental-strip-types scripts/preview-widget.ts check      # 判定相位
 *   node --experimental-strip-types scripts/preview-widget.ts warn       # 熔断临界 + 换脑挂起
 */
import { renderWidgetCard } from "../src/ui/dashboard.ts";
import { initialState } from "../src/core/machine.ts";
import type { CheckState } from "../src/store/check.ts";
import type { MissionPlan } from "../src/store/mission.ts";

const theme = {
	fg: (_c: string, s: string) => `\x1b[90m${s}\x1b[0m`,
	bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

const width = Number(process.env.COLUMNS) || 120;
const mode = process.argv[2] ?? "do";

const plan: MissionPlan = {
	missionId: "2026-09-03-mission-mtl9aicc",
	tier: "standard",
	goal: "把登录鉴权整体迁移到 JWT,包括刷新令牌轮换、多设备踢下线与审计日志落盘",
	acceptanceCriteria: [],
	milestones: [
		{
			id: "M1",
			title: "m",
			tasks: [
				{ id: "T1", title: "引入 JwtProvider 与密钥轮换", verify: ["compile"] },
				{
					id: "T2",
					title: "FirstScreen 双屏轨道:ScreenLayout 与 HomeLinkList 的分组拖拽坐标体系迁移",
					verify: ["auth-integration"],
				},
			],
		},
	],
	verifyScript: "#!/usr/bin/env bash\n",
	createdAt: Date.now() - 52 * 60_000,
};

const s = initialState({ missionId: plan.missionId, tier: "standard", taskOrder: ["T1", "T2"] });
s.phase = "do";
s.currentTask = "T2";
s.tasks.T1 = { ...s.tasks.T1, status: "done", attempts: 1 };
s.tasks.T2 = { ...s.tasks.T2, status: "running", attempts: 1 };
s.cost = { executor: 0.98, verifier: 0.15 };

let check: CheckState | null = null;
if (mode === "check") {
	s.phase = "check";
	s.tasks.T2 = { ...s.tasks.T2, status: "running", attempts: 2 };
	check = {
		taskId: "T2",
		attempt: 2,
		startedAt: Date.now() - 12_000,
		updatedAt: Date.now(),
		stage: "running_scripts",
		currentBranch: "auth-integration",
		completedBranches: [{ acId: "lint", status: "pass", exitCode: 0, durationMs: 800 }],
		verifier: { status: "pending" },
	};
}
if (mode === "warn") {
	s.tasks.T2 = {
		...s.tasks.T2,
		status: "running",
		attempts: 2,
		sameSignatureCount: 2,
		lastFailureReason: "AuthIntegrationTest#refreshToken 断言失败",
	};
	s.pendingHandoff = "executor 模型连续同签名失败,建议 escalate L2";
}

const lines = renderWidgetCard(theme, plan, s, Date.now(), width, check);
console.log(`── width=${width} mode=${mode} ──`);
console.log(lines.join("\n"));

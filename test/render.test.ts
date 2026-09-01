/**
 * pi-missions · 整页渲染的宽度不变式
 *
 * chrome.test.ts 测的是单个积木,这里测拼起来的整页。历史上炸 TUI 的都不是积木
 * 本身,而是拼装时差一列(盒顶右上角对不齐)、或某条内容行忘了截断。
 *
 * 不变式:
 *   ① 盒行(以 │/╭/╰/├ 开头的行)可见宽度**恰好** = width;
 *   ② 盒外提示条 ≤ width;
 *   ③ 任意页 / 任意宽度 / 任意选中态都成立,包括中文、长文本、空数据。
 *
 * 主题用真 ANSI:visibleWidth 会忽略转义序列,用可见字符模拟颜色会污染断言。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { initialState } from "../src/core/machine.ts";
import type { ScannedMission } from "../src/store/evidence.ts";
import type { MissionPlan } from "../src/store/mission.ts";
import { renderPanel } from "../src/ui/panel.ts";
import { renderStatus } from "../src/ui/status-view.ts";
import type { ModelsPageData } from "../src/ui/models-page.ts";

const theme = {
	fg: (_c: string, s: string) => `\x1b[31m${s}\x1b[0m`,
	bg: (_c: string, s: string) => `\x1b[44m${s}\x1b[49m`,
	bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

const WIDTHS = [40, 56, 64, 80, 96, 120, 200];
const NOW = 1_756_737_000_000;

function mission(id: string, goal: string, phase: string, tier: string, total: number, done: number): ScannedMission {
	const taskOrder = Array.from({ length: total }, (_, i) => `T${i + 1}`);
	const s = initialState({ missionId: id, tier: tier as never, taskOrder });
	s.phase = phase as never;
	s.currentTask = taskOrder[done] ?? null;
	for (const [i, tid] of taskOrder.entries()) {
		s.tasks[tid] = { ...s.tasks[tid], status: i < done ? "done" : i === done ? "running" : "pending", attempts: 2 };
	}
	if (s.currentTask) {
		s.tasks[s.currentTask] = {
			...s.tasks[s.currentTask],
			sameSignatureCount: 2,
			lastSignature: "9f2c1a4b7e30",
			lastFailureReason: "AuthIntegrationTest#refreshToken 断言失败,期望 200 实际 401",
		};
	}
	s.updatedAt = NOW - 3 * 60_000;
	s.cost = { planner: 0.41, executor: 1.2, verifier: 0.09 };
	s.pendingHandoff = phase === "act" ? "escalate L2 on T2" : null;
	s.escalation = { level: 2, history: [{ from: 1, to: 2, taskId: "T2", reason: "同一失败签名 ×3,序列化边界没对齐", at: NOW }] };
	const plan: MissionPlan = {
		missionId: id,
		tier: tier as never,
		goal,
		acceptanceCriteria: [
			{ id: "AC1", text: "登录链路集成测试全绿", verify: "auth-integration" },
			{ id: "AC2", text: "对外接口契约快照不变", verify: "contract-snapshot", baseline: "green" },
		],
		milestones: [
			{
				id: "M1",
				title: "鉴权切换",
				tasks: taskOrder.map((tid) => ({ id: tid, title: `任务 ${tid} 的标题可能很长很长很长`, verify: ["auth-integration"] })),
			},
		],
		verifyScript: "",
		createdAt: NOW - 60 * 60_000,
	};
	return { missionId: id, state: s, plan, stateDir: `/tmp/${id}` };
}

const MISSIONS = [
	mission("m-20260901-1402", "把登录鉴权从 session 迁移到 JWT,顺带清掉旧的 cookie 分支", "do", "standard", 4, 1),
	mission("m-20260901-1120", "CMS 管理端 REST 接口重构", "act", "complex", 9, 6),
	mission("m-20260831-2210", "修掉 verify.sh 在 CI 上的路径假设", "done", "quick", 1, 1),
	mission("m-20260831-1730", "把证据归档换成按 attempt 分目录", "halted", "standard", 5, 2),
];

const MODELS: ModelsPageData = {
	config: {
		planner: { provider: "anthropic", model: "claude-opus-5", thinking: "high" },
		verifier: { provider: "openai", model: "一个并不存在的超长模型名字用来撑爆列宽" },
	},
	models: [
		{ provider: "anthropic", id: "claude-opus-5", name: "Opus 5" },
		{ provider: "anthropic", id: "claude-sonnet-5", name: "Sonnet 5" },
		{ provider: "google", id: "gemini-3-pro" },
	],
	sessionLabel: "anthropic/claude-opus-5",
	cost: { planner: 0.412, executor: 1.203 },
	activeRole: "executor",
	dirName: "missions",
};

/** 盒行必须恰好铺满;其它行(提示条)不许超宽 */
function assertWidths(lines: string[], width: number, label: string): void {
	for (const [i, line] of lines.entries()) {
		const w = visibleWidth(line);
		const stripped = line.replace(/\x1b\[[0-9;]*m/g, "");
		if (/^[│╭╰├]/.test(stripped)) {
			assert.equal(w, width, `${label} 第 ${i} 行盒宽应为 ${width},实际 ${w}: ${JSON.stringify(stripped)}`);
		} else {
			assert.ok(w <= width, `${label} 第 ${i} 行超宽(${w} > ${width}): ${JSON.stringify(stripped)}`);
		}
	}
}

const panelBase = {
	theme,
	rows: 30,
	now: NOW,
	missions: MISSIONS,
	filter: "",
	selected: 0,
	detail: false,
	tierIdx: 1,
	roleIdx: 0,
	listScroll: 0,
	picking: null,
	models: MODELS,
	logTail: ["14:18 T2 a=1 verdict=FAIL ev=hard(auth-integration exit=1) sig=9f2c1a4b7e30"],
	page: "missions" as const,
};

test("renderPanel:任务页在各宽度/各选中态下都恰好铺满盒宽", () => {
	for (const width of WIDTHS) {
		for (const selected of [0, 1, 2, 4]) {
			for (const detail of [false, true]) {
				const r = renderPanel({ ...panelBase, width, selected, detail });
				assertWidths(r.lines, Math.max(40, width), `任务页 w=${width} sel=${selected} detail=${detail}`);
			}
		}
	}
});

test("renderPanel:筛选/空结果/无 mission 也不撑破", () => {
	for (const width of WIDTHS) {
		assertWidths(renderPanel({ ...panelBase, width, filter: "重构" }).lines, Math.max(40, width), `筛选 w=${width}`);
		assertWidths(renderPanel({ ...panelBase, width, filter: "不存在的东西" }).lines, Math.max(40, width), `空结果 w=${width}`);
		assertWidths(renderPanel({ ...panelBase, width, missions: [] }).lines, Math.max(40, width), `无 mission w=${width}`);
	}
});

test("renderPanel:模型页(含超长模型名)与选择器子模式都不撑破", () => {
	for (const width of WIDTHS) {
		const mw = Math.max(40, width);
		assertWidths(renderPanel({ ...panelBase, width, page: "models", roleIdx: 2 }).lines, mw, `模型页 w=${width}`);
		assertWidths(
			renderPanel({ ...panelBase, width, page: "models", picking: { role: "verifier", cursor: 1, filter: "cla" } }).lines,
			mw,
			`选择器 w=${width}`,
		);
		assertWidths(renderPanel({ ...panelBase, width, page: "models", models: null }).lines, mw, `无 runtime w=${width}`);
	}
});

test("renderPanel:选中行铺了背景色,未选中的 mission 行没有", () => {
	const r = renderPanel({ ...panelBase, width: 96, selected: 1 });
	const painted = r.lines.filter((x) => x.includes("\x1b[44m"));
	// 页签药丸 + 选中行,正好两处
	assert.equal(painted.length, 2, `带背景的行应为 2(页签 + 选中行),实际 ${painted.length}`);
	assert.ok(
		painted.some((x) => x.includes("session")),
		"选中的第 1 个 mission 必须是带背景的那一行",
	);
	assert.ok(!painted.some((x) => x.includes("CMS")), "未选中的 mission 行不许带背景");
});

test("面板里不出现贴边框的竖线 —— 那会被读成边框裂了一道", () => {
	for (const page of ["missions", "models"] as const) {
		for (const line of renderPanel({ ...panelBase, width: 96, page, selected: 1 }).lines) {
			const stripped = line.replace(/\x1b\[[0-9;]*m/g, "");
			// 详情展开的引导线是有意为之(挂在行下方,不贴边框),这里只查前 3 列
			assert.ok(!/^.{0,2}[▎▍▌┃]/.test(stripped), `${page} 页仍有贴边竖线: ${JSON.stringify(stripped)}`);
		}
	}
});

test("renderStatus:双栏与窄屏单栏在各宽度/各焦点下都恰好铺满", () => {
	const d = {
		plan: MISSIONS[0].plan!,
		state: MISSIONS[0].state,
		evidence: {
			latest: {
				"auth-integration": {
					result: "fail" as const,
					level: "hard" as const,
					at: NOW,
					taskId: "T2",
					attempt: 2,
					rawTail: "AuthIntegrationTest#refreshToken FAILED\n  expected: 200 but was: 401",
				},
			},
		},
		logLines: ["14:02 PLAN_FROZEN ac=2 tasks=4", "14:18 T2 a=1 verdict=FAIL sig=9f2c1a4b7e30"],
		dirName: "missions",
	};
	for (const width of WIDTHS) {
		for (const focus of [0, 1, 2] as const) {
			const lines = renderStatus({
				theme,
				width,
				rows: 30,
				now: NOW,
				data: d,
				focus,
				scroll: [0, 0, 0],
				canResume: true,
			});
			assertWidths(lines, Math.max(56, width), `status w=${width} focus=${focus}`);
		}
	}
});

test("renderStatus:无活动 mission 时也铺满", () => {
	for (const width of WIDTHS) {
		const lines = renderStatus({ theme, width, rows: 24, now: NOW, data: null, focus: 0, scroll: [0, 0, 0], canResume: false });
		assertWidths(lines, Math.max(56, width), `空 status w=${width}`);
	}
});

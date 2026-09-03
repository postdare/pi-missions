/**
 * pi-missions · plan-review 样式快照
 *
 * render.test.ts 只卡"宽度不变式"——盒子不裂、行不越界。
 * 它卡不住的:**样式悄悄变了**(标签改字、间距改动、缩进挪位)。
 * 这个测试把当前渲染冻结成 golden file,观感变了就红;
 * 确认是想要的改动后,UPDATE_SNAPSHOTS=1 重新生成:
 *
 *   UPDATE_SNAPSHOTS=1 node --test test/plan-review.snapshot.test.ts
 *
 * 快照存的是剥离 ANSI 后的纯文本(避免依赖具体色值,主题调整不炸);
 * 宽度不变式仍由 render.test.ts 负责,这里只看版面观感。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderPlanReview, SECTION_IDS, type ReviewSection } from "../src/ui/plan-review.ts";
import { initialState } from "../src/core/machine.ts";
import type { MissionPlan } from "../src/store/mission.ts";
import type { MissionState } from "../src/core/types.ts";

const here = dirname(fileURLToPath(import.meta.url));
const SNAP = join(here, "__snapshots__", "plan-review.txt");
const UPDATE = process.env.UPDATE_SNAPSHOTS === "1";

const theme = {
	fg: (c: string, s: string) => `\x1b[90m${s}\x1b[0m`,
	bg: (_c: string, s: string) => s,
	bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

const plan: MissionPlan = {
	missionId: "demo",
	goal: "把登录页的会话过期处理改成静默续期,过期后用户无感知,不再弹登录框",
	tier: "standard",
	createdAt: "2026-02-14T10:00:00Z",
	definition: {
		goal: "同上",
		doneWhen: [
			{ id: "DW1", text: "access token 过期前 60s 内自动刷新,集成测试覆盖刷新竞态" },
			{ id: "DW2", text: "刷新失败时降级到登录页,且不丢当前路由的 query 参数" },
			{ id: "DW3", text: "这一行故意写得非常长,用来验证折行与悬挂缩进在窄终端下的表现是否正确——它应该被 wrap 而不是截断" },
		],
		constraints: ["不动 User 表", "沿用现有中间件顺序"],
		nonGoals: ["不做 refresh token 轮换", "不做多端登录互踢"],
		resolved: [{ q: "D1 用哪种方式?", a: "只放 sub+exp(推荐)" }],
	},
	approach: {
		summary: "拦截器统一续期;失败降级路由走 query 透传。",
		decisions: [
			{ id: "D1", text: "令牌里只放 sub+exp", why: "缩小爆炸半径", rejected: "建 token 表做服务端吊销", sticky: true },
		],
	},
	acceptanceCriteria: [
		{ id: "AC1", text: "登录链路集成测试全绿(含刷新竞态用例)", verify: "auth-integration", covers: ["DW1"] },
		{ id: "AC2", text: "对外接口契约快照不变", verify: "contract-snapshot", baseline: "green", covers: ["DW2"] },
	],
	milestones: [
		{ id: "M1", title: "拦截器续期", tasks: [{ id: "T1", title: "axios 拦截器 + 刷新竞态队列", verify: ["auth-integration"] }] },
	],
	verifyScript: '#!/usr/bin/env bash\nset -euo pipefail\ncase "$1" in\n  auth-integration) npm test -- test/auth ;;\n  contract-snapshot) npm run contract:check ;;\nesac\n',
};

function state(rejections: number): MissionState {
	const s = initialState({ missionId: "demo", tier: "standard", taskOrder: ["T1"] });
	s.phase = "plan" as never;
	if (rejections > 0) {
		s.planReview = { rejections, notes: ["AC2 根本不会红,换个能判别的写法"] };
	}
	return s;
}

function stripAnsi(s: string): string {
	return s.replace(/\x1b\[[0-9;]*m/g, "");
}

const CASES: Array<{ name: string; width: number; section: ReviewSection; scroll: number; readOnly?: boolean; rejections: number }> = [];

for (const width of [56, 96]) {
	for (const section of SECTION_IDS as ReviewSection[]) {
		CASES.push({ name: `${section} w=${width}`, width, section, scroll: 0, rejections: 1 });
	}
}
CASES.push({ name: "scope 只读(冻结后 /mission plan)", width: 96, section: "scope", scroll: 0, readOnly: true, rejections: 0 });
CASES.push({ name: "scope 无打回记录", width: 96, section: "scope", scroll: 0, rejections: 0 });
CASES.push({ name: "scope 滚动 3", width: 96, section: "scope", scroll: 3, rejections: 1 });

function renderCase(c: (typeof CASES)[number]): string {
	const r = renderPlanReview({
		theme,
		width: c.width,
		rows: 30,
		data: { plan, state: state(c.rejections) },
		section: c.section,
		scroll: c.scroll,
		readOnly: c.readOnly,
	});
	const header = `── ${c.name} ──`;
	return header + "\n" + r.lines.map(stripAnsi).join("\n");
}

test("plan-review:样式与快照一致", () => {
	const current = CASES.map(renderCase).join("\n\n") + "\n";
	if (UPDATE) {
		mkdirSync(dirname(SNAP), { recursive: true });
		writeFileSync(SNAP, current, "utf8");
		console.log(`快照已重生成: ${SNAP}(${CASES.length} 个用例)`);
		return;
	}
	const frozen = readFileSync(SNAP, "utf8");
	assert.equal(current, frozen, "plan-review 观感变了。若是想要的改动:UPDATE_SNAPSHOTS=1 node --test test/plan-review.snapshot.test.ts");
});

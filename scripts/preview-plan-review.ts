/**
 * plan-review 离线预览:不起 pi,直接把评审页渲染到 stdout。
 *
 * 用法:
 *   node --experimental-strip-types scripts/preview-plan-review.ts            # 默认 scope 段
 *   node --experimental-strip-types scripts/preview-plan-review.ts ac 0       # 第 3 段,滚动 0
 *   node --experimental-strip-types scripts/preview-plan-review.ts all        # 五段全部
 *   COLUMNS=70 node --experimental-strip-types scripts/preview-plan-review.ts # 模拟窄终端
 *
 * 宽度取 $COLUMNS(缺省 96),滚动可传第二个参数。
 * 颜色用真 ANSI,和真实 TUI 观感一致。
 */
import { renderPlanReview, SECTION_IDS, type ReviewSection } from "../src/ui/plan-review.ts";
import { initialState } from "../src/core/machine.ts";
import type { MissionPlan } from "../src/store/mission.ts";
import type { MissionState } from "../src/core/types.ts";

const theme = {
	fg: (c: string, s: string) => `\x1b[90m${s}\x1b[0m`, // muted 灰;想看强调色可换成 31/32 等
	bg: (_c: string, s: string) => s,
	bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

const width = Number(process.env.COLUMNS) || 96;
const rows = 30;

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

const args = process.argv.slice(2);
const sections = args[0] === "all" ? [...SECTION_IDS] : [args[0] && SECTION_IDS.includes(args[0] as ReviewSection) ? (args[0] as ReviewSection) : "scope"];
const scroll = Number(args[1]) || 0;

for (const section of sections) {
	const r = renderPlanReview({
		theme,
		width,
		rows,
		data: { plan, state: state(1) },
		section,
		scroll,
	});
	console.log(r.lines.join("\n"));
	if (sections.length > 1) console.log("");
}

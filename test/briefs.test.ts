/**
 * 简报的回归防线。
 *
 * 与 phase-prompts.test.ts 同一条思路,只是换了个注入口:相位提示词进系统提示,
 * 简报走 followUp / 换脑。两处犯的是同一类错 —— **指使模型去用它拿不到的东西**。
 *
 * 已经发生过的三次:
 *   · DO 的补证据简报让执行者调 `mission_escalate`,而 toolsForPhase("do") 里没有它
 *     (更刺的是 machine 的 ESCALATE handler 接受 do 相位 —— 这条逃生梯设计过,
 *      只是闸门从没把它露出来)。而无结论只回 DO 不进 ACT,这恰是最需要出口的时刻。
 *   · 换脑简报让 quick 去读 missions/README.md 与 phases/<phase>.md,而这一档
 *     不铺脚手架,两个文件都不存在。
 *   · 换脑简报让 quick 去读 LOG.md(已修,这里一并钉住)。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { renderActBrief, renderDoBrief, renderHandoffBrief, renderScoutEnvelope, renderStateCard } from "../src/briefs.ts";
import { toolsForPhase } from "../src/hooks/gate.ts";
import { initialState } from "../src/core/machine.ts";
import type { MissionState, Phase, Tier } from "../src/core/types.ts";
import type { MissionPlan } from "../src/store/mission.ts";

const AT = 1756600000000;

function planOf(tier: Tier, withAc: boolean): MissionPlan {
	return {
		missionId: "m1",
		tier,
		goal: "让登录快一点",
		acceptanceCriteria: withAc
			? [{ id: "AC1", text: "登录接口 p95 < 300ms", verify: "login-latency", covers: ["DW1"] }]
			: [],
		milestones: [{ id: "M1", title: "only", tasks: [{ id: "T1", title: "加缓存", verify: withAc ? ["login-latency"] : [] }] }],
		verifyScript: withAc ? "case \"$1\" in login-latency) exit 0 ;; esac" : "",
		createdAt: AT,
	};
}

function stateOf(tier: Tier, patch: Partial<MissionState> = {}): MissionState {
	const s = initialState({ missionId: "m1", tier, taskOrder: ["T1"] });
	return { ...s, phase: "do", currentTask: "T1", ...patch };
}

/** 简报里正面提到的 mission_* 工具 */
function toolsMentioned(text: string): string[] {
	const found: string[] = [];
	for (const line of text.split("\n")) {
		// 「不要 / 没有 / 别」句豁免:明说"这里没有某工具"是有用的信息
		if (/不要|没有|别去|别照着/.test(line)) continue;
		for (const [, tool] of line.matchAll(/(mission_[a-z_]+)/g)) found.push(tool);
	}
	return found;
}

test("DO 简报只提 DO 相位拿得到的工具 —— 补证据那条曾经指路 mission_escalate", () => {
	const plan = planOf("standard", true);
	const allowed = new Set(toolsForPhase("do", "standard"));

	const awaiting = stateOf("standard", {
		tasks: {
			T1: {
				...initialState({ missionId: "m1", tier: "standard", taskOrder: ["T1"] }).tasks.T1,
				awaitingEvidence: { reason: "缺少机械断言", acIds: ["login-latency"], treeFp: "sha256:aaa" },
			},
		},
	});
	for (const brief of [renderDoBrief(plan, stateOf("standard")), renderDoBrief(plan, awaiting)]) {
		for (const tool of toolsMentioned(brief)) {
			assert.ok(allowed.has(tool), `DO 简报提到 ${tool},但 toolsForPhase("do") 里没有它`);
		}
	}

	// 无结论的处置必须说清楚:它不是失败,但也不能靠原样重交熬过去
	const text = renderDoBrief(plan, awaiting);
	assert.ok(/无结论/.test(text));
	assert.ok(/原样重交|没有实际改动/.test(text), "要说清原样重交会被拦");
});

test("ACT 简报只提 ACT 相位拿得到的工具,且按档位分 —— quick 没有 mission_escalate", () => {
	for (const tier of ["standard", "complex", "quick"] as const) {
		const allowed = new Set(toolsForPhase("act", tier));
		const brief = renderActBrief(planOf(tier, tier !== "quick"), stateOf(tier, { phase: "act" }));
		for (const tool of toolsMentioned(brief)) {
			assert.ok(allowed.has(tool), `${tier} 档的 ACT 简报提到 ${tool},但闸门里没有它`);
		}
	}
});

test("quick 的换脑简报不指向任何不存在的文件 —— 这一档不铺脚手架", () => {
	const brief = renderHandoffBrief(
		planOf("quick", false),
		stateOf("quick", { phase: "plan" }),
		"missions",
		0,
		{ judge: "ai", text: "登录页不再出现重复请求" },
		true, // inMemory
	);
	// 与 toolsMentioned 同一条豁免:明说"没有 phases/,别去找"是有用的信息,
	// 被禁的是把它当成可读文件去**指路**。
	const directives = brief.split("\n").filter((l) => !/不要|没有|别去|别照着|不铺/.test(l));
	for (const path of ["missions/README.md", "phases/", "LOG.md", "missions/state"]) {
		assert.ok(!directives.some((l) => l.includes(path)), `quick 不落盘,简报不该指向 ${path}`);
	}
	assert.ok(/系统提示/.test(brief), "要告诉它规则在哪儿,而不是只说'别去找'");
});

test("落盘的 mission 照旧指路脚手架 —— 拦的是 quick,不是这条指引", () => {
	const brief = renderHandoffBrief(planOf("standard", true), stateOf("standard", { phase: "plan" }), "missions", 1);
	assert.ok(brief.includes("missions/README.md"));
	assert.ok(brief.includes("missions/phases/plan.md"));
	assert.ok(brief.includes("LOG.md"), "standard 有 LOG.md,重规划要读它");
});

test("State Card 在每个相位都只提该相位拿得到的工具", () => {
	const cases: Array<{ tier: Tier; phase: Phase; withAc: boolean }> = [
		{ tier: "standard", phase: "define", withAc: false },
		{ tier: "standard", phase: "plan", withAc: false },
		{ tier: "standard", phase: "do", withAc: true },
		{ tier: "quick", phase: "plan", withAc: false },
		{ tier: "quick", phase: "do", withAc: false },
	];
	for (const { tier, phase, withAc } of cases) {
		const card = renderStateCard(planOf(tier, withAc), stateOf(tier, { phase }), "missions", 1);
		for (const tool of toolsMentioned(card)) {
			assert.ok(
				toolsForPhase(phase, tier).includes(tool),
				`${tier}/${phase} 的 State Card 提到 ${tool},但闸门里没有它`,
			);
		}
	}
});

// ─────────────────────────── 侦查扇出(scout) ───────────────────────────

const finding = (over: Partial<import("../src/core/scout.ts").ScoutFinding> = {}) => ({
	id: "S1",
	question: "旧 ORM 的私有 API 用在几处?",
	assume: "3 处左右",
	answer: "11 处,集中在 src/repo 下的 4 个文件",
	status: "answered" as const,
	citations: ["src/repo/user.ts:88"],
	surprised: true,
	...over,
});

test("State Card:查明与未查明分开印,未查明的那条明说它不是事实", () => {
	// 混在一起印的话,planner 会把自己的假设当成核实过的事实写进 AC ——
	// 那正是 scout 想消除的东西,而且伪装得更好
	const card = renderStateCard(
		planOf("standard", false),
		stateOf("standard", {
			phase: "plan",
			currentTask: null,
			scoutRounds: 1,
			scoutFindings: [
				finding(),
				finding({ id: "S2", status: "unanswered", answer: "未查明(超时)。沿用假设:有现成集成测试", citations: [], surprised: false }),
			],
		}),
	);
	assert.match(card, /已查明 S1\(与假设有出入\)/);
	assert.match(card, /出处:src\/repo\/user\.ts:88/);
	assert.match(card, /未查明 S2/);
	assert.match(card, /这不是事实,按风险项处理/);
	assert.match(card, /侦查轮次:已用 1\/1/);
});

// 这条断言原来是反的(没用过就不印额度行,理由写的是"空段是纯开销")。
// 那把额度行和结论段当成了一回事:结论段没扇出时确实空,额度行不空 ——
// 它就是"你有几路侦查"这条信息,而 planner 最需要它的那一刻正是还没用过的那一刻。
test("State Card:一路都没扇出时,额度行照印、结论段不印", () => {
	const card = renderStateCard(planOf("standard", false), stateOf("standard", { phase: "plan", currentTask: null }));
	assert.match(card, /侦查轮次:已用 0\/1/, "planner 得先知道自己有这个额度");
	assert.doesNotMatch(card, /已查明|未查明/, "结论段没内容就别占行");
});

test("State Card:侦查段只在 PLAN 出现 —— 计划冻结之后它再没有决策价值", () => {
	const card = renderStateCard(
		planOf("standard", true),
		stateOf("standard", { phase: "do", scoutRounds: 1, scoutFindings: [finding()] }),
	);
	assert.doesNotMatch(card, /已查明/);
});

test("信封:顶部点名哪几条与假设有出入 —— 顺着读最容易滑过的就是它们", () => {
	const env = renderScoutEnvelope(
		1,
		[finding(), finding({ id: "S2", surprised: false, answer: "确实是 3 处" })],
		{},
	);
	assert.match(env, /与你的假设有出入:S1/);
	assert.doesNotMatch(env, /与你的假设有出入:S1、S2/);
	assert.match(env, /不必转抄/, "落盘了就别让它再抄一遍,那是白烧 token");
});

test("信封:有未查明时必须警告别据它写 AC;全查明时不印这句废话", () => {
	const withMissing = renderScoutEnvelope(
		1,
		[finding({ id: "S2", status: "unanswered", answer: "未查明。沿用假设:x", citations: [], surprised: false })],
		{ S2: "超过 180s 或被中止" },
	);
	assert.match(withMissing, /别据它写 AC/);
	assert.match(withMissing, /超过 180s 或被中止/, "失败原因要带出来 —— 超时和模型报错的处置不同");

	assert.doesNotMatch(renderScoutEnvelope(1, [finding()], {}), /别据它写 AC/);
});

test("信封只提 PLAN 相位拿得到的工具", () => {
	const allowed = new Set(toolsForPhase("plan", "standard"));
	for (const tool of toolsMentioned(renderScoutEnvelope(1, [finding()], {}))) {
		assert.ok(allowed.has(tool), `信封提到了 PLAN 拿不到的 ${tool}`);
	}
});

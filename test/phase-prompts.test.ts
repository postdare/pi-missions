/**
 * 相位提示词的回归防线。
 *
 * 事故:提示词注入只看 phase 不看判定装置,于是 quick 在跑过 standard mission 的
 * 仓库里读到别人留下的 missions/phases/*.md —— PLAN 相位被指去调用
 * `mission_write_plan`(闸门里根本没有这个工具),DO 相位被指去跑不存在的
 * verify.sh。表现不是报错,是模型照着做然后交出一堆无关的自述。
 *
 * 这里卡两件事:选取规则(纯函数),以及**提示词不能指使闸门里没有的工具**。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { FALLBACK_PHASE_RULES, QUICK_PHASE_RULES, phasePromptFlavor, phasePromptFor } from "../src/phase-prompts.ts";
import { toolsForPhase } from "../src/hooks/gate.ts";
import type { Phase } from "../src/core/types.ts";

// ─────────────────────────── 选取规则 ───────────────────────────

test("quick 的 PLAN 用 quick 提示词,standard 的 PLAN 用 standard", () => {
	assert.equal(phasePromptFlavor({ tier: "quick", phase: "plan", frozenAcCount: 0 }), "quick");
	assert.equal(phasePromptFlavor({ tier: "standard", phase: "plan", frozenAcCount: 0 }), "standard");
	assert.equal(phasePromptFlavor({ tier: "complex", phase: "plan", frozenAcCount: 0 }), "standard");
});

test("PLAN 之外看有没有冻结的 AC,不看档位名 —— 软升档之后 tier 是 standard 但 verify.sh 仍不存在", () => {
	// evaluatePromotion 在 ACT 之后发 PROMOTE_TIER:只改 tier,相位与判据都不动。
	// 按档位选就会在这一刻切回 standard 提示词,又去指使它跑 verify.sh。
	assert.equal(phasePromptFlavor({ tier: "standard", phase: "do", frozenAcCount: 0 }), "quick");
	assert.equal(phasePromptFlavor({ tier: "standard", phase: "act", frozenAcCount: 0 }), "quick");
	assert.equal(phasePromptFlavor({ tier: "standard", phase: "do", frozenAcCount: 3 }), "standard");
});

test("熔断升档回 PLAN 写完真计划后,自然切回 standard 提示词", () => {
	assert.equal(phasePromptFlavor({ tier: "standard", phase: "do", frozenAcCount: 1 }), "standard");
	assert.equal(phasePromptFlavor({ tier: "standard", phase: "check", frozenAcCount: 1 }), "standard");
});

test("DEFINE 没有 quick 版本 —— quick 从不经过它,真被 L3 送进去也和 standard 一样", () => {
	assert.equal(phasePromptFlavor({ tier: "quick", phase: "define", frozenAcCount: 0 }), "standard");
	assert.equal(QUICK_PHASE_RULES.define, undefined);
});

// ─────────────────────────── 内容 ───────────────────────────

test("quick 的四个相位都有提示词", () => {
	for (const phase of ["plan", "do", "check", "act"]) {
		assert.ok((QUICK_PHASE_RULES[phase] ?? "").trim().length > 0, phase);
	}
});

/**
 * 这条是真正的防线:提示词里但凡**正面提到**一个 mission_* 工具,
 * 它就必须在该相位的工具集里。原来的事故就是 plan.md 让 quick 去调
 * `mission_write_plan`,而 toolsForPhase("plan", "quick") 里只有 mission_criterion。
 *
 * 「不要 / 没有 / 别」开头的否定句豁免 —— 明说"这里没有某工具"是有用的信息。
 */
test("提示词不指使闸门里没有的工具", () => {
	for (const [phase, text] of Object.entries(QUICK_PHASE_RULES)) {
		const allowed = new Set(toolsForPhase(phase as Phase, "quick"));
		for (const line of text.split("\n")) {
			if (/不要|没有|别去|别照着/.test(line)) continue;
			for (const [, tool] of line.matchAll(/`(mission_[a-z_]+)`/g)) {
				assert.ok(allowed.has(tool), `${phase} 相位的提示词提到 ${tool},但闸门里没有它`);
			}
		}
	}
});

test("quick 的 PLAN 说的是 mission_criterion,不是 mission_write_plan", () => {
	const plan = QUICK_PHASE_RULES.plan;
	assert.ok(plan.includes("mission_criterion"));
	assert.ok(/没有.*mission_write_plan/.test(plan), "要明说这一档没有 mission_write_plan");
	assert.ok(plan.includes("judge"), "judge 的三个取值直接决定谁来核对,必须写清");
});

test("quick 的 DO 不能让人去跑 verify.sh —— 只允许出现在「没有」句里", () => {
	for (const line of QUICK_PHASE_RULES.do.split("\n")) {
		if (!line.includes("verify.sh")) continue;
		assert.ok(/没有/.test(line), `DO 提示词里这行提到 verify.sh 却不是在否定它:${line}`);
	}
	assert.ok(QUICK_PHASE_RULES.do.includes("mission_submit"));
});

test("quick 的 ACT 说清没有 mission_escalate —— 这一档的 L2 落点是空的", () => {
	// 原来这里写的是"不要调用 mission_escalate …… 系统会拦",而系统当时并不拦
	// (toolsForPhase("act") 不分档、ESCALATE handler 也没有 tier 判据)。
	// 现在闸门与状态机双层封死了,提示词只需如实说"没有",不再声称任何拦截。
	assert.ok(!toolsForPhase("act", "quick").includes("mission_escalate"), "闸门必须先真的不发这个工具");
	assert.ok(/没有.*`mission_escalate`/.test(QUICK_PHASE_RULES.act), "要明说这一档没有它");
	assert.ok(!/LOG\.md/.test(QUICK_PHASE_RULES.act), "quick 不落盘,没有 LOG.md 可读");
});

test("quick 的 ACT 必须说对升档落点 —— 它是回 PLAN 重写计划,不是原地放宽阈值", () => {
	// promoteFromQuick():phase="plan" + PERSIST_PLAN + HANDOFF。
	// 旧文案写的是"判据不变、任务不变,变的是重试额度和熔断阈值放宽" ——
	// 那是这条路被修好之前的行为,而且恰好说反了:升档是把判定收严。
	const act = QUICK_PHASE_RULES.act;
	assert.ok(/回到? ?PLAN/.test(act), "要说清落点是 PLAN");
	assert.ok(!/阈值放宽|判据不变/.test(act), "不能再说成原地放宽阈值");
	assert.ok(/更严|收严/.test(act), "要说清判定是变严的,否则模型会把升档当成解脱");
});

// ─────────────────────── 选取 + 读盘(事故现场) ───────────────────────

/** 铺一个"跑过 standard mission 的仓库":phases/*.md 已经在那儿了 */
function poisonedRepo(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-missions-phases-"));
	fs.writeFileSync(path.join(dir, "plan.md"), "调用 `mission_write_plan` 一次性原子提交 MISSION.md + verify.sh 内容。");
	fs.writeFileSync(path.join(dir, "do.md"), "提交前自检:按 State Card 给出的路径跑一遍 `verify.sh <分支>` 看退出码。");
	fs.writeFileSync(path.join(dir, "act.md"), "读 State Card 里的 PREV FAILURE 和 LOG.md 里该任务的失败记录。");
	return dir;
}

test("quick 在跑过 standard 的仓库里不读那些 phases/*.md —— 这就是事故本身", () => {
	const phasesDir = poisonedRepo();

	const plan = phasePromptFor({ phasesDir, phase: "plan", tier: "quick", frozenAcCount: 0 });
	assert.ok(plan.includes("mission_criterion"), "quick 的 PLAN 该说 mission_criterion");
	assert.ok(
		!/调用 `mission_write_plan`/.test(plan),
		"读到了别的 mission 留下的 plan.md —— 它会让 quick 去调一个闸门里没有的工具",
	);

	const doPrompt = phasePromptFor({ phasesDir, phase: "do", tier: "quick", frozenAcCount: 0 });
	assert.ok(!/跑一遍 `verify\.sh/.test(doPrompt), "quick 没有 verify.sh,不能被指使去跑它");

	const act = phasePromptFor({ phasesDir, phase: "act", tier: "quick", frozenAcCount: 0 });
	assert.ok(!/LOG\.md/.test(act), "quick 不落盘,没有 LOG.md");

	fs.rmSync(phasesDir, { recursive: true, force: true });
});

test("standard 照旧读盘 —— 这套模板是给它写的,别一起改掉", () => {
	const phasesDir = poisonedRepo();
	const plan = phasePromptFor({ phasesDir, phase: "plan", tier: "standard", frozenAcCount: 0 });
	assert.ok(plan.includes("mission_write_plan"));
	const doPrompt = phasePromptFor({ phasesDir, phase: "do", tier: "standard", frozenAcCount: 2 });
	assert.ok(doPrompt.includes("verify.sh"));
	fs.rmSync(phasesDir, { recursive: true, force: true });
});

test("模板不存在时 standard 走兜底,quick 仍走内联 —— 干净仓库和脏仓库行为一致", () => {
	const missing = path.join(os.tmpdir(), "pi-missions-no-such-dir-xyz");
	assert.equal(
		phasePromptFor({ phasesDir: missing, phase: "do", tier: "standard", frozenAcCount: 1 }),
		FALLBACK_PHASE_RULES.do,
	);
	assert.equal(
		phasePromptFor({ phasesDir: missing, phase: "plan", tier: "quick", frozenAcCount: 0 }),
		QUICK_PHASE_RULES.plan,
	);
});

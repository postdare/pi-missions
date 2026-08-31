/**
 * Generates the pi-subagents workflowScript that executes a mission.
 *
 * The generated script is the deterministic mission runner:
 *   for each milestone:
 *     for each pending feature  → fresh-context `mission-worker` child (test-first, structured report)
 *     validation rounds (≤ maxRounds):
 *       `mission-scrutiny` + `mission-usertest` validators in parallel (structured verdict)
 *       on issues → `mission-fix-planner` child → bounded fix workers → re-validate
 *   any hard failure stops the mission and returns control (the report says where).
 *
 * Progress is checkpointed through the workflow's durable `state` global, so the
 * pi-missions extension can render live progress and regenerate the script for
 * resume after a crash (already-done features are excluded at generation time).
 *
 * Script constraints (enforced by pi-subagents): top-level await only, no nested
 * async helpers, no filesystem access — everything is inlined at generation time.
 */
import type { Mission } from "./ledger.ts";

export const WORKER_RESULT_SCHEMA = {
	type: "object",
	properties: {
		status: { type: "string", enum: ["done", "blocked"] },
		summary: { type: "string", description: "What was implemented and which tests prove it" },
		filesChanged: { type: "array", items: { type: "string" } },
		outOfScopeNotes: { type: "string", description: "Problems noticed but intentionally not fixed" },
	},
	required: ["status", "summary", "filesChanged"],
	additionalProperties: false,
} as const;

export const VERDICT_SCHEMA = {
	type: "object",
	properties: {
		verdict: { type: "string", enum: ["pass", "fail"] },
		summary: { type: "string" },
		issues: {
			type: "array",
			items: {
				type: "object",
				properties: {
					title: { type: "string" },
					detail: { type: "string", description: "Evidence: which assertion fails, where, and why" },
					assertion: { type: "string", description: "The contract assertion this issue violates, if any" },
				},
				required: ["title", "detail"],
				additionalProperties: false,
			},
		},
	},
	required: ["verdict", "summary", "issues"],
	additionalProperties: false,
} as const;

export const FIXPLAN_SCHEMA = {
	type: "object",
	properties: {
		rationale: { type: "string" },
		fixes: {
			type: "array",
			maxItems: 5,
			items: {
				type: "object",
				properties: {
					title: { type: "string" },
					spec: { type: "string", description: "Bounded, self-contained fix instructions for a worker" },
				},
				required: ["title", "spec"],
				additionalProperties: false,
			},
		},
	},
	required: ["rationale", "fixes"],
	additionalProperties: false,
} as const;

export interface RunnerPlan {
	missionId: string;
	title: string;
	objective: string;
	contractAssertions: string[];
	smokeCommands: string[];
	userTesting: boolean;
	maxRounds: number;
	milestones: Array<{
		id: string;
		title: string;
		features: Array<{
			id: string;
			title: string;
			spec: string;
			assertions: string[];
			done: boolean;
			outputPath: string;
		}>;
	}>;
}

export function buildRunnerPlan(
	mission: Mission,
	doneFeatureIds: ReadonlySet<string>,
	featureOutput: (featureId: string) => string,
): RunnerPlan {
	return {
		missionId: mission.id,
		title: mission.title,
		objective: mission.objective,
		contractAssertions: mission.contract.assertions,
		smokeCommands: mission.contract.smokeCommands,
		userTesting: mission.contract.userTesting,
		maxRounds: mission.maxValidationRounds,
		milestones: mission.milestones.map((ms) => ({
			id: ms.id,
			title: ms.title,
			features: ms.features.map((f) => ({
				id: f.id,
				title: f.title,
				spec: f.spec,
				assertions: f.assertions,
				done: doneFeatureIds.has(f.id),
				outputPath: featureOutput(f.id),
			})),
		})),
	};
}

/** True when every feature of every milestone is done — nothing left to run. */
export function planComplete(plan: RunnerPlan): boolean {
	return plan.milestones.every((ms) => ms.features.every((f) => f.done));
}

export function generateRunnerScript(plan: RunnerPlan): string {
	return `// pi-missions runner (generated) — mission ${plan.missionId}
const PLAN = ${JSON.stringify(plan)};
const WORKER_SCHEMA = ${JSON.stringify(WORKER_RESULT_SCHEMA)};
const VERDICT_SCHEMA = ${JSON.stringify(VERDICT_SCHEMA)};
const FIXPLAN_SCHEMA = ${JSON.stringify(FIXPLAN_SCHEMA)};
const MAX_FIXES_PER_ROUND = 5;

const report = { missionId: PLAN.missionId, features: {}, milestones: {}, stopped: null };

function jsonSafe(value) {
	return JSON.parse(JSON.stringify(value ?? null));
}

function contractSection() {
	const lines = ["# Validation contract (defines correctness — written before any implementation)"];
	for (let i = 0; i < PLAN.contractAssertions.length; i++) {
		lines.push((i + 1) + ". " + PLAN.contractAssertions[i]);
	}
	return lines.join("\\n");
}

function featureTask(ms, f) {
	const lines = [
		"You are implementing exactly one feature of a larger mission. Other workers implement the other features; independent validators decide correctness afterwards.",
		"",
		"# Mission objective",
		PLAN.objective,
		"",
		contractSection(),
		"",
	];
	if (f.assertions && f.assertions.length > 0) {
		lines.push("# Contract assertions this feature owns");
		for (const a of f.assertions) lines.push("- " + a);
		lines.push("");
	}
	lines.push(
		"# Your feature: " + f.id + " — " + f.title,
		"",
		f.spec,
		"",
		"# Rules",
		"- Work test-first: write or extend tests that prove your owned assertions, then implement until they pass.",
		"- Stay strictly scoped to this feature. Record out-of-scope problems in outOfScopeNotes instead of fixing them.",
		"- You may NOT declare the milestone or mission correct; that is the validators' job.",
		"- Report status done only when your tests actually pass (run them). Otherwise report blocked with a precise reason.",
	);
	return lines.join("\\n");
}

function scrutinyTask(ms) {
	const lines = [
		"Adversarially review the implementation of one mission milestone against its validation contract.",
		"",
		"# Mission objective",
		PLAN.objective,
		"",
		contractSection(),
		"",
		"# Milestone under review: " + ms.id + " — " + ms.title,
		"Features delivered in this milestone:",
	];
	for (const f of ms.features) lines.push("- " + f.id + ": " + f.title + " (worker report: " + f.outputPath + ")");
	lines.push(
		"",
		"# Rules",
		"- Judge the actual code in this repository, not the workers' claims. Workers cannot be trusted to grade themselves.",
		"- Check every contract assertion relevant to this milestone and cite concrete evidence (file, test, command output).",
		"- Run the project's test suite / type check via bash when available.",
		"- Do NOT modify any file. Review only.",
		"- verdict pass only if every relevant assertion holds with evidence. Otherwise fail with a bounded, actionable issue list.",
	);
	return lines.join("\\n");
}

function usertestTask(ms) {
	const lines = [
		"Black-box test one mission milestone like a real end user. You are not a code reviewer.",
		"",
		"# Mission objective",
		PLAN.objective,
		"",
		contractSection(),
		"",
		"# Milestone under test: " + ms.id + " — " + ms.title,
		"",
	];
	if (PLAN.smokeCommands.length > 0) {
		lines.push("# Smoke commands (how to start / exercise the app)");
		for (const c of PLAN.smokeCommands) lines.push("- '" + c + "'");
		lines.push("");
	}
	lines.push(
		"# Rules",
		"- Drive the running application from the outside: start it, exercise the user flows implied by the contract assertions, observe actual behavior.",
		"- Use bash (curl, CLI invocations, test scripts) as your hands. Clean up any processes you start.",
		"- Do NOT read the implementation to excuse broken behavior; behavior is ground truth. Do NOT modify project files.",
		"- verdict pass only if the observable behavior satisfies every relevant assertion. Otherwise fail with a bounded issue list.",
	);
	return lines.join("\\n");
}

function fixPlanTask(ms, issues) {
	return [
		"Validation found problems in one mission milestone. Plan bounded fixes — do not implement them yourself.",
		"",
		"# Mission objective",
		PLAN.objective,
		"",
		contractSection(),
		"",
		"# Milestone: " + ms.id + " — " + ms.title,
		"",
		"# Validator issues (JSON)",
		JSON.stringify(issues),
		"",
		"# Rules",
		"- Read the relevant code before writing fix specs.",
		"- Produce at most " + MAX_FIXES_PER_ROUND + " fixes, each small, ordered, and self-contained enough for a fresh-context worker.",
		"- Each fix must move the milestone toward satisfying the contract; do not refight settled scope decisions.",
	].join("\\n");
}

function fixTask(ms, fix) {
	return [
		"Apply one bounded fix to a mission milestone.",
		"",
		"# Mission objective",
		PLAN.objective,
		"",
		"# Milestone: " + ms.id + " — " + ms.title,
		"",
		"# Fix: " + fix.title,
		fix.spec,
		"",
		"# Rules",
		"- Stay scoped to the fix. Add or update tests proving the fix.",
		"- Report status done only when the fix is applied and relevant tests pass.",
	].join("\\n");
}

for (const ms of PLAN.milestones) {
	if (report.stopped) break;
	report.milestones[ms.id] = { passed: false, rounds: 0 };

	for (const f of ms.features) {
		if (f.done) {
			report.features[f.id] = { status: "done", skipped: true };
			continue;
		}
		await state.set("current", "feature " + f.id + " (" + ms.id + ")");
		let r;
		try {
			r = await runs.run("f-" + f.id, {
				agent: "mission-worker",
				task: featureTask(ms, f),
				output: f.outputPath,
				outputSchema: WORKER_SCHEMA,
			});
		} catch (err) {
			r = { ok: false, error: String(err) };
		}
		const st = r.structuredOutput && r.structuredOutput.status;
		report.features[f.id] = { ok: r.ok === true, status: st || "blocked", summary: (r.structuredOutput && r.structuredOutput.summary) || "" };
		await state.set("feature-" + f.id, jsonSafe(report.features[f.id]));
		if (!(r.ok === true) || st !== "done") {
			report.stopped = { kind: "feature", id: f.id, detail: (r.structuredOutput && r.structuredOutput.summary) || r.error || "worker failed" };
			break;
		}
	}
	if (report.stopped) break;

	let passed = false;
	let issues = [];
	for (let round = 1; round <= PLAN.maxRounds && !passed && !report.stopped; round++) {
		report.milestones[ms.id].rounds = round;
		await state.set("current", "validation " + ms.id + " round " + round);
		const validators = [
			{ key: "vs-" + ms.id + "-r" + round, agent: "mission-scrutiny", task: scrutinyTask(ms), outputSchema: VERDICT_SCHEMA },
		];
		if (PLAN.userTesting) {
			validators.push({ key: "vu-" + ms.id + "-r" + round, agent: "mission-usertest", task: usertestTask(ms), outputSchema: VERDICT_SCHEMA });
		}
		let verdicts;
		try {
			verdicts = await runs.all(validators);
		} catch (err) {
			verdicts = [{ ok: false, error: String(err) }];
		}
		issues = [];
		for (const v of verdicts) {
			if (v.structuredOutput && v.structuredOutput.verdict === "fail") {
				for (const issue of v.structuredOutput.issues) issues.push(issue);
			} else if (!(v.ok === true) || !v.structuredOutput) {
				issues.push({ title: "validator run failed", detail: v.error || v.output || "no structured verdict" });
			}
		}
		await state.set("validation-" + ms.id + "-r" + round, jsonSafe({ issueCount: issues.length }));
		if (issues.length === 0) {
			passed = true;
			break;
		}

		await state.set("current", "fix planning " + ms.id + " round " + round);
		let fp;
		try {
			fp = await runs.run("fp-" + ms.id + "-r" + round, { agent: "mission-fix-planner", task: fixPlanTask(ms, issues), outputSchema: FIXPLAN_SCHEMA });
		} catch (err) {
			fp = { ok: false, error: String(err) };
		}
		const fixes = (fp.structuredOutput && fp.structuredOutput.fixes ? fp.structuredOutput.fixes : []).slice(0, MAX_FIXES_PER_ROUND);
		if (fixes.length === 0) {
			report.stopped = { kind: "fix-plan", id: ms.id, detail: "fix planner returned no fixes; issues: " + JSON.stringify(issues).slice(0, 500) };
			break;
		}
		for (let i = 0; i < fixes.length; i++) {
			await state.set("current", "fix " + (i + 1) + "/" + fixes.length + " " + ms.id + " round " + round);
			let fr;
			try {
				fr = await runs.run("fix-" + ms.id + "-r" + round + "-" + i, { agent: "mission-worker", task: fixTask(ms, fixes[i]), outputSchema: WORKER_SCHEMA });
			} catch (err) {
				fr = { ok: false, error: String(err) };
			}
			const fst = fr.structuredOutput && fr.structuredOutput.status;
			if (!(fr.ok === true) || fst !== "done") {
				report.stopped = { kind: "fix", id: ms.id, detail: (fr.structuredOutput && fr.structuredOutput.summary) || fr.error || "fix worker failed" };
				break;
			}
		}
	}

	report.milestones[ms.id].passed = passed;
	await state.set("milestone-" + ms.id, jsonSafe(report.milestones[ms.id]));
	if (!passed && !report.stopped) {
		report.stopped = { kind: "validation", id: ms.id, detail: "exhausted " + PLAN.maxRounds + " validation rounds; last issues: " + JSON.stringify(issues).slice(0, 500) };
	}
}

await state.set("current", "");
report.ok = !report.stopped && PLAN.milestones.every(function (ms) { return report.milestones[ms.id] && report.milestones[ms.id].passed; });
return report;
`;
}

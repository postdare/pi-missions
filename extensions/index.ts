/**
 * pi-missions — Factory-style Missions for pi.
 *
 * Flow:
 *   /mission <goal>          → kick off a planning conversation (LLM + mission-planning skill)
 *   mission_submit_plan tool → LLM submits validation contract + milestones/features → ledger written
 *   /mission-start [id]      → approve & spawn the async runner workflow via pi-subagents RPC
 *   /mission-status [id]     → progress report (ledger + live workflow state)
 *   /mission-steer [msg]     → inject guidance into the running workflow
 *   /mission-stop [id]       → stop the running workflow
 *
 * Execution runs as ONE detached async workflow (survives session shutdown):
 * fresh-context worker per feature, scrutiny + user-testing validators per
 * milestone, fix-planner + fix workers on validation failure.
 */
import * as fs from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	type Mission,
	type MissionStatus,
	estimatedRuns,
	featureCount,
	featureOutputPath,
	listMissions,
	loadMission,
	missionDir,
	newMissionId,
	normalizeId,
	pickMission,
	renderContractMarkdown,
	saveMission,
} from "../src/ledger.ts";
import { buildRunnerPlan, generateRunnerScript, planComplete } from "../src/runner-script.ts";
import {
	ASYNC_COMPLETE_EVENT,
	findSubagentMissionState as findState,
	parseSpawnReply,
	readLiveProgress,
	rpcAvailable,
	rpcRequest,
} from "../src/rpc.ts";
import { ensureRuntimeAgents } from "../src/runtime-agents.ts";
import { MissionStatusCard, type StatusCardData, type StatusCardMission } from "../src/status-card.ts";

const STATUS_KEY = "pi-missions";
const POLL_INTERVAL_MS = 15_000;

interface SubmitPlanParams {
	title: string;
	objective: string;
	contract: {
		assertions: string[];
		smokeCommands?: string[];
		userTesting?: boolean;
	};
	maxValidationRounds?: number;
	milestones: Array<{
		id?: string;
		title: string;
		features: Array<{
			id?: string;
			title: string;
			spec: string;
			assertions?: string[];
		}>;
	}>;
}

export default function (pi: ExtensionAPI) {
	let pollTimer: ReturnType<typeof setInterval> | undefined;
	let lastCtx: ExtensionContext | undefined;

	// Status reports render as durable transcript cards (appendEntry), not as
	// LLM-bound messages — sendMessage(deliverAs:"nextTurn") would stay invisible
	// until the next prompt, which made /mission-status look like a no-op.
	pi.registerEntryRenderer<StatusCardData>("pi-missions-status", (entry, _options, theme) => {
		return new MissionStatusCard(entry.data ?? { missions: [] }, theme);
	});

	// ---------------------------------------------------------------- helpers

	/** Copy per-feature/milestone results from the workflow's durable state into the ledger. */
	function reconcileProgressFromState(mission: Mission): boolean {
		if (!mission.run?.subagentMissionId) return false;
		const state = findState(mission.run.subagentMissionId);
		if (!state) return false;
		let changed = false;
		for (const ms of mission.milestones) {
			const msValue = state[`milestone-${ms.id}`] as { passed?: unknown } | undefined;
			if (msValue?.passed === true && ms.status !== "done") {
				ms.status = "done";
				changed = true;
			}
			for (const f of ms.features) {
				const fValue = state[`feature-${f.id}`] as { status?: unknown } | undefined;
				if (fValue?.status === "done" && f.status !== "done") {
					f.status = "done";
					changed = true;
				}
			}
		}
		return changed;
	}

	function formatMissionLine(m: Mission): string {
		return `${m.id}  [${m.status}]  ${m.title} (${featureCount(m)} features, ${m.milestones.length} milestones)`;
	}

	function formatProgress(m: Mission): string {
		const done = m.milestones.flatMap((ms) => ms.features).filter((f) => f.status === "done").length;
		const total = featureCount(m);
		const msDone = m.milestones.filter((ms) => ms.status === "done").length;
		return `features ${done}/${total} · milestones ${msDone}/${m.milestones.length}`;
	}

	function updateWidget(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		const running = listMissions(ctx.cwd).filter((m) => m.status === "running");
		if (running.length === 0) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}
		const m = running[0];
		let text = `⦿ ${m.title}: ${formatProgress(m)}`;
		if (m.run?.subagentMissionId) {
			const live = readLiveProgress(m.run.subagentMissionId, m.milestones.length, featureCount(m));
			if (live) {
				text = `⦿ ${m.title}: features ${live.featuresDone}/${live.featuresTotal} · milestones ${live.milestonesDone}/${live.milestonesTotal}`;
				if (live.currentLabel) text += ` · ${live.currentLabel}`;
			}
		}
		ctx.ui.setStatus(STATUS_KEY, text);
	}

	function startPolling(ctx: ExtensionContext): void {
		stopPolling();
		lastCtx = ctx;
		if (!ctx.hasUI) return;
		pollTimer = setInterval(() => {
			try {
				if (lastCtx) updateWidget(lastCtx);
			} catch {
				// polling must never crash the session
			}
		}, POLL_INTERVAL_MS);
	}

	function stopPolling(): void {
		if (pollTimer) clearInterval(pollTimer);
		pollTimer = undefined;
	}

	/** Fold the run's terminal state back into the ledger (live progress comes from state.json). */
	async function reconcile(mission: Mission, cwd: string): Promise<boolean> {
		if (mission.status !== "running") return false;
		if (!mission.run?.runId) return false;
		try {
			const data = (await rpcRequest(pi, "status", { id: mission.run.runId }, 10_000)) as {
				text?: string;
				asyncSnapshot?: { runs?: Array<{ id?: string; state?: string }> };
			};
			const state = data.asyncSnapshot?.runs?.find((r) => r.id === mission.run?.runId)?.state;
			if (state && state !== "running" && state !== "queued") {
				mission.status = state === "complete" || state === "completed" ? "completed" : state === "stopped" ? "stopped" : "failed";
				mission.run.endedAt = new Date().toISOString();
				saveMission(cwd, mission);
				return true;
			}
		} catch {
			// status lookup is best-effort
		}
		return false;
	}

	async function requireSubagents(ctx: ExtensionContext): Promise<boolean> {
		if (await rpcAvailable(pi)) return true;
		ctx.ui.notify(
			"pi-subagents is not available. Install it first: pi install npm:pi-subagents",
			"error",
		);
		return false;
	}

	async function startMission(ctx: ExtensionContext, id?: string): Promise<void> {
		if (!(await requireSubagents(ctx))) return;
		const mission = pickMission(ctx.cwd, id, ["pending", "failed", "stopped"]);
		if (!mission) {
			ctx.ui.notify(id ? `Mission '${id}' not found or not startable.` : "No startable mission. Plan one with /mission first.", "warning");
			return;
		}
		if (mission.status === "running") {
			ctx.ui.notify(`Mission ${mission.id} is already running.`, "warning");
			return;
		}

		// Resume semantics: features the ledger already marks done are excluded
		// from the regenerated runner script. (Ledger statuses are updated from
		// the workflow's durable state on completion / via /mission-status.)
		const doneIds = new Set<string>();
		for (const ms of mission.milestones) {
			for (const f of ms.features) {
				if (f.status === "done") doneIds.add(f.id);
			}
		}

		const plan = buildRunnerPlan(mission, doneIds, (fid) => featureOutputPath(ctx.cwd, mission.id, fid));
		if (planComplete(plan)) {
			ctx.ui.notify(`Mission ${mission.id}: all features already done. Nothing to run.`, "info");
			return;
		}

		const remaining = featureCount(mission) - doneIds.size;
		const summary = `${mission.title}\n${remaining} features to run · ${mission.milestones.length} milestones · ≤${mission.maxValidationRounds} validation rounds/milestone\nEstimated runs (lower bound): ${estimatedRuns(mission) - doneIds.size}`;
		if (ctx.mode === "tui") {
			const ok = await ctx.ui.confirm(`Start mission ${mission.id}?`, summary);
			if (!ok) {
				ctx.ui.notify("Mission start cancelled.", "info");
				return;
			}
		}

		const script = generateRunnerScript(plan);
		const scriptPath = `${missionDir(ctx.cwd, mission.id)}/runner.js`;
		fs.writeFileSync(scriptPath, `// Generated by pi-missions at ${new Date().toISOString()} — do not edit\n${script}`, "utf8");

		let reply: unknown;
		try {
			reply = await rpcRequest(
				pi,
				"spawn",
				{
					workflowScript: script,
					mission: { title: `pi-missions: ${mission.title}`, objective: mission.objective },
					topic: `mission ${mission.id}: ${mission.title}`,
				},
				60_000,
			);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			mission.status = "failed";
			mission.run = { ...mission.run, endedAt: new Date().toISOString(), error: message };
			saveMission(ctx.cwd, mission);
			ctx.ui.notify(
				`Failed to launch mission runner: ${message}${/Unknown agent: mission-/.test(message) ? " — role agents missing; install the package (pi install) or reload the session." : ""}`,
				"error",
			);
			return;
		}

		const spawned = parseSpawnReply(reply);
		mission.status = "running";
		mission.run = {
			runId: spawned.runId,
			asyncDir: spawned.asyncDir,
			subagentMissionId: spawned.subagentMissionId,
			startedAt: new Date().toISOString(),
		};
		saveMission(ctx.cwd, mission);
		ctx.ui.notify(`Mission ${mission.id} started (run ${spawned.runId ?? "?"}). Track with /mission-status.`, "success");
		updateWidget(ctx);
	}

	// ------------------------------------------------------------------- tool

	pi.registerTool({
		name: "mission_submit_plan",
		label: "Submit mission plan",
		description:
			"Submit a finished mission plan: a validation contract (behavioral assertions written BEFORE implementation), plus milestones and bounded features. This stores the plan for user approval; execution starts only when the user runs /mission-start.",
		promptSnippet: "Submit a mission plan (contract + milestones + features) for approval and orchestrated execution",
		promptGuidelines: [
			"Use mission_submit_plan only after the planning dialogue has produced a validation contract and a milestone/feature breakdown; never implement mission work yourself.",
			"After calling mission_submit_plan, summarize the plan and tell the user to review it, then start execution with /mission-start.",
		],
		parameters: Type.Object({
			title: Type.String({ description: "Short mission title" }),
			objective: Type.String({ description: "What the mission must achieve, in user-observable terms" }),
			contract: Type.Object({
				assertions: Type.Array(Type.String(), {
					description: "Testable behavioral assertions that define done-ness. Written before any feature exists.",
					minItems: 1,
				}),
				smokeCommands: Type.Optional(
					Type.Array(Type.String(), { description: "Shell commands to start/exercise the app for black-box validation" }),
				),
				userTesting: Type.Optional(
					Type.Boolean({ description: "Run the black-box user-testing validator each milestone (default: true when smokeCommands exist)" }),
				),
			}),
			maxValidationRounds: Type.Optional(
				Type.Number({ description: "Max validate→fix rounds per milestone before handing back to the user (default 3)" }),
			),
			milestones: Type.Array(
				Type.Object({
					id: Type.Optional(Type.String({ description: "kebab-case id, e.g. ms1" })),
					title: Type.String(),
					features: Type.Array(
						Type.Object({
							id: Type.Optional(Type.String({ description: "kebab-case id, e.g. f1" })),
							title: Type.String(),
							spec: Type.String({ description: "Bounded, self-contained implementation spec for a fresh-context worker" }),
							assertions: Type.Optional(
								Type.Array(Type.String(), { description: "Contract assertions this feature owns" }),
							),
						}),
						{ minItems: 1 },
					),
				}),
				{ minItems: 1 },
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const p = params as SubmitPlanParams;

			const mission: Mission = {
				version: 1,
				id: newMissionId(),
				title: p.title,
				objective: p.objective,
				status: "pending",
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				maxValidationRounds: Math.max(1, Math.min(10, Math.round(p.maxValidationRounds ?? 3))),
				contract: {
					assertions: p.contract.assertions,
					smokeCommands: p.contract.smokeCommands ?? [],
					userTesting: p.contract.userTesting ?? (p.contract.smokeCommands?.length ?? 0) > 0,
				},
				milestones: p.milestones.map((ms, mi) => ({
					id: normalizeId(ms.id ?? "", `ms${mi + 1}`),
					title: ms.title,
					status: "pending",
					features: ms.features.map((f, fi) => ({
						id: normalizeId(f.id ?? "", `f${mi + 1}-${fi + 1}`),
						title: f.title,
						spec: f.spec,
						assertions: f.assertions ?? [],
						status: "pending",
					})),
				})),
			};

			saveMission(ctx.cwd, mission);
			fs.writeFileSync(`${missionDir(ctx.cwd, mission.id)}/contract.md`, renderContractMarkdown(mission), "utf8");

			const lines = [
				`Mission plan stored as ${mission.id} (status: pending).`,
				"",
				`- Ledger: ${missionDir(ctx.cwd, mission.id)}/mission.json`,
				`- Contract: ${missionDir(ctx.cwd, mission.id)}/contract.md`,
				`- ${featureCount(mission)} features in ${mission.milestones.length} milestones; est. runs (lower bound): ${estimatedRuns(mission)}`,
				"",
				"Now present the plan summary to the user and ask them to review contract.md, then run /mission-start to approve and launch execution.",
			];
			return { content: [{ type: "text", text: lines.join("\n") }], details: { missionId: mission.id } };
		},
	});

	// --------------------------------------------------------------- commands

	pi.registerCommand("mission", {
		description: "Start planning a new mission (validation contract → milestones → features)",
		handler: async (args, ctx) => {
			let goal = args.trim();
			if (!goal) {
				if (!ctx.hasUI) {
					ctx.ui.notify("Usage: /mission <goal>", "warning");
					return;
				}
				goal = (await ctx.ui.input("Mission goal", "Describe the outcome you want, e.g. 'migrate the CLI to TypeScript'")) ?? "";
				if (!goal.trim()) return;
			}
			pi.sendUserMessage(
				[
					`[pi-missions] I want to start a Mission — orchestrated multi-agent execution of a large task.`,
					``,
					`Goal: ${goal}`,
					``,
					`Act as the mission planner. Read the "mission-planning" skill from your skills catalog first and follow it exactly:`,
					`1. Interview me briefly — only the few highest-leverage questions. Scout the codebase if useful.`,
					`2. Write the validation contract BEFORE defining any feature: testable behavioral assertions, plus smoke commands if the project can be run end-to-end.`,
					`3. Decompose into milestones and bounded features; each feature lists the contract assertions it owns.`,
					`4. When the plan is solid, call the mission_submit_plan tool. Do NOT implement anything yourself.`,
				].join("\n"),
			);
		},
	});

	pi.registerCommand("mission-start", {
		description: "Approve and launch (or resume) a mission: /mission-start [id]",
		handler: async (args, ctx) => {
			await startMission(ctx, args.trim() || undefined);
		},
	});

	pi.registerCommand("mission-status", {
		description: "Show mission progress: /mission-status [id]",
		handler: async (args, ctx) => {
			const id = args.trim() || undefined;
			const missions = id ? [loadMission(ctx.cwd, id)].filter((m): m is Mission => !!m) : listMissions(ctx.cwd);
			if (missions.length === 0) {
				ctx.ui.notify(id ? `Mission '${id}' not found.` : "No missions yet. Start one with /mission.", "warning");
				return;
			}
			for (const m of missions) {
				if (m.status === "running") await reconcile(m, ctx.cwd);
				if (reconcileProgressFromState(m)) saveMission(ctx.cwd, m);
			}
			const cards: StatusCardMission[] = [];
			const plain: string[] = [];
			for (const m of missions) {
				let currentLabel: string | undefined;
				if (m.status === "running" && m.run?.subagentMissionId) {
					const live = readLiveProgress(m.run.subagentMissionId, m.milestones.length, featureCount(m));
					currentLabel = live?.currentLabel || undefined;
				}
				const features = m.milestones.flatMap((ms) => ms.features);
				cards.push({
					id: m.id,
					title: m.title,
					status: m.status,
					runId: m.run?.runId,
					startedAt: m.run?.startedAt,
					endedAt: m.run?.endedAt,
					error: m.run?.error,
					currentLabel,
					featuresDone: features.filter((f) => f.status === "done").length,
					featuresTotal: features.length,
					milestonesDone: m.milestones.filter((ms) => ms.status === "done").length,
					milestonesTotal: m.milestones.length,
					milestones: m.milestones.map((ms) => ({
						id: ms.id,
						title: ms.title,
						status: ms.status,
						features: ms.features.map((f) => ({ id: f.id, title: f.title, status: f.status })),
					})),
				});
				plain.push(
					`### ${formatMissionLine(m)}`,
					...m.milestones.flatMap((ms) => [
						`- [${ms.status}] ${ms.id}: ${ms.title}`,
						...ms.features.map((f) => `  - [${f.status}] ${f.id}: ${f.title}`),
					]),
					"",
				);
			}
			if (ctx.hasUI) {
				pi.appendEntry("pi-missions-status", { missions: cards });
			} else {
				process.stdout.write(plain.join("\n") + "\n");
			}
		},
	});

	pi.registerCommand("mission-stop", {
		description: "Stop a running mission: /mission-stop [id]",
		handler: async (args, ctx) => {
			const mission = pickMission(ctx.cwd, args.trim() || undefined, ["running"]);
			if (!mission?.run?.runId) {
				ctx.ui.notify("No running mission found.", "warning");
				return;
			}
			try {
				await rpcRequest(pi, "stop", { id: mission.run.runId }, 15_000);
				mission.status = "stopped";
				mission.run.endedAt = new Date().toISOString();
				saveMission(ctx.cwd, mission);
				ctx.ui.notify(`Mission ${mission.id} stop requested. Restart any time with /mission-start ${mission.id}.`, "info");
			} catch (err) {
				ctx.ui.notify(`Stop failed: ${err instanceof Error ? err.message : String(err)}`, "error");
			}
			updateWidget(ctx);
		},
	});

	pi.registerCommand("mission-steer", {
		description: "Send guidance to the running mission workflow: /mission-steer <message>",
		handler: async (args, ctx) => {
			const message = args.trim();
			if (!message) {
				ctx.ui.notify("Usage: /mission-steer <message>", "warning");
				return;
			}
			const mission = pickMission(ctx.cwd, undefined, ["running"]);
			if (!mission?.run?.runId) {
				ctx.ui.notify("No running mission found.", "warning");
				return;
			}
			try {
				await rpcRequest(pi, "steer", { id: mission.run.runId, message }, 15_000);
				ctx.ui.notify(`Steering delivered to mission ${mission.id}.`, "success");
			} catch (err) {
				ctx.ui.notify(`Steer failed: ${err instanceof Error ? err.message : String(err)}`, "error");
			}
		},
	});

	// ---------------------------------------------------------------- events

	pi.on("session_start", (_event, ctx) => {
		// Gated internally: registers only when this package is NOT installed
		// (ad-hoc `pi -e` loading), avoiding runtime/configured agent collisions.
		ensureRuntimeAgents(pi, ctx.cwd);
		startPolling(ctx);
		try {
			const running = listMissions(ctx.cwd).filter((m) => m.status === "running");
			if (running.length > 0 && ctx.hasUI) {
				ctx.ui.notify(
					`${running.length} mission(s) marked running (e.g. ${running[0].id}). Check /mission-status; restart a stale runner with /mission-start.`,
					"info",
				);
			}
			updateWidget(ctx);
		} catch {
			// ledger read failures must not break session start
		}
	});

	pi.on("session_shutdown", () => {
		stopPolling();
		lastCtx = undefined;
	});

	pi.events.on(ASYNC_COMPLETE_EVENT, (payload: unknown) => {
		const runId = (payload as { runId?: unknown })?.runId;
		const ctx = lastCtx;
		if (!ctx || typeof runId !== "string") return;
		void (async () => {
			for (const m of listMissions(ctx.cwd)) {
				if (m.run?.runId !== runId || m.status !== "running") continue;
				const p = payload as { status?: unknown; state?: unknown };
				const status = typeof p.state === "string" ? p.state : typeof p.status === "string" ? p.status : "";
				m.status = status === "complete" || status === "completed" ? "completed" : status === "stopped" ? "stopped" : "failed";
				if (m.run) m.run.endedAt = new Date().toISOString();
				reconcileProgressFromState(m);
				saveMission(ctx.cwd, m);
				if (ctx.hasUI) {
					ctx.ui.notify(
						m.status === "completed"
							? `Mission ${m.id} finished. Review with /mission-status ${m.id}.`
							: `Mission ${m.id} ended with status '${m.status}'. See /mission-status ${m.id}; resume with /mission-start ${m.id}.`,
						m.status === "completed" ? "success" : "warning",
					);
				}
			}
			updateWidget(ctx);
		})();
	});
}

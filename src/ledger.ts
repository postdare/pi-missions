/**
 * pi-missions ledger: durable on-disk mission state.
 *
 * Layout (per project):
 *   <cwd>/.pi/missions/<mission-id>/
 *     mission.json      — the ledger (this file's schema)
 *     contract.md       — human-readable validation contract
 *     features/<fid>.md — worker output per feature (written by pi-subagents)
 *     fixes/<key>.md    — fix-worker outputs per validation round
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

export type MissionStatus = "pending" | "running" | "completed" | "failed" | "stopped";
export type FeatureStatus = "pending" | "done" | "failed";
export type MilestoneStatus = "pending" | "active" | "done" | "failed";

export interface MissionContract {
	/** Behavioral assertions that define correctness. Written BEFORE features. */
	assertions: string[];
	/** Optional shell commands that start/exercise the app for black-box testing. */
	smokeCommands: string[];
	/** Whether the user-testing validator runs for each milestone. */
	userTesting: boolean;
}

export interface MissionFeature {
	id: string;
	title: string;
	spec: string;
	/** Contract assertions this feature is responsible for. */
	assertions: string[];
	status: FeatureStatus;
}

export interface MissionMilestone {
	id: string;
	title: string;
	status: MilestoneStatus;
	features: MissionFeature[];
}

export interface MissionRunInfo {
	runId?: string;
	asyncDir?: string;
	/** The enclosing pi-subagents mission id (owns state.json with live progress). */
	subagentMissionId?: string;
	startedAt?: string;
	endedAt?: string;
	error?: string;
}

export interface Mission {
	version: 1;
	id: string;
	title: string;
	objective: string;
	status: MissionStatus;
	createdAt: string;
	updatedAt: string;
	maxValidationRounds: number;
	contract: MissionContract;
	milestones: MissionMilestone[];
	run?: MissionRunInfo;
}

export const MISSIONS_DIR_NAME = "missions";

export function missionsRoot(cwd: string): string {
	return path.join(cwd, CONFIG_DIR_NAME, MISSIONS_DIR_NAME);
}

export function missionDir(cwd: string, id: string): string {
	return path.join(missionsRoot(cwd), id);
}

export function missionFile(cwd: string, id: string): string {
	return path.join(missionDir(cwd, id), "mission.json");
}

export function featureOutputPath(cwd: string, missionId: string, featureId: string): string {
	return path.join(missionDir(cwd, missionId), "features", `${featureId}.md`);
}

export function fixOutputPath(cwd: string, missionId: string, key: string): string {
	return path.join(missionDir(cwd, missionId), "fixes", `${key}.md`);
}

export function newMissionId(): string {
	const ts = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 12);
	const rand = Math.random().toString(36).slice(2, 8);
	return `m-${ts}-${rand}`;
}

const ID_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;

export function normalizeId(raw: string, fallback: string): string {
	const cleaned = raw
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40);
	const id = cleaned.length > 0 ? cleaned : fallback;
	return ID_RE.test(id) ? id : fallback;
}

export function saveMission(cwd: string, mission: Mission): void {
	const dir = missionDir(cwd, mission.id);
	fs.mkdirSync(path.join(dir, "features"), { recursive: true });
	fs.mkdirSync(path.join(dir, "fixes"), { recursive: true });
	mission.updatedAt = new Date().toISOString();
	const tmp = path.join(dir, `.mission.json.${process.pid}.tmp`);
	fs.writeFileSync(tmp, JSON.stringify(mission, null, 2) + "\n", "utf8");
	fs.renameSync(tmp, path.join(dir, "mission.json"));
}

export function loadMission(cwd: string, id: string): Mission | undefined {
	try {
		const raw = fs.readFileSync(missionFile(cwd, id), "utf8");
		const parsed = JSON.parse(raw) as Mission;
		if (parsed && parsed.version === 1 && parsed.id) return parsed;
		return undefined;
	} catch {
		return undefined;
	}
}

export function listMissions(cwd: string): Mission[] {
	const root = missionsRoot(cwd);
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(root, { withFileTypes: true });
	} catch {
		return [];
	}
	const out: Mission[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const mission = loadMission(cwd, entry.name);
		if (mission) out.push(mission);
	}
	out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
	return out;
}

/** Pick a mission by explicit id, or the most recently updated one matching `statuses`. */
export function pickMission(cwd: string, id: string | undefined, statuses?: MissionStatus[]): Mission | undefined {
	if (id) return loadMission(cwd, id);
	const all = listMissions(cwd);
	if (!statuses || statuses.length === 0) return all[0];
	return all.find((m) => statuses.includes(m.status));
}

export function featureCount(mission: Mission): number {
	return mission.milestones.reduce((n, ms) => n + ms.features.length, 0);
}

/** Factory-style lower bound: 1 worker run per feature + 2 validator runs per milestone. */
export function estimatedRuns(mission: Mission): number {
	return featureCount(mission) + 2 * mission.milestones.length;
}

export function renderContractMarkdown(mission: Mission): string {
	const lines: string[] = [
		`# Validation contract — ${mission.title}`,
		"",
		`Mission: \`${mission.id}\``,
		"",
		"## Objective",
		"",
		mission.objective,
		"",
		"## Behavioral assertions",
		"",
		...mission.contract.assertions.map((a, i) => `${i + 1}. ${a}`),
		"",
	];
	if (mission.contract.smokeCommands.length > 0) {
		lines.push("## Smoke commands", "");
		for (const cmd of mission.contract.smokeCommands) lines.push(`- \`${cmd}\``);
		lines.push("");
	}
	lines.push(
		"## Milestones",
		"",
		...mission.milestones.flatMap((ms) => [
			`### ${ms.id}: ${ms.title}`,
			"",
			...ms.features.map((f) => `- **${f.id}** (${f.status}) ${f.title}`),
			"",
		]),
	);
	return lines.join("\n");
}

/**
 * Thin client for the pi-subagents in-process RPC bridge.
 *
 * See pi-subagents docs/extension-api.md: listen for `subagents:rpc:v1:ready`,
 * send on `subagents:rpc:v1:request`, read replies on `subagents:rpc:v1:reply:<requestId>`.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const RPC_REQUEST_EVENT = "subagents:rpc:v1:request";
export const RPC_READY_EVENT = "subagents:rpc:v1:ready";
export const RPC_REPLY_PREFIX = "subagents:rpc:v1:reply:";
export const ASYNC_COMPLETE_EVENT = "subagent:async-complete";

export class RpcError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.code = code;
	}
}

export function rpcRequest(
	pi: ExtensionAPI,
	method: "ping" | "spawn" | "status" | "steer" | "stop",
	params: Record<string, unknown>,
	timeoutMs = 30_000,
): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const requestId = globalThis.crypto.randomUUID();
		let settled = false;
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			unsub?.();
			reject(new RpcError("timeout", `pi-subagents RPC ${method} timed out after ${timeoutMs}ms`));
		}, timeoutMs);
		const unsub = pi.events.on(`${RPC_REPLY_PREFIX}${requestId}`, (reply: unknown) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			unsub?.();
			const r = reply as
				| { success: true; data: unknown }
				| { success: false; error: { code: string; message: string } };
			if (r.success) resolve(r.data);
			else reject(new RpcError(r.error.code, r.error.message));
		});
		pi.events.emit(RPC_REQUEST_EVENT, {
			version: 1,
			requestId,
			method,
			params,
			source: { extension: "pi-missions" },
		});
	});
}

/** Quick liveness probe: resolves true when pi-subagents is installed and its RPC bridge is up. */
export async function rpcAvailable(pi: ExtensionAPI): Promise<boolean> {
	try {
		await rpcRequest(pi, "ping", {}, 3_000);
		return true;
	} catch {
		return false;
	}
}

export interface SpawnResult {
	runId?: string;
	asyncDir?: string;
	subagentMissionId?: string;
	text?: string;
}

/** Extract the async run identity from a spawn reply (shape is pi-subagents-owned; be defensive). */
export function parseSpawnReply(data: unknown): SpawnResult {
	const out: SpawnResult = {};
	if (!data || typeof data !== "object") return out;
	const d = data as Record<string, unknown>;
	if (typeof d.text === "string") out.text = d.text;
	const details = (d.details ?? d) as Record<string, unknown>;
	const runId = details.runId ?? details.asyncId ?? d.runId;
	if (typeof runId === "string") out.runId = runId;
	if (typeof details.asyncDir === "string") out.asyncDir = details.asyncDir;
	if (typeof details.missionId === "string") out.subagentMissionId = details.missionId;
	return out;
}

/**
 * Locate the pi-subagents mission state file (`state.json`) that a workflow's
 * `state.set()` writes. Lives under ~/.pi/agent/missions/projects/<hash>/<missionId>/state.json.
 */
export function findSubagentMissionState(subagentMissionId: string): Record<string, unknown> | undefined {
	const projectsRoot = path.join(os.homedir(), ".pi", "agent", "missions", "projects");
	let projects: fs.Dirent[];
	try {
		projects = fs.readdirSync(projectsRoot, { withFileTypes: true });
	} catch {
		return undefined;
	}
	for (const project of projects) {
		if (!project.isDirectory()) continue;
		const statePath = path.join(projectsRoot, project.name, subagentMissionId, "state.json");
		try {
			const raw = fs.readFileSync(statePath, "utf8");
			const parsed = JSON.parse(raw) as Record<string, unknown>;
			if (parsed && typeof parsed === "object") return parsed;
		} catch {
			// keep scanning
		}
	}
	return undefined;
}

export interface LiveProgress {
	featuresDone: number;
	featuresTotal: number;
	milestonesDone: number;
	milestonesTotal: number;
	currentLabel?: string;
}

/** Progress snapshot from the workflow's durable state (written by the generated runner). */
export function readLiveProgress(subagentMissionId: string, milestonesTotal: number, featuresTotal: number): LiveProgress | undefined {
	const state = findSubagentMissionState(subagentMissionId);
	if (!state) return undefined;
	let featuresDone = 0;
	let milestonesDone = 0;
	for (const [key, value] of Object.entries(state)) {
		if (key.startsWith("feature-") && value && typeof value === "object" && (value as { status?: unknown }).status === "done") {
			featuresDone++;
		}
		if (key.startsWith("milestone-") && value && typeof value === "object" && (value as { passed?: unknown }).passed === true) {
			milestonesDone++;
		}
	}
	const current = state["current"];
	return {
		featuresDone,
		featuresTotal,
		milestonesDone,
		milestonesTotal,
		currentLabel: typeof current === "string" ? current : undefined,
	};
}

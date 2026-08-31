/**
 * pi-missions · store/evidence + scan
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { Evidence, MissionState } from "../core/types.ts";
import type { RepoLayout } from "./paths.ts";
import { statePaths } from "./paths.ts";
import { loadStateFile } from "./state.ts";

/** 证据快照归档:missions/state/<id>/evidence/<task>-attempt<n>.json */
export function saveEvidence(evidenceDir: string, taskId: string, attempt: number, evidences: Evidence[]): string {
	fs.mkdirSync(evidenceDir, { recursive: true });
	const file = path.join(evidenceDir, `${taskId}-attempt${attempt}.json`);
	fs.writeFileSync(file, `${JSON.stringify({ taskId, attempt, at: Date.now(), evidences }, null, 2)}\n`, "utf8");
	return file;
}

export interface ScannedMission {
	missionId: string;
	state: MissionState;
	stateDir: string;
}

/** 从 missions/state/*\/STATE.json 扫描重建历史列表 —— 不依赖内存(I1) */
export function scanMissions(l: RepoLayout): ScannedMission[] {
	let dirs: fs.Dirent[];
	try {
		dirs = fs.readdirSync(l.state, { withFileTypes: true });
	} catch {
		return [];
	}
	const out: ScannedMission[] = [];
	for (const d of dirs) {
		if (!d.isDirectory()) continue;
		const state = loadStateFile(statePaths(l, d.name).stateJson);
		if (state) out.push({ missionId: d.name, state, stateDir: path.join(l.state, d.name) });
	}
	return out.sort((a, b) => b.state.updatedAt - a.state.updatedAt);
}

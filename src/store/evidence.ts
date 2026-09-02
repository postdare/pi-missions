/**
 * pi-missions · store/evidence + scan
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { Evidence, MissionState } from "../core/types.ts";
import type { RepoLayout } from "./paths.ts";
import { statePaths } from "./paths.ts";
import type { MissionPlan } from "./mission.ts";
import { MissionRepository } from "./repository.ts";

/** 证据快照归档:missions/state/<id>/evidence/<task>-attempt<n>.json */
export function saveEvidence(evidenceDir: string, taskId: string, attempt: number, evidences: Evidence[]): string {
	fs.mkdirSync(evidenceDir, { recursive: true });
	const file = path.join(evidenceDir, `${taskId}-attempt${attempt}.json`);
	fs.writeFileSync(file, `${JSON.stringify({ taskId, attempt, at: Date.now(), evidences }, null, 2)}\n`, "utf8");
	return file;
}

export interface EvidenceRecord {
	result: string;
	level: string;
	at: number;
	taskId?: string;
	attempt?: number;
	rawTail?: string;
}

export interface TaskEvidenceAttempt {
	taskId: string;
	attempt: number;
	at: number;
	evidences: Evidence[];
}

/** 按任务读取所有 attempt 证据历史,按 attempt 升序排列 */
export function readTaskEvidenceHistory(evidenceDir: string, taskId: string): TaskEvidenceAttempt[] {
	if (!evidenceDir || !taskId) return [];
	let files: string[];
	try {
		files = fs.readdirSync(evidenceDir).filter((f) => f.endsWith(".json"));
	} catch {
		return [];
	}
	const out: TaskEvidenceAttempt[] = [];
	for (const f of files) {
		try {
			const data = JSON.parse(fs.readFileSync(path.join(evidenceDir, f), "utf8")) as {
				taskId?: string;
				attempt?: number;
				at?: number;
				evidences?: Evidence[];
			};
			if (data.taskId !== taskId) continue;
			out.push({
				taskId,
				attempt: typeof data.attempt === "number" ? data.attempt : 0,
				at: typeof data.at === "number" ? data.at : 0,
				evidences: Array.isArray(data.evidences) ? data.evidences : [],
			});
		} catch {
			/* 跳过坏文件 */
		}
	}
	return out.sort((a, b) => a.attempt - b.attempt || a.at - b.at);
}

/** 聚合每条 AC(verify 分支)最近一次判定结果,供状态面板展示 */
export function latestEvidenceResults(evidenceDir: string): Record<string, EvidenceRecord> {
	const out: Record<string, EvidenceRecord> = {};
	let files: string[];
	try {
		files = fs.readdirSync(evidenceDir).filter((f) => f.endsWith(".json"));
	} catch {
		return out;
	}
	for (const f of files) {
		try {
			const data = JSON.parse(fs.readFileSync(path.join(evidenceDir, f), "utf8")) as {
				at: number;
				taskId?: string;
				attempt?: number;
				evidences: Evidence[];
			};
			for (const e of data.evidences ?? []) {
				const prev = out[e.acId];
				if (!prev || data.at >= prev.at) {
					out[e.acId] = {
						result: e.result,
						level: e.level,
						at: data.at,
						taskId: data.taskId,
						attempt: data.attempt,
						rawTail: e.result === "fail" ? e.raw.slice(-400) : undefined,
					};
				}
			}
		} catch {
			/* 跳过坏文件 */
		}
	}
	return out;
}

export interface ScannedMission {
	missionId: string;
	state: MissionState;
	/** 来自已通过 schema/hash 校验的 v2 snapshot */
	plan: MissionPlan;
	stateDir: string;
}

/** 从 missions/state/ 扫描重建历史列表 —— 不依赖内存(I1)。活跃的排前面。 */
export function scanMissions(
	l: RepoLayout,
	onError?: (error: { code: "missing" | "corrupt" | "conflict"; message: string }) => void,
): ScannedMission[] {
	const out: ScannedMission[] = [];
	for (const loaded of new MissionRepository(l).list()) {
		if (!loaded.ok) {
			onError?.({ code: loaded.code, message: loaded.error });
			continue;
		}
		const snapshot = loaded.snapshot;
		out.push({
			missionId: snapshot.missionId,
			state: snapshot.state,
			plan: snapshot.plan,
			stateDir: statePaths(l, snapshot.missionId).dir,
		});
	}
	const ACTIVE = new Set(["define", "plan", "do", "check", "act"]);
	return out.sort((a, b) => {
		const aa = ACTIVE.has(a.state.phase) ? 0 : 1;
		const bb = ACTIVE.has(b.state.phase) ? 0 : 1;
		return aa !== bb ? aa - bb : b.state.updatedAt - a.state.updatedAt;
	});
}

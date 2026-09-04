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

/**
 * 证据快照归档:missions/state/<id>/evidence/<task>-a<attempt>-g<generation>.json
 *
 * **文件名里必须有 generation。** 原来是 `<task>-attempt<n>.json`,而 attempts
 * **不是每轮提交都会涨**:自增发生在 ACT 的 `ADJUST_DONE`,而 L2 升级是从 ACT
 * 直接走掉的,跳过了那一步;重规划后 `PLAN_FROZEN` 又用 `Math.max(1, attempts)`
 * 保留原值。于是同一个任务会用**同一个 attempt 号**提交两次,归档原样覆盖。
 * 真实事故(E7,09-04):T5 第一轮被独立核验判 FAIL,
 * 那份 253 秒的核验结论(hard 绿 / verifier 红,点名某条测试的断言被抽空)
 * 被后来通过的那一轮盖掉了,事后只剩 LOG 里一行截断的摘要。
 *
 * **失败的证据比成功的证据值钱** —— 判定装置到底抓住过什么、凭什么抓住的,
 * 事后全靠这份归档;而恰恰是"被抓住然后修好"的那一次会被修好的那一次覆盖。
 * generation 单调递增,天然不重。
 *
 * 读侧不受影响:readTaskEvidenceHistory / latestEvidenceResults 都从 JSON **内容**
 * 里取 taskId/attempt/at,不解析文件名,旧命名的历史归档照样读得出来。
 */
export function saveEvidence(
	evidenceDir: string,
	taskId: string,
	attempt: number,
	evidences: Evidence[],
	generation: number,
): string {
	fs.mkdirSync(evidenceDir, { recursive: true });
	const file = path.join(evidenceDir, `${taskId}-a${attempt}-g${generation}.json`);
	fs.writeFileSync(
		file,
		`${JSON.stringify({ taskId, attempt, generation, at: Date.now(), evidences }, null, 2)}\n`,
		"utf8",
	);
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

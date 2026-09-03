/**
 * pi-missions · store/paths
 *
 * 仓库布局(I6 · 仓库即规范)。状态不放 .pi/(工具目录,通常在 .gitignore),
 * 全部进仓库 missions/。目录名可用 .pi/pi-missions.json 的 missionsDir 覆盖。
 */

import * as path from "node:path";

export interface RepoLayout {
	/** missions/ 绝对路径 */
	root: string;
	state: string;
	/** 探针结论:missions/spikes/<missionId>/<taskId>.md */
	spikes: string;
	phases: string;
}

export interface MissionStatePaths {
	dir: string;
	snapshotJson: string;
	generationsDir: string;
	generationDir: (revision: number) => string;
	generationMissionMd: (revision: number) => string;
	generationVerifySh: (revision: number) => string;
	logMd: string;
	evidenceDir: string;
	archiveDir: string;
	checkJson: string;
}

export function layout(cwd: string, dirName: string): RepoLayout {
	const root = path.join(cwd, dirName);
	return {
		root,
		state: path.join(root, "state"),
		spikes: path.join(root, "spikes"),
		phases: path.join(root, "phases"),
	};
}

export function statePaths(l: RepoLayout, missionId: string): MissionStatePaths {
	const dir = path.join(l.state, missionId);
	return {
		dir,
		snapshotJson: path.join(dir, "SNAPSHOT.json"),
		generationsDir: path.join(dir, "generations"),
		generationDir: (revision: number) => path.join(dir, "generations", String(revision)),
		generationMissionMd: (revision: number) => path.join(dir, "generations", String(revision), "MISSION.md"),
		generationVerifySh: (revision: number) => path.join(dir, "generations", String(revision), "verify.sh"),
		logMd: path.join(dir, "LOG.md"),
		evidenceDir: path.join(dir, "evidence"),
		archiveDir: path.join(dir, "archive"),
		checkJson: path.join(dir, "CHECK.json"),
	};
}

/** 当前活跃 mission 指针(session_start 重建用) */
export function currentPointer(l: RepoLayout): string {
	return path.join(l.state, "CURRENT");
}

/**
 * 探针结论文件。放在 missions/spikes/ 而不是 state/ —— 它是给人和 planner 读的产物,
 * 值得进仓库;state/ 是 L0 的账本,执行者根本写不进去。
 */
export function spikeReport(l: RepoLayout, missionId: string, taskId: string): string {
	return path.join(l.spikes, missionId, `${taskId}.md`);
}


export function modelsJson(l: RepoLayout): string {
	return path.join(l.root, "models.json");
}

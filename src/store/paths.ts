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
	plans: string;
	state: string;
	phases: string;
	scripts: string;
}

export interface MissionPlanPaths {
	dir: string;
	missionMd: string;
	milestoneFile: (milestoneId: string) => string;
}

export interface MissionStatePaths {
	dir: string;
	stateJson: string;
	logMd: string;
	evidenceDir: string;
	archiveDir: string;
}

export function layout(cwd: string, dirName: string): RepoLayout {
	const root = path.join(cwd, dirName);
	return {
		root,
		plans: path.join(root, "plans"),
		state: path.join(root, "state"),
		phases: path.join(root, "phases"),
		scripts: path.join(root, "scripts"),
	};
}

export function planPaths(l: RepoLayout, missionId: string): MissionPlanPaths {
	const dir = path.join(l.plans, missionId);
	return {
		dir,
		missionMd: path.join(dir, "MISSION.md"),
		milestoneFile: (milestoneId: string) => path.join(dir, `${milestoneId}.md`),
	};
}

export function statePaths(l: RepoLayout, missionId: string): MissionStatePaths {
	const dir = path.join(l.state, missionId);
	return {
		dir,
		stateJson: path.join(dir, "STATE.json"),
		logMd: path.join(dir, "LOG.md"),
		evidenceDir: path.join(dir, "evidence"),
		archiveDir: path.join(dir, "archive"),
	};
}

/** 当前活跃 mission 指针(session_start 重建用) */
export function currentPointer(l: RepoLayout): string {
	return path.join(l.state, "CURRENT");
}

export function verifySh(l: RepoLayout): string {
	return path.join(l.scripts, "verify.sh");
}

export function envFingerprintSh(l: RepoLayout): string {
	return path.join(l.scripts, "env-fingerprint.sh");
}

export function verifierToolsTs(l: RepoLayout): string {
	return path.join(l.scripts, "verifier-tools.ts");
}

export function modelsJson(l: RepoLayout): string {
	return path.join(l.root, "models.json");
}

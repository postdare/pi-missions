/**
 * pi-missions · store/config
 *
 * 项目级配置:<cwd>/.pi/pi-missions.json
 * 直接读文件,不依赖 pi settings API —— 配置文件本身也要进仓库才符合 I6。
 */

import * as fs from "node:fs";
import * as path from "node:path";

export interface MissionsConfig {
	/** missions 目录名,默认 "missions"(与目标仓库已有目录冲突时改这里) */
	missionsDir: string;
	/** 编辑级增量检查命令(§8.2),如 "npx tsc --noEmit" / "mvn -q compile"。未配置则关闭 */
	incrementalCheck?: string;
	/** 公开 API 文件 glob(升档判据),如 ["src/api/**", "*.proto"] */
	publicApiGlobs?: string[];
	/** 子进程 Verifier 超时毫秒,默认 300000 */
	verifierTimeoutMs?: number;
	/** 上下文水位(0-1),超过则主动换脑,默认 0.5 */
	contextWatermark?: number;
}

const DEFAULTS: MissionsConfig = { missionsDir: "missions" };

export function loadConfig(cwd: string): MissionsConfig {
	try {
		const raw = fs.readFileSync(path.join(cwd, ".pi", "pi-missions.json"), "utf8");
		return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<MissionsConfig>) };
	} catch {
		return { ...DEFAULTS };
	}
}

/** 极简 glob:支持 "前缀/**"、精确匹配、*.后缀 三种,够升档判据用 */
export function matchGlob(filePath: string, glob: string): boolean {
	const norm = filePath.replace(/\\/g, "/");
	if (glob.endsWith("/**")) return norm.startsWith(glob.slice(0, -3));
	if (glob.startsWith("*.")) return norm.endsWith(glob.slice(1));
	return norm === glob || norm.endsWith(`/${glob}`);
}

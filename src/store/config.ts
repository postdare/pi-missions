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
	/**
	 * 独立 Verifier 的**静默**上限毫秒,默认 120000。
	 * 掐的是"多久没有任何动静",不是"总共跑了多久" —— 真机实测每轮间隔
	 * 11–16 秒,而一次实质核验要 225–236 秒。按总时长掐会把干活的误杀
	 * (真实事故),按静默掐反而能更早发现卡住的。判定见 core/verifier-budget.ts。
	 */
	verifierIdleMs?: number;
	/** 独立 Verifier 的总时长兜底毫秒,默认 900000。常规路径靠静默判定,这条只防"一直有动静但不收敛" */
	verifierCeilingMs?: number;
	/**
	 * 单路 scout 超时毫秒,默认 180000。
	 * 扇出是并行的,所以这也是整轮侦查的墙钟上限,不是 N 倍。
	 * 比 verifier 短:侦查是查几个具体事实,查不动就该如实交"未查明"回来。
	 */
	scoutTimeoutMs?: number;
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

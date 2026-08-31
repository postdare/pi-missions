/**
 * pi-missions · store/git
 *
 * git 集成(Q5):
 * - MISSION.md 建议提交;missions/state/ 默认写 .git/info/exclude(不动用户 .gitignore)
 * - 非 git 仓库降级运行:AC 冻结只剩 L0 闸门,无 git log 审计链
 * - 环境指纹(I9):以 scaffold 的 env-fingerprint.sh 输出为准,sha256 之
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

type Exec = (cmd: string, args: string[], opts?: { cwd?: string; timeout?: number }) => Promise<{ code: number; stdout: string; stderr: string }>;

export async function isGitRepo(exec: Exec, cwd: string): Promise<boolean> {
	const r = await exec("git", ["rev-parse", "--is-inside-work-tree"], { cwd, timeout: 10_000 });
	return r.code === 0 && r.stdout.trim() === "true";
}

/** 把 pattern 追加到 .git/info/exclude(不改用户的 .gitignore,不进索引) */
export function ensureInfoExclude(cwd: string, pattern: string): boolean {
	const excludeFile = path.join(cwd, ".git", "info", "exclude");
	try {
		if (!fs.existsSync(path.dirname(excludeFile))) return false;
		const existing = fs.existsSync(excludeFile) ? fs.readFileSync(excludeFile, "utf8") : "";
		if (existing.split("\n").some((l) => l.trim() === pattern)) return true;
		fs.appendFileSync(excludeFile, `\n# pi-missions 运行状态,默认不进版本控制\n${pattern}\n`, "utf8");
		return true;
	} catch {
		return false;
	}
}

/**
 * 计算环境指纹。脚本由 scaffold 落盘,与锁文件一起进仓库,可复现(I9)。
 * 脚本缺失(quick 档尚未落盘)时用内置探针兜底。
 */
export async function computeEnvFingerprint(exec: Exec, cwd: string, scriptPath: string): Promise<string> {
	let material: string;
	if (fs.existsSync(scriptPath)) {
		const r = await exec("bash", [scriptPath], { cwd, timeout: 30_000 });
		material = r.stdout;
	} else {
		const r = await exec(
			"bash",
			[
				"-c",
				'node --version 2>/dev/null; java -version 2>&1 | head -1; mvn -version 2>/dev/null | head -1; python3 --version 2>/dev/null; go version 2>/dev/null; for f in package-lock.json pom.xml requirements.txt yarn.lock pnpm-lock.yaml Cargo.lock go.sum; do [ -f "$f" ] && echo "$f:$(sha256sum "$f" | cut -d" " -f1)"; done',
			],
			{ cwd, timeout: 30_000 },
		);
		material = r.stdout;
	}
	return `sha256:${createHash("sha256").update(material).digest("hex").slice(0, 16)}`;
}

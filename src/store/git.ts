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

/**
 * 计算工作区树指纹(HEAD + status + diff)。用于补证据闸门判定「工作区是否有任何实际改动」。
 * 非 git 仓库或执行异常时返回 null(降级放行)。
 *
 * `excludePaths` 是必须的,不是优化项。这个指纹想问的是「**产出**变了吗」,
 * 而 status/diff 回答的是「工作区变了吗」—— 两者只在系统自己的状态件对 git 不可见时
 * 才碰巧相等。一旦有人把 `missions/state/` 强行加进版本控制(换机器搬 mission 时
 * 最自然的动作),SNAPSHOT.json 每次状态迁移都会重写并出现在 diff 里,树指纹于是
 * 每轮都不同 —— 「没改动就不许原样重交」这条判据永远不成立,补证据闸门无声失效。
 * 实测过:跟踪状态件的仓库里,原样重交直接放行。
 *
 * 排的只有 `missions/state/`(系统写的),不含 `missions/spikes/` ——
 * 探针结论是**执行者**的产出,而且探针任务同样可能挂 awaitingEvidence,
 * 把它一起排掉会反过来锁死一次合法的重交。
 */
export async function computeGitTreeFingerprint(
	exec: Exec,
	cwd: string,
	excludePaths: string[] = [],
): Promise<string | null> {
	// pathspec magic 需要一个正向项垫底,否则 git 报 "nothing to exclude from"
	const pathspec = excludePaths.length > 0 ? ["--", ".", ...excludePaths.map((p) => `:(exclude)${p}`)] : [];
	try {
		const head = await exec("git", ["rev-parse", "HEAD"], { cwd, timeout: 10_000 });
		const status = await exec("git", ["status", "--porcelain", ...pathspec], { cwd, timeout: 10_000 });
		const diff = await exec("git", ["-c", "core.pager=cat", "diff", "HEAD", ...pathspec], { cwd, timeout: 30_000 });
		if (head.code !== 0 && status.code !== 0) return null;
		const headStr = head.code === 0 ? head.stdout.trim() : "NO_HEAD";
		const statusStr = status.code === 0 ? status.stdout : "";
		const diffStr = diff.code === 0 ? diff.stdout : "";
		const material = `HEAD:${headStr}\nSTATUS:\n${statusStr}\nDIFF:\n${diffStr}`;
		return `sha256:${createHash("sha256").update(material).digest("hex").slice(0, 16)}`;
	} catch {
		return null;
	}
}

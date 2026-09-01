/**
 * pi-missions · store/scaffold
 *
 * 首次 /mission new 时把工作流文件铺进目标仓库(I6 · 仓库即规范):
 *   missions/README.md            工作流规则(Agent-first)
 *   missions/phases/*.md          相位提示词(进入该相位才加载,I8)
 *   missions/scripts/env-fingerprint.sh
 *   missions/scripts/verifier-tools.ts  (子进程 Verifier 的扩展)
 * 已存在的文件不覆盖 —— 用户可以定制,仓库里的才是规范。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { RepoLayout } from "./paths.ts";

const TEMPLATES: Array<{ rel: (l: RepoLayout) => string; template: string; executable?: boolean }> = [
	{ rel: (l) => path.join(l.root, "README.md"), template: "missions-README.md" },
	{ rel: (l) => path.join(l.phases, "frame.md"), template: "phases/frame.md" },
	{ rel: (l) => path.join(l.phases, "plan.md"), template: "phases/plan.md" },
	{ rel: (l) => path.join(l.phases, "do.md"), template: "phases/do.md" },
	{ rel: (l) => path.join(l.phases, "check.md"), template: "phases/check.md" },
	{ rel: (l) => path.join(l.phases, "act.md"), template: "phases/act.md" },
	{ rel: (l) => path.join(l.scripts, "env-fingerprint.sh"), template: "scripts/env-fingerprint.sh", executable: true },
	{ rel: (l) => path.join(l.scripts, "verifier-tools.ts"), template: "scripts/verifier-tools.ts" },
];

function templateDir(): string {
	// src/store/scaffold.ts → <pkg>/templates
	return path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..", "templates");
}

/** 返回新建的文件列表(已存在的不动) */
export function ensureScaffold(l: RepoLayout): string[] {
	const created: string[] = [];
	for (const t of TEMPLATES) {
		const dest = t.rel(l);
		if (fs.existsSync(dest)) continue;
		fs.mkdirSync(path.dirname(dest), { recursive: true });
		fs.copyFileSync(path.join(templateDir(), t.template), dest);
		if (t.executable) fs.chmodSync(dest, 0o755);
		created.push(dest);
	}
	return created;
}

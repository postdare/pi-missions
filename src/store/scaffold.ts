/**
 * pi-missions · store/scaffold
 *
 * 把工作流文件铺进目标仓库(I6 · 仓库即规范):
 *   missions/README.md            工作流规则(Agent-first)
 *   missions/phases/*.md          相位提示词(进入该相位才加载,I8)
 *
 * **每次都按 templates/ 重铺,内容不同就覆盖。** 这里原来是"已存在就不动",
 * 理由是用户可以定制;真实代价是相位提示词会无声地停在铺下去的那一天。
 * 一个跑了两周的仓库,plan.md 落后主线 193 行 diff —— 缺的不只是新工具,
 * 还有基线红绿纪律、占位分支会被打回这些**判定相关**的告诫,而规划的模型
 * 只看得到磁盘上那份。提示词是扩展的一部分,不是用户数据。
 *
 * 定制的位置不在这里:改判定要动 core/,改文案要改 templates/ 提 PR。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { RepoLayout } from "./paths.ts";

const TEMPLATES: Array<{ rel: (l: RepoLayout) => string; template: string }> = [
	{ rel: (l) => path.join(l.root, "README.md"), template: "missions-README.md" },
	{ rel: (l) => path.join(l.phases, "define.md"), template: "phases/define.md" },
	{ rel: (l) => path.join(l.phases, "plan.md"), template: "phases/plan.md" },
	{ rel: (l) => path.join(l.phases, "do.md"), template: "phases/do.md" },
	{ rel: (l) => path.join(l.phases, "check.md"), template: "phases/check.md" },
	{ rel: (l) => path.join(l.phases, "act.md"), template: "phases/act.md" },
];

function templateDir(): string {
	// src/store/scaffold.ts → <pkg>/templates
	return path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..", "templates");
}

/**
 * 返回**实际写过**的文件列表(新建的 + 内容变了的)。
 * 内容一致就不碰 —— 不为了刷一遍把每个仓库的 mtime 搅乱。
 */
export function ensureScaffold(l: RepoLayout): string[] {
	const written: string[] = [];
	for (const t of TEMPLATES) {
		const dest = t.rel(l);
		const src = fs.readFileSync(path.join(templateDir(), t.template), "utf8");
		if (fs.existsSync(dest) && fs.readFileSync(dest, "utf8") === src) continue;
		fs.mkdirSync(path.dirname(dest), { recursive: true });
		fs.writeFileSync(dest, src, "utf8");
		written.push(dest);
	}
	return written;
}

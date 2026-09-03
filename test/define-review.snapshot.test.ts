/**
 * pi-missions · define-review 样式快照
 *
 * render.test.ts 只卡"宽度不变式"——盒子不裂、行不越界。
 * 它卡不住的:**样式悄悄变了**(标签改字、间距改动、缩进挪位)。
 * 这个测试把 DEFINE 范围确认页的当前渲染冻结成 golden file,观感变了就红;
 * 确认是想要的改动后,UPDATE_SNAPSHOTS=1 重新生成:
 *
 *   UPDATE_SNAPSHOTS=1 node --test test/define-review.snapshot.test.ts
 *
 * 快照存的是剥离 ANSI 后的纯文本(避免依赖具体色值,主题调整不炸);
 * 宽度不变式仍由 render.test.ts 负责,这里只看版面观感。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderDefineReview } from "../src/ui/define-review.ts";
import type { Definition } from "../src/store/mission.ts";

const here = dirname(fileURLToPath(import.meta.url));
const SNAP = join(here, "__snapshots__", "define-review.txt");
const UPDATE = process.env.UPDATE_SNAPSHOTS === "1";

const theme = {
	fg: (c: string, s: string) => `\x1b[90m${s}\x1b[0m`,
	bg: (_c: string, s: string) => s,
	bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

const definition: Definition = {
	constraints: ["不动 User 表", "沿用现有中间件顺序"],
	nonGoals: ["不做 refresh token 轮换", "不做多端登录互踢"],
	doneWhen: [
		{ id: "DW1", text: "access token 过期前 60s 内自动刷新,集成测试覆盖刷新竞态" },
		{ id: "DW2", text: "刷新失败时降级到登录页,且不丢当前路由的 query 参数" },
		{ id: "DW3", text: "这一行故意写得非常长,用来验证折行与悬挂缩进在窄终端下的表现是否正确——它应该被 wrap 而不是截断" },
	],
	verifySeam: "已有集成测试 test/auth/*",
	resolved: [{ q: "D1 用哪种方式?", a: "只放 sub+exp(推荐)" }],
	at: 0,
};

const GOAL = "把登录页的会话过期处理改成静默续期,过期后用户无感知,不再弹登录框";

const CASES: Array<{ name: string; width: number; focus: number; scroll: number; editing?: boolean; bare?: boolean }> = [];

for (const width of [56, 96]) {
	for (const focus of [0, 1, 5]) {
		CASES.push({ name: `focus=${focus} w=${width}`, width, focus, scroll: 0 });
	}
}
CASES.push({ name: "滚动 3 · w=96", width: 96, focus: 1, scroll: 3 });
CASES.push({ name: "拒绝意见输入态 · w=96", width: 96, focus: 1, scroll: 0, editing: true });
CASES.push({ name: "全空定义(占位行)· w=96", width: 96, focus: 2, scroll: 0, bare: true });

function renderCase(c: (typeof CASES)[number]): string {
	const r = renderDefineReview({
		theme,
		width: c.width,
		rows: 32,
		goal: c.bare ? "" : GOAL,
		definition: c.bare
			? { constraints: [], nonGoals: [], doneWhen: [], verifySeam: undefined, resolved: [], at: 0 }
			: definition,
		focus: c.focus,
		editing: c.editing ?? false,
		draft: c.editing ? "DW3 根本判不了,写清楚怎么测" : "",
		scroll: c.scroll,
	});
	const header = `── ${c.name} ──`;
	return header + "\n" + r.lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, "")).join("\n");
}

test("define-review:样式与快照一致", () => {
	const current = CASES.map(renderCase).join("\n\n") + "\n";
	if (UPDATE) {
		mkdirSync(dirname(SNAP), { recursive: true });
		writeFileSync(SNAP, current, "utf8");
		console.log(`快照已重生成: ${SNAP}(${CASES.length} 个用例)`);
		return;
	}
	const frozen = readFileSync(SNAP, "utf8");
	assert.equal(current, frozen, "define-review 观感变了。若是想要的改动:UPDATE_SNAPSHOTS=1 node --test test/define-review.snapshot.test.ts");
});

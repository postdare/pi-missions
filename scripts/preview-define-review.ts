/**
 * define-review 离线预览:不起 pi,直接把 DEFINE 范围确认页渲染到 stdout。
 *
 * 用法:
 *   node --experimental-strip-types scripts/preview-define-review.ts
 *   COLUMNS=56 node --experimental-strip-types scripts/preview-define-review.ts
 *   node --experimental-strip-types scripts/preview-define-review.ts --editing   # 模拟拒绝意见输入态
 */
import { renderDefineReview } from "../src/ui/define-review.ts";
import type { Definition } from "../src/store/mission.ts";

const theme = {
	fg: (c: string, s: string) => `\x1b[90m${s}\x1b[0m`,
	bg: (_c: string, s: string) => s,
	bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

const width = Number(process.env.COLUMNS) || 96;
const rows = 32;

const definition: Definition = {
	constraints: ["不动 User 表", "沿用现有中间件顺序"],
	nonGoals: ["不做 refresh token 轮换", "不做多端登录互踢"],
	doneWhen: [
		{ id: "DW1", text: "access token 过期前 60s 内自动刷新,集成测试覆盖刷新竞态" },
		{ id: "DW2", text: "刷新失败时降级到登录页,且不丢当前路由的 query 参数" },
		{ id: "DW3", text: "这一行故意写得非常长,验证窄终端下折行与悬挂缩进的表现" },
	],
	verifySeam: "已有集成测试 test/auth/*",
	resolved: [{ q: "令牌里放什么?", a: "只放 sub+exp(推荐)" }],
	at: 0,
};

const r = renderDefineReview({
	theme,
	width,
	rows,
	goal: "把登录页的会话过期处理改成静默续期,过期后用户无感知,不再弹登录框",
	definition,
	focus: 1,
	editing: process.argv.includes("--editing"),
	draft: process.argv.includes("--editing") ? "DW3 根本判不了,写清楚怎么测" : "",
	scroll: 0,
});
console.log(r.lines.join("\n"));

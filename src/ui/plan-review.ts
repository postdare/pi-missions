/**
 * pi-missions · ui/plan-review
 *
 * 冻结前的计划评审页(ctx.ui.custom 圆角盒内联页,与 status-view 同形态)。
 *
 * 它替换的是原来那个二值弹窗:弹窗里只塞得下目标 + AC 行 + "任务数:8",
 * 任务本体、里程碑、方案、**verify.sh 全文**一个字都看不到 ——
 * 等于让人批准一份没读过的合同。而拒绝之后返回的是一句死字符串,
 * planner 只收到 1 bit:不行。
 *
 * 所以这一页做两件事:
 *   ① 把整份计划摊开(五段,页签切换,各自滚动)
 *   ② 把"打回"变成一条**有内容的边** —— R 打回,随后收一段意见回传给 planner
 *
 * 打回意见不在这里收:ui.custom 里再嵌一层 ui.editor 会把 TUI 叠坏。
 * 这一页只负责区分批准、打回与取消,收意见由调用方(runtime.writePlan)在关页之后做。
 *
 * 渲染是纯函数 renderPlanReview(),与输入处理分离 —— 可单测,也能离线预览。
 */

import { Key, matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import {
	boxBot,
	boxRow,
	boxSep,
	boxTop,
	clip,
	bodyHeight,
	hintBar,
	pad,
	ruleLabel,
	tabs,
	windowLines,
	wrap,
} from "./chrome.ts";
import type { MissionState } from "../core/types.ts";
import { PLAN_REJECT_CAP } from "../core/review.ts";
import { allTasks, taskOrder, type MissionPlan } from "../store/mission.ts";
import { taskBlocks, type LineTheme } from "./dashboard.ts";

export type ReviewSection = "scope" | "approach" | "ac" | "tasks" | "script";

const SECTIONS: Array<{ id: ReviewSection; label: string }> = [
	{ id: "scope", label: "目标与边界" },
	{ id: "approach", label: "方案" },
	{ id: "ac", label: "验收标准" },
	{ id: "tasks", label: "任务" },
	{ id: "script", label: "verify.sh" },
];

export const SECTION_IDS = SECTIONS.map((s) => s.id);

export interface PlanReviewData {
	plan: MissionPlan;
	state: MissionState;
}

export interface PlanReviewView {
	theme: LineTheme & { bg?(color: string, s: string): string };
	width: number;
	rows: number;
	data: PlanReviewData;
	section: ReviewSection;
	scroll: number;
	/** 冻结之后只读打开(/mission plan):不显示批准/打回 */
	readOnly?: boolean;
}

const LABEL_W = 10;

function field(t: LineTheme, label: string, value: string): string {
	return t.fg("muted", pad(label, LABEL_W)) + value;
}

/** 会折行的「标签 值」,续行悬挂缩进 —— 目标与完成条件截断等于把最该看的丢掉 */
function fieldWrapped(t: LineTheme, label: string, value: string, width: number): string[] {
	const parts = wrap(value, Math.max(12, width - LABEL_W));
	return parts.map((p, i) => (i === 0 ? field(t, label, p) : " ".repeat(LABEL_W) + p));
}

/** 列表项:`  DW1  正文…`,续行对齐到正文列 */
function bullet(t: LineTheme, tag: string, text: string, width: number, color = "text"): string[] {
	const head = `  ${t.fg(color, tag)} `;
	const indent = " ".repeat(visibleWidth(`  ${tag} `));
	const parts = wrap(text, Math.max(12, width - visibleWidth(`  ${tag} `)));
	return parts.map((p, i) => (i === 0 ? head + p : indent + p));
}

// ─────────────────────────── 五段内容 ───────────────────────────

/** ① 目标与边界:人批准的就是这一段,漏看一条 nonGoal 后面就会打架 */
export function scopeLines(plan: MissionPlan, t: LineTheme, width: number): string[] {
	const lines = [...fieldWrapped(t, "目标", plan.goal || "(空)", width), ""];

	const f = plan.definition;
	if (!f) {
		// quick 档不经过 DEFINE:判定依据是 --verify 冻结的那条命令,没有完成条件清单
		lines.push(t.fg("dim", "(quick 档没有 DEFINE 相位:判定依据是 --verify 冻结的那条命令)"));
		return lines;
	}

	lines.push(ruleLabel(t as never, width, "完成条件"));
	for (const d of f.doneWhen) lines.push(...bullet(t, d.id, d.text, width, "accent"));

	if (f.nonGoals.length > 0) {
		lines.push("", ruleLabel(t as never, width, "明确不做"));
		for (const n of f.nonGoals) lines.push(...bullet(t, "✕", n, width, "dim"));
	}
	if (f.constraints.length > 0) {
		lines.push("", ruleLabel(t as never, width, "已确认的约束"));
		for (const c of f.constraints) lines.push(...bullet(t, "·", c, width, "dim"));
	}
	if (f.verifySeam) {
		lines.push("", ...fieldWrapped(t, "验证接缝", f.verifySeam, width));
	}
	if (f.resolved.length > 0) {
		lines.push("", ruleLabel(t as never, width, "DEFINE 问答"));
		for (const r of f.resolved) {
			lines.push(...bullet(t, "问", r.q, width, "muted"));
			lines.push(...bullet(t, "答", r.a, width, "text"));
		}
	}
	return lines;
}

/** ② 方案:L2 升级改的就是这一段;complex 必填 */
export function approachLines(plan: MissionPlan, t: LineTheme, width: number): string[] {
	const ap = plan.approach;
	if (!ap) {
		return [
			t.fg("dim", "(没有写方案)"),
			"",
			...wrap(
				plan.tier === "complex"
					? "complex 档必须写 approach —— 这份计划本不该走到评审页,先让 planner 补。"
					: "standard/quick 档方案可选。但没有方案说明,你只能凭 AC 猜他打算怎么做,L2 升级也没有落点。",
				width,
			).map((l) => t.fg("dim", l)),
		];
	}
	const lines = wrap(ap.summary, width);
	if (ap.decisions.length) lines.push("", ruleLabel(t as never, width, "决策"));
	for (const d of ap.decisions) {
		lines.push(...bullet(t, d.id, d.text, width, d.sticky ? "warning" : "accent"));
		for (const l of wrap(`为什么:${d.why}`, Math.max(12, width - 6))) lines.push(`      ${t.fg("dim", l)}`);
		if (d.rejected?.trim()) {
			for (const l of wrap(`否决:${d.rejected}`, Math.max(12, width - 6))) lines.push(`      ${t.fg("dim", l)}`);
		}
		if (d.sticky) lines.push(`      ${t.fg("warning", "难以逆转 —— 现在不同意,比做完再改便宜得多")}`);
	}
	return lines;
}

/** ③ 验收标准:冻结之后只读,这是最后一次改的机会 */
export function acReviewLines(plan: MissionPlan, t: LineTheme, width: number): string[] {
	if (plan.acceptanceCriteria.length === 0) return [t.fg("dim", "(无 AC)")];
	const lines: string[] = [t.fg("dim", "冻结后只读。基线 red = 现在必须是失败的,红→绿才算证据"), ""];
	for (const [i, ac] of plan.acceptanceCriteria.entries()) {
		if (i > 0) lines.push("");
		const base = ac.baseline ?? "red";
		const covers = ac.covers.length > 0 ? ` ← ${ac.covers.join(",")}` : "";
		lines.push(
			`${t.fg("accent", ac.id)}${t.fg("accent", covers)}  ${t.fg("dim", ac.verify)}  ` +
				t.fg(base === "red" ? "error" : "success", `baseline ${base}`),
		);
		for (const l of wrap(ac.text, Math.max(12, width - 4))) lines.push(`    ${l}`);
	}
	return lines;
}

/** ④ 任务:复用状态页的任务块,评审时它们都还是 pending */
export function taskReviewLines(plan: MissionPlan, state: MissionState, t: LineTheme, width: number): string[] {
	if (taskOrder(plan).length === 0) return [t.fg("dim", "(无任务)")];
	return taskBlocks(plan, state, t, width).flatMap((b) => b.lines);
}

/** ⑤ verify.sh:这份计划真正的可执行内核。不给看它,评审就是走过场 */
export function scriptLines(plan: MissionPlan, t: LineTheme, width: number): string[] {
	const raw = plan.verifyScript ?? "";
	if (!raw.trim()) return [t.fg("dim", "(verify.sh 为空)")];
	const out: string[] = [];
	for (const line of raw.split("\n")) {
		if (line === "") {
			out.push("");
			continue;
		}
		// 脚本按列有意义,折行而不是截断;续行不加缩进以免破坏对齐感知
		for (const l of wrap(line, width)) out.push(t.fg("dim", l));
	}
	return out;
}

export function sectionLines(view: PlanReviewView, inner: number): string[] {
	const { plan, state } = view.data;
	const t = view.theme;
	switch (view.section) {
		case "scope":
			return scopeLines(plan, t, inner);
		case "approach":
			return approachLines(plan, t, inner);
		case "ac":
			return acReviewLines(plan, t, inner);
		case "tasks":
			return taskReviewLines(plan, state, t, inner);
		case "script":
			return scriptLines(plan, t, inner);
	}
}

// ─────────────────────────── 整页 ───────────────────────────

export interface PlanReviewRender {
	lines: string[];
	/** 夹取后的滚动偏移,调用方写回 */
	scroll: number;
}

export function renderPlanReview(view: PlanReviewView): PlanReviewRender {
	const width = Math.max(40, view.width);
	const inner = width - 4;
	const t = view.theme;
	const { plan, state } = view.data;

	const rejections = state.planReview.rejections;
	const meta = view.readOnly
		? `${plan.acceptanceCriteria.length} 条 AC · ${taskOrder(plan).length} 个任务`
		: `打回 ${rejections}/${PLAN_REJECT_CAP}`;

	const lines: string[] = [
		boxTop(t as never, width, `${view.readOnly ? "计划" : "计划评审"} · ${state.missionId} · ${state.tier}`, meta),
		boxRow(t as never, width, clip(tabs(t as never, SECTIONS, view.section), inner)),
		boxSep(t as never, width),
	];

	// 上一次打回意见就摆在正文上方 —— 人要看的是"我上次说的改了没有"
	const lastNote = state.planReview.notes[state.planReview.notes.length - 1];
	if (!view.readOnly && lastNote) {
		for (const l of wrap(`上次打回:${lastNote}`, inner)) {
			lines.push(boxRow(t as never, width, t.fg("warning", l)));
		}
		lines.push(boxSep(t as never, width));
	}

	const body = sectionLines(view, inner);
	const height = bodyHeight(view.rows, lines.length, 6);
	const win = windowLines(body, view.scroll, height, null);
	for (const l of win.lines) lines.push(boxRow(t as never, width, clip(l, inner)));
	// 段落短于窗口时补空行,盒高不随页签跳动
	for (let i = win.lines.length; i < height; i++) lines.push(boxRow(t as never, width));

	lines.push(boxBot(t as never, width));

	const hints: Array<[string, string]> = view.readOnly
		? [
				["Tab", "切段"],
				["↑↓", "滚动"],
				["Esc", "关闭"],
			]
		: [
				["Enter", "批准冻结"],
				["R", "打回并写意见"],
				["Tab", "切段"],
				["↑↓", "滚动"],
				["Esc", "取消"],
			];
	const pos = body.length > height ? `${win.start + 1}-${win.end} of ${body.length}` : undefined;
	lines.push(hintBar(t as never, width, hints, pos));

	return { lines, scroll: win.offset };
}

// ─────────────────────────── 组件外壳 ───────────────────────────

export type PlanReviewResult =
	| { status: "approved" }
	| { status: "rejected" }
	| { status: "cancelled" };

/**
 * 打开评审页。返回人的裁决;打回意见由调用方在**关页之后**单独收 ——
 * 在 ui.custom 里嵌一层 ui.editor 会把 TUI 叠坏。
 */
export async function openPlanReview(
	ctx: any,
	getData: () => PlanReviewData,
	opts?: { readOnly?: boolean },
): Promise<PlanReviewResult> {
	if (!ctx.hasUI) return { status: "approved" };

	return await ctx.ui.custom(
		(tui: any, theme: PlanReviewView["theme"], _kb: any, done: (r: PlanReviewResult) => void) => {
			let section: ReviewSection = "scope";
			let scroll = 0;
			let closed = false;

			const close = (r: PlanReviewResult) => {
				if (closed) return;
				closed = true;
				done(r);
			};
			const switchTo = (delta: number) => {
				const i = SECTION_IDS.indexOf(section);
				section = SECTION_IDS[(i + delta + SECTION_IDS.length) % SECTION_IDS.length];
				scroll = 0;
				tui.requestRender();
			};

			return {
				render: (w: number) => {
					const r = renderPlanReview({
						theme,
						width: w,
						rows: Number(tui.terminal?.rows) || 24,
						data: getData(),
						section,
						scroll,
						readOnly: opts?.readOnly,
					});
					scroll = r.scroll;
					return r.lines;
				},
				invalidate: () => {},
				handleInput: (input: string) => {
					if (matchesKey(input, Key.escape) || matchesKey(input, "q")) return close({ status: "cancelled" });
					if (matchesKey(input, Key.tab) || matchesKey(input, Key.right)) return switchTo(1);
					if (matchesKey(input, Key.shift("tab")) || matchesKey(input, Key.left)) return switchTo(-1);
					if (matchesKey(input, Key.up)) {
						scroll = Math.max(0, scroll - 1);
						return tui.requestRender();
					}
					if (matchesKey(input, Key.down)) {
						scroll = scroll + 1;
						return tui.requestRender();
					}
					if (opts?.readOnly) return;
					if (matchesKey(input, Key.enter)) return close({ status: "approved" });
					if (matchesKey(input, "r")) return close({ status: "rejected" });
				},
			};
		},
	);
}

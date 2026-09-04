/**
 * pi-missions · ui/scout-view
 *
 * `mission_scout` 的工具调用块渲染。**只是行数组**,和本仓库其它 UI 一样 ——
 * pi-tui 的 `Component` 接口只要求 `render(width): string[]`(见 tui.d.ts),
 * 所以这里的壳只有三行,真正的渲染是下面两个纯函数,能单测也能离线预览。
 *
 * ── 为什么要自绘 ──
 *
 * 不注册渲染器时 pi 走兜底(`formatToolExecution`):工具名 + `JSON.stringify(args,
 * null, 2)` + 结果原文。对 `mission_scout` 来说那是 4 个问题 × 4 个字段 ≈ 30 行
 * JSON,把真正要看的进度顶到屏幕外 —— 而扇出恰恰是唯一一处"你会盯着工具块等"的地方。
 *
 * ── 分工 ──
 *
 * `content` 是给模型读的(信封),`details` 是给这里渲染的。两者刻意不同:
 * 模型要的是"结论 + 出处 + 别据未查明的写 AC",人要的是"哪几路回来了、谁还在跑"。
 * 把给人看的排版塞进 content 是白烧 token,把给模型的告诫塞进这里是噪音。
 *
 * 字形沿用仓库既有的一套(见 dashboard.ts 的 EV_ICON):✓ 查明 / ? 未查明 /
 * ● 进行中 / ○ 排队中。不引入新字形 —— `◌ ◍ ◑ ░ ▒` 这类在不少等宽字体里会糊成
 * 一个大圆盘(CLAUDE.md 的 UI 第四坑)。
 */

import type { Component } from "@earendil-works/pi-tui";
import type { ScoutFanoutProgress, ScoutFinding } from "../core/scout.ts";
import { clip, pad, wrap } from "./chrome.ts";
import type { LineTheme } from "./dashboard.ts";

/** 工具结果的 `details`。渲染层只认这个,不去解析 content 里的自然语言 */
export type ScoutToolDetails =
	| { kind: "progress"; progress: ScoutFanoutProgress }
	| { kind: "done"; round: number; findings: ScoutFinding[] };

const PLAIN: LineTheme = { fg: (_c, s) => s, bold: (s) => s };

/** id 列宽。S1..S4 两位足够,留一格空 */
const ID_W = 3;

export interface ScoutCallView {
	theme?: LineTheme;
	width: number;
	questions: { id: string; text: string }[];
}

/**
 * 调用块:标题 + 一行一个问题。
 *
 * 刻意**不印** why / assume —— 它们是给闸门和结论对照用的,而调用块会永远留在
 * 回滚记录里。一个问题一行,长了折行并悬挂到问题列(CLAUDE.md:问题正文属于
 * "一律折行"那一档,截断等于把最该看的丢掉)。
 */
export function renderScoutCall(v: ScoutCallView): string[] {
	const t = v.theme ?? PLAIN;
	const n = v.questions.length;
	const lines = [`${t.fg("accent", t.bold("mission_scout"))} ${t.fg("dim", `${n} 路只读侦查`)}`];
	const budget = Math.max(12, v.width - 2 - ID_W);
	for (const q of v.questions) {
		const parts = wrap(q.text, budget);
		lines.push(`  ${t.fg("dim", pad(q.id, ID_W))}${parts[0] ?? ""}`);
		for (const p of parts.slice(1)) lines.push(`  ${" ".repeat(ID_W)}${p}`);
	}
	return lines;
}

export interface ScoutResultView {
	theme?: LineTheme;
	width: number;
	/** pi 的展开态(默认折叠)。展开才印结论全文与出处 */
	expanded: boolean;
	details: ScoutToolDetails;
}

export function renderScoutResult(v: ScoutResultView): string[] {
	return v.details.kind === "progress"
		? progressLines(v.details.progress, v.theme ?? PLAIN, v.width)
		: doneLines(v.details.findings, v.theme ?? PLAIN, v.width, v.expanded);
}

/** 跑的过程中:一路一行,谁在跑一目了然。这块高度是临时的,可以摊开 */
function progressLines(p: ScoutFanoutProgress, t: LineTheme, width: number): string[] {
	const runningSet = new Set(p.running);
	const lines = [t.fg("dim", `扇出中 ${p.done}/${p.total} 路已回`)];
	for (const [id, act] of Object.entries(p.activity)) {
		const queued = act === "排队中";
		const icon = !runningSet.has(id) ? "✓" : queued ? "○" : "●";
		const color = !runningSet.has(id) ? "success" : queued ? "muted" : "accent";
		lines.push(clip(`  ${t.fg(color, icon)} ${t.fg("dim", pad(id, ID_W))}${t.fg("muted", act)}`, width));
	}
	return lines;
}

/**
 * 回来之后:一路一行的结论。
 *
 * 折叠态只印一行摘要 + 每路一行(结论截断)—— 工具块会永久留在回滚记录里,
 * 默认摊开整份结论会把对话冲散。要看全文按 pi 的展开键;
 * 而**真正该读它的是模型**,那份全文在 content 的信封里,不在这儿。
 */
function doneLines(findings: ScoutFinding[], t: LineTheme, width: number, expanded: boolean): string[] {
	const answered = findings.filter((f) => f.status === "answered");
	const surprises = answered.filter((f) => f.surprised).length;
	const head =
		`${findings.length} 路:查明 ${answered.length}` +
		(findings.length > answered.length ? ` · 未查明 ${findings.length - answered.length}` : "") +
		(surprises > 0 ? ` · 与假设有出入 ${surprises}` : "");
	const lines = [t.fg("dim", head)];

	for (const f of findings) {
		const ok = f.status === "answered";
		const icon = ok ? "✓" : "?";
		const color = ok ? (f.surprised ? "accent" : "success") : "warning";
		const head2 = `  ${t.fg(color, icon)} ${t.fg("dim", pad(f.id, ID_W))}`;
		const budget = Math.max(12, width - 2 - 2 - ID_W);
		if (!expanded) {
			// 折叠态:结论截断。这是次要账目行那一档 —— 全文在展开态和信封里
			const tag = ok && f.surprised ? `${t.fg("accent", "「与假设有出入」")} ` : "";
			lines.push(clip(`${head2}${tag}${clip(f.answer.replace(/\s+/g, " "), budget)}`, width));
			continue;
		}
		const hang = " ".repeat(2 + 2 + ID_W);
		const parts = wrap(f.answer.replace(/\s+/g, " "), budget);
		lines.push(clip(`${head2}${parts[0] ?? ""}`, width));
		for (const p of parts.slice(1)) lines.push(clip(hang + p, width));
		if (ok && f.surprised) lines.push(clip(`${hang}${t.fg("dim", `原假设:${f.assume}`)}`, width));
		if (f.citations.length) lines.push(clip(`${hang}${t.fg("muted", `出处 ${f.citations.join(", ")}`)}`, width));
	}
	return lines;
}

/**
 * pi-tui 的 Component 只要求 render(width) + invalidate() —— 壳就是把纯函数包一层。
 * invalidate 是给有缓存的组件清缓存用的(Text 缓存了按宽度折过的行);
 * 这里每次都现算,所以是空实现,不是漏了。
 */
class LineBlock implements Component {
	// 显式字段,**不用构造函数参数属性**(`constructor(private x)`)——
	// 本仓库没有构建步骤,pi 与 node --test 都靠 type stripping 直接跑 .ts,
	// 而参数属性是需要代码生成的语法,加载时就是 ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX。
	private readonly lines: (width: number) => string[];
	constructor(lines: (width: number) => string[]) {
		this.lines = lines;
	}
	render(width: number): string[] {
		return this.lines(width);
	}
	invalidate(): void {}
}

export function scoutCallComponent(args: unknown, theme: LineTheme): Component {
	const questions = Array.isArray((args as any)?.questions) ? (args as any).questions : [];
	return new LineBlock((width) =>
		renderScoutCall({
			theme,
			width,
			questions: questions.map((q: any, i: number) => ({
				id: String(q?.id ?? `S${i + 1}`),
				text: String(q?.text ?? ""),
			})),
		}),
	);
}

/**
 * 结果渲染器。**永远返回一个 Component,不返回 undefined** ——
 * pi 拿到返回值直接 `renderContainer.addChild(component)`(见 tool-execution.js 的
 * updateDisplay),给它 undefined 是在赌宿主的容错。认不出 details 的情况
 * (最常见的是被闸门拒掉的调用)就把 content 里那句话原样印出来:
 * 那句拒绝理由本来就是写给人看的,自绘一个"未知状态"框只会把它藏起来。
 */
export function scoutResultComponent(
	details: unknown,
	fallbackText: string,
	expanded: boolean,
	theme: LineTheme,
): Component {
	const d = details as ScoutToolDetails | undefined;
	if (!d || (d.kind !== "progress" && d.kind !== "done")) {
		return new LineBlock((width) =>
			fallbackText ? wrap(fallbackText, Math.max(12, width)).map((l) => clip(l, width)) : [],
		);
	}
	return new LineBlock((width) => renderScoutResult({ theme, width, expanded, details: d }));
}

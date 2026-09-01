/**
 * pi-missions · ui/panel
 *
 * /missions 主面板(ctx.ui.custom 非 overlay —— 编排器风格圆角盒内联页,
 * 替换编辑器区域,聊天记录留在上方,需 hasUI 守卫)。
 *
 *   ╭─ MISSIONS ───────────────────────────────── 3 个 mission ─╮
 *   │  任务  模型                                 输入以筛选…   │
 *   │                                                            │
 *   │ ▸ + 开始新任务  standard  任务列表 + 验证闸门  Ctrl+L 换档  │
 *   │                                                            │
 *   │   状态     更新    进度       档位      目标                │
 *   │ ▸ ● 执行   3min   ███░░ 3/8  standard  CMS 管理端重构      │
 *   ╰────────────────────────────────────────────────────────────╯
 *
 * 任务页:输入即筛选(筛选框在页签行右侧);首行「开始新任务」Ctrl+L 换档、Enter 开始;
 * 下方 mission 表格(状态/更新/进度/档位/目标),Enter 恢复,Ctrl+D 展开详情。
 * 模型页:角色 → 模型/thinking 两栏行,Enter 进入模型选择器(带过滤)。
 * Tab/Shift+Tab 切页(←→ 同效),Esc 关闭(任务页有筛选文本时先清空筛选)。
 *
 * 渲染是纯函数 renderPanel(),与输入处理分离 —— 可单测,也可离线预览。
 */

import { Key, matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import { nearThreshold, thresholdFor } from "../core/breaker.ts";
import { ROLE_OF } from "../core/machine.ts";
import { scanMissions, type ScannedMission } from "../store/evidence.ts";
import { readLog } from "../store/log.ts";
import { statePaths, type RepoLayout } from "../store/paths.ts";
import { costTotal, fmtDuration, nearBreakerWarn, PHASE_STYLE } from "./dashboard.ts";
import {
	boxBot,
	boxRow,
	boxTop,
	clip,
	contentBudget,
	CURSOR,
	hintBar,
	miniBar,
	pad,
	tabs,
	windowLines,
} from "./chrome.ts";
import { cycleThinking, ROLE_ORDER, type ModelsConfig } from "../roles/models.ts";
import type { Role } from "../core/types.ts";
import {
	filterModels,
	modelRows,
	modelsFooter,
	pickerRows,
	type ModelOption,
	type ModelsPageData,
} from "./models-page.ts";

interface Theme {
	fg(color: string, text: string): string;
	bg(color: string, text: string): string;
	bold(text: string): string;
}

const TIER_DESC: Array<{ id: string; desc: string }> = [
	{ id: "quick", desc: "单任务,不落盘,快速循环" },
	{ id: "standard", desc: "任务列表 + 验证闸门(默认)" },
	{ id: "complex", desc: "里程碑 + 独立验证 + 逐里程碑回归" },
];

const TIER_ORDER = TIER_DESC.map((t) => t.id);

type TierId = "quick" | "standard" | "complex";

/** 紧凑相对时间:表格里只有 7 列,"3min 前" 换成 "3min" */
function relTime(ts: number, now: number): string {
	const mins = Math.max(0, Math.round((now - ts) / 60_000));
	if (mins < 1) return "刚刚";
	if (mins < 60) return `${mins}min`;
	const hours = Math.floor(mins / 60);
	if (hours < 24) return `${hours}h`;
	return `${Math.floor(hours / 24)}d`;
}

/** 筛选:id/目标/相位/档位 的小写包含匹配 */
export function filterMissions(missions: ScannedMission[], query: string): ScannedMission[] {
	const q = query.trim().toLowerCase();
	if (!q) return missions;
	return missions.filter((m) =>
		`${m.missionId} ${m.plan?.goal ?? ""} ${m.state.phase} ${m.state.tier}`.toLowerCase().includes(q),
	);
}

// ─────────────────────────── 表格列 ───────────────────────────

const COL_CURSOR = 2; // 光标 "▸" + 空格
const COL_STATUS = 8; // "● 执行" 6 列 + 留白
const COL_UPDATED = 7; // "3min" 4 列 + 留白
const COL_PROGRESS = 12; // "█████ 10/12" 最宽 11 列 + 留白
const COL_TIER = 10; // "standard"
const BAR_W = 5;

/** 窄屏按重要性丢列:先丢档位,再丢进度 */
export function visibleCols(inner: number): { progress: boolean; tier: boolean } {
	return { tier: inner >= 76, progress: inner >= 48 };
}

function goalWidth(inner: number): number {
	const c = visibleCols(inner);
	return Math.max(
		8,
		inner - COL_CURSOR - COL_STATUS - COL_UPDATED - (c.progress ? COL_PROGRESS : 0) - (c.tier ? COL_TIER : 0),
	);
}

/** 表格列头(muted —— 比正文弱,但要比 dim 可读) */
export function tableHeader(t: Theme, inner = 92): string {
	const c = visibleCols(inner);
	return (
		" ".repeat(COL_CURSOR) +
		pad(t.fg("muted", "状态"), COL_STATUS) +
		pad(t.fg("muted", "更新"), COL_UPDATED) +
		(c.progress ? pad(t.fg("muted", "进度"), COL_PROGRESS) : "") +
		(c.tier ? pad(t.fg("muted", "档位"), COL_TIER) : "") +
		t.fg("muted", "目标")
	);
}

/**
 * 单个 mission 的表格行。临界预警(熔断边缘/换脑挂起)时状态列改 ⚠ 警告色。
 * selected 行加光标并整体加粗 —— 背景高亮由 boxRow 负责,这里只出内容。
 */
export function missionRow(m: ScannedMission, selected: boolean, t: Theme, inner: number, now: number): string {
	const s = m.state;
	const c = visibleCols(inner);
	const st = PHASE_STYLE[s.phase] ?? PHASE_STYLE.halted;
	const task = s.currentTask ? s.tasks[s.currentTask] : undefined;
	const critical = !!s.pendingHandoff || nearThreshold(task, s.tier);

	const icon = critical ? t.fg("warning", "⚠") : t.fg(st.color, st.icon);
	const label = critical ? t.fg("warning", st.label) : t.fg(st.color, st.label);
	const cursor = selected ? t.fg("accent", CURSOR) + " " : " ".repeat(COL_CURSOR);
	const status = pad(`${icon} ${label}`, COL_STATUS);
	const updated = pad(t.fg("dim", relTime(s.updatedAt, now)), COL_UPDATED);

	const doneCount = Object.values(s.tasks).filter((x) => x.status === "done").length;
	const total = s.taskOrder.length;
	const progress = c.progress
		? pad(
				total > 0 ? `${miniBar(t, doneCount, total, BAR_W)} ${t.fg("dim", `${doneCount}/${total}`)}` : t.fg("dim", "—"),
				COL_PROGRESS,
			)
		: "";
	const tier = c.tier ? pad(t.fg("dim", s.tier), COL_TIER) : "";
	const goal = clip(m.plan?.goal ?? t.fg("dim", "(计划损坏或缺失)"), goalWidth(inner));

	const row = `${cursor}${status}${updated}${progress}${tier}${goal}`;
	return selected ? t.bold(row) : row;
}

/**
 * 选中行的详情展开(Ctrl+D):id/档位/当前任务/成本/预警/升级历史/日志尾部。
 * 每行带一条 borderMuted 竖引导线,视觉上挂在被展开的那一行下面。
 */
export function detailLines(m: ScannedMission, t: Theme, inner: number, now: number, logTail: string[]): string[] {
	const s = m.state;
	const task = s.currentTask ? s.tasks[s.currentTask] : undefined;
	const planTask = s.currentTask
		? m.plan?.milestones.flatMap((x) => x.tasks).find((x) => x.id === s.currentTask)
		: undefined;
	const threshold = thresholdFor(s.tier);
	const cost = costTotal(s);
	const lines: string[] = [];
	// 引导线落在光标条那一列,展开内容与「状态」列对齐 —— 视觉上挂在被展开的行下面
	const guide = `${t.fg("borderMuted", "│")} `;
	const width = inner - COL_CURSOR;
	const push = (s2: string) => lines.push(guide + clip(s2, width));

	const bits: string[] = [`${s.missionId}`, s.tier, `phase=${s.phase}`];
	const roleHere = ROLE_OF[s.phase];
	if (roleHere) bits.push(roleHere);
	if (cost > 0) bits.push(`$${cost.toFixed(2)}`);
	if (m.plan?.createdAt) {
		bits.push(
			s.phase === "done" || s.phase === "halted"
				? `共 ${fmtDuration(m.plan.createdAt, s.updatedAt)}`
				: fmtDuration(m.plan.createdAt, now),
		);
	}
	push(t.fg("dim", bits.join(" · ")));

	if (s.currentTask && s.phase !== "done") {
		push(
			`${t.fg("accent", "▸")} ${s.currentTask}${planTask ? ` ${clip(planTask.title, 24)}` : ""} ${t.fg("dim", `· attempt ${task?.attempts ?? 0}/${threshold}`)}`,
		);
	}
	if (task && nearThreshold(task, s.tier)) push(t.fg("warning", nearBreakerWarn(task)));
	if (s.pendingHandoff) push(t.fg("warning", `⏸ 等待换脑: ${clip(s.pendingHandoff, width - 12)}`));
	if (task?.lastFailureReason && s.phase !== "done") push(t.fg("dim", `✗ ${clip(task.lastFailureReason, width - 4)}`));
	if (s.phase === "halted") {
		const last = s.escalation.history[s.escalation.history.length - 1];
		push(t.fg("error", `止于 L${s.escalation.level}${last ? ` · ${clip(last.reason, width - 10)}` : ""}`));
	}
	if (s.escalation.history.length > 0) {
		push(t.fg("muted", "升级历史"));
		for (const h of s.escalation.history.slice(-3)) {
			push(t.fg("dim", `  L${h.from}→L${h.to} ${h.taskId} · ${clip(h.reason, width - 16)}`));
		}
	}
	if (logTail.length > 0 && logTail[0] !== "(暂无日志)") {
		push(t.fg("muted", "日志"));
		for (const line of logTail) push(t.fg("dim", `  ${line}`));
	}
	return lines;
}

// ─────────────────────────── 纯渲染 ───────────────────────────

const PAGES = [
	{ id: "missions", label: "任务" },
	{ id: "models", label: "模型" },
] as const;

type PageId = (typeof PAGES)[number]["id"];

/** 提示条按当前模式查表 —— 三层嵌套三元读起来比它表达的东西复杂 */
const HINTS: Record<PageId | "picking", Array<[string, string]>> = {
	picking: [["↑↓", "选择"], ["Enter", "确认"], ["Backspace", "删字"], ["Esc", "取消"]],
	models: [["↑↓", "导航"], ["Enter", "选模型"], ["T", "thinking"], ["X", "清除"], ["Tab", "切页"], ["Esc", "关闭"]],
	missions: [["↑↓", "导航"], ["Enter", "选择"], ["Ctrl+L", "档位"], ["Ctrl+D", "详情"], ["Tab", "切页"], ["Esc", "关闭"]],
};

/** 模型选择器的子模式状态 */
type Picking = { role: Role; cursor: number; filter: string } | null;

export interface PanelView {
	theme: Theme;
	/** 组件被分配的列宽 */
	width: number;
	/** 终端总行数(算内容高度预算) */
	rows: number;
	now: number;
	page: PageId;
	missions: ScannedMission[];
	filter: string;
	/** 0 = 「开始新任务」行,1..n = 筛选后的 mission */
	selected: number;
	detail: boolean;
	tierIdx: number;
	roleIdx: number;
	listScroll: number;
	picking: Picking;
	/** 模型页数据;null = runtime 未接入或不在模型页 */
	models: ModelsPageData | null;
	/** 展开详情时,选中 mission 的日志尾部(由壳采好 —— 渲染层不碰磁盘) */
	logTail: string[];
}

export interface PanelRender {
	lines: string[];
	/** 窗口化后修正的滚动偏移,调用方需写回 */
	listScroll: number;
}

/** 筛选框(页签行右侧):有文本时 accent,空时 dim 占位 */
function filterField(t: Theme, filter: string): string {
	const cursor = t.fg("accent", "▏");
	return filter ? `${t.fg("muted", "筛选 ")}${t.fg("accent", filter)}${cursor}` : t.fg("dim", "输入以筛选任务…");
}

/** 页签行:左侧页签,右侧筛选框 */
function tabRow(t: Theme, inner: number, page: PageId, filter: string, showFilter: boolean): string {
	const left = tabs(t, PAGES as unknown as Array<{ id: string; label: string }>, page);
	if (!showFilter) return left;
	const right = filterField(t, filter);
	const gap = inner - visibleWidth(left) - visibleWidth(right);
	if (gap < 2) return left;
	return left + " ".repeat(gap) + right;
}

/** 一行内容 + 要不要铺选中背景 */
interface Row {
	text: string;
	highlight?: boolean;
}

/** 模型页内容(含选择器子模式)。选中行与任务页用同一种选中语言:整行背景 */
function modelsPageLines(v: PanelView, inner: number, budget: number): Row[] {
	const t = v.theme;
	if (!v.models) return [{ text: t.fg("dim", "模型配置不可用(runtime 未接入)") }];
	const d = v.models;
	const pick = v.picking;
	const plain = (xs: string[]): Row[] => xs.map((text) => ({ text }));
	if (pick) {
		const list = filterModels(d.models, pick.filter);
		const cur = d.config[pick.role];
		const cursor = Math.min(pick.cursor, Math.max(0, list.length - 1));
		// 选择器没有滚动状态,每次从 0 起算 + 光标锚点 —— 效果是深列表时光标贴底
		const all = pickerRows(list, cursor, cur, t);
		const w = windowLines(all, 0, Math.max(4, budget - 6), { start: cursor, end: cursor + 1 });
		const off = w.start;
		const rows: Row[] = w.lines.map((text, i) => ({ text, highlight: off + i === cursor }));
		return [
			...plain([
				`${t.bold(`为 ${pick.role} 选择模型`)}  ${t.fg("dim", `${list.length} 个可选`)}`,
				`${t.fg("muted", "过滤 ")}${pick.filter ? t.fg("accent", pick.filter) + t.fg("accent", "▏") : t.fg("dim", "(输入字符过滤)")}`,
				"",
				...(off > 0 ? [t.fg("dim", `   ↑ 之上还有 ${off} 个`)] : []),
			]),
			...rows,
			...plain(w.end < all.length ? [t.fg("dim", `   ↓ 之下还有 ${all.length - w.end} 个,继续输入过滤`)] : []),
		];
	}
	// modelRows 只在选中角色下面插一行说明,所以选中角色的行号恰好 = roleIdx
	const roles = modelRows(d, v.roleIdx, t, inner).map((text, i) => ({
		text,
		highlight: i === v.roleIdx,
	}));
	return [...roles, ...plain(modelsFooter(d, t))];
}

/** 面板全部行(含盒外提示条)。纯函数:进来的是视图对象,出去的是行数组 */
export function renderPanel(v: PanelView): PanelRender {
	const t = v.theme;
	const width = Math.max(40, v.width);
	const inner = width - 4; // 盒内宽(│ + 空格 … 空格 + │)
	const budget = contentBudget(v.rows);

	const hints = HINTS[v.picking ? "picking" : v.page];

	// ── 模型页 ──
	if (v.page === "models") {
		const out: string[] = [boxTop(t, width, "MISSIONS", v.models ? `${ROLE_ORDER.length} 个角色` : undefined)];
		out.push(boxRow(t, width, tabRow(t, inner, v.page, v.filter, false)));
		out.push(boxRow(t, width));
		for (const r of modelsPageLines(v, inner, budget - 3)) {
			out.push(boxRow(t, width, r.text, { highlight: r.highlight }));
		}
		out.push(boxBot(t, width));
		out.push(hintBar(t, width, hints));
		return { lines: out, listScroll: v.listScroll };
	}

	// ── 任务页 ──
	const filtered = filterMissions(v.missions, v.filter);
	const selected = Math.min(v.selected, filtered.length); // 0..filtered.length
	const meta = v.filter
		? `${filtered.length}/${v.missions.length} 个 mission`
		: v.missions.length > 0
			? `${v.missions.length} 个 mission`
			: undefined;

	const out: string[] = [boxTop(t, width, "MISSIONS", meta)];
	const row = (content = "") => out.push(boxRow(t, width, content));
	const hi = (content: string) => out.push(boxRow(t, width, content, { highlight: true }));

	row(tabRow(t, inner, v.page, v.filter, true));
	row();

	// 「开始新任务」行:Ctrl+L 换档,档位与说明内联;窄屏先丢档位说明,再丢换档提示
	const tier = TIER_ORDER[v.tierIdx];
	const startSel = selected === 0;
	const startHead =
		(startSel ? t.fg("accent", CURSOR) : " ") +
		` ${t.fg("accent", "+")} ${t.bold("开始新任务")}   ${t.fg("accent", tier)}`;
	// 「Ctrl+L 换档」右对齐固定在行尾(换档是这一行唯一的操作,位置要稳),
	// 档位说明填中间的剩余空间,不够就截断
	const startTail = "Ctrl+L 换档";
	const tailW = visibleWidth(startTail); // CJK 宽 2,不能用 .length
	const headW = visibleWidth(startHead);
	const descRoom = inner - headW - tailW - 4;
	const startLead =
		descRoom >= 6 ? `${startHead}  ${t.fg("dim", clip(TIER_DESC[v.tierIdx].desc, descRoom))}` : startHead;
	const startBody =
		inner - headW >= tailW + 2 ? pad(startLead, inner - tailW) + t.fg("dim", startTail) : startHead;
	if (startSel) hi(startBody);
	else row(startBody);
	row();
	row(tableHeader(t, inner));

	// 筛选后的表格行(含详情展开),窗口化保证选中行可见
	const all: Array<{ text: string; highlight: boolean }> = [];
	const ranges: Array<{ start: number; end: number }> = [];
	if (filtered.length === 0) {
		all.push({
			text: t.fg("dim", `  ${v.filter ? `无匹配「${clip(v.filter, 20)}」 —— Esc 清除筛选` : "暂无历史 mission —— Enter 从上面新建"}`),
			highlight: false,
		});
	}
	for (const [i, m] of filtered.entries()) {
		const start = all.length;
		const isSel = selected === i + 1;
		all.push({ text: missionRow(m, isSel, t, inner, v.now), highlight: isSel });
		if (v.detail && isSel) {
			for (const d of detailLines(m, t, inner, v.now, v.logTail)) all.push({ text: d, highlight: false });
		}
		ranges.push({ start, end: all.length });
	}

	const headRows = out.length + 1; // +1 是 boxBot
	const winH = Math.max(3, budget - headRows);
	const anchor = selected === 0 ? { start: 0, end: 0 } : (ranges[selected - 1] ?? null);
	const win = windowLines(
		all.map((x) => x.text),
		v.listScroll,
		winH,
		anchor,
	);
	for (const [i, line] of win.lines.entries()) {
		out.push(boxRow(t, width, line, { highlight: all[win.start + i]?.highlight }));
	}

	out.push(boxBot(t, width));

	// 位置指示:可见 mission 区间 / 筛选后总数
	let pos: string | undefined;
	if (filtered.length > 0 && all.length > winH) {
		const first = ranges.findIndex((r) => r.end > win.start);
		let last = first;
		for (let i = first; i < ranges.length && ranges[i].start < win.end; i++) last = i;
		pos = `${first + 1}-${last + 1} of ${filtered.length}`;
	}
	out.push(hintBar(t, width, hints, pos));
	return { lines: out, listScroll: win.offset };
}

// ─────────────────────────── 交互壳 ───────────────────────────

export interface PanelCallbacks {
	/** 在「开始新任务」行按 Enter:用当前档位开新任务(面板关闭,编辑器着色 + 预填命令) */
	onSelectTier: (tier: TierId) => void;
	/** 在 mission 行按 Enter:面板关闭,打开该 mission 的 detail 页 */
	onDetail: (missionId: string) => void;
	/** 「模型」页的数据与写入(runtime 提供);缺省则该页显示为不可用 */
	models?: ModelsBridge;
}

export interface ModelsBridge {
	getData(): ModelsPageData;
	/** selection=null 表示清除配置(回到跟随会话) */
	setModel(role: Role, selection: { provider: string; id: string } | null): void;
	setThinking(role: Role, thinking: string): void;
}

export async function openMissionsPanel(ctx: any, l: RepoLayout, cb: PanelCallbacks): Promise<void> {
	if (!ctx.hasUI) {
		const missions = scanMissions(l);
		if (missions.length === 0) {
			ctx.ui.notify("没有历史 mission。/mission new <目标> 新建", "info");
			return;
		}
		const lines = missions.map((m) => {
			const s = m.state;
			return `${s.missionId}  ${s.tier}  ${s.phase}  updated=${new Date(s.updatedAt).toISOString().slice(0, 16)}`;
		});
		ctx.ui.notify(lines.join("\n"), "info");
		return;
	}

	await ctx.ui.custom((tui: any, theme: Theme, _kb: any, done: (r: void) => void) => {
		let missions = scanMissions(l);
		/** 任务页筛选文本(输入即筛选) */
		let filter = "";
		/** 选中项:0 = 「开始新任务」行,1..n = 筛选后的 mission */
		let selected = 0;
		let detail = false;
		let tierIdx = 1; // 默认 standard
		let closed = false;
		let page: PageId = "missions";
		let roleIdx = 0;
		/** 表格的滚动偏移(行),render 里按选中行可见性调整 */
		let listScroll = 0;
		/** 非 null = 正在为该角色挑模型(选择器子模式) */
		let picking: Picking = null;
		/** 展开详情时选中 mission 的日志尾部。渲染层不碰磁盘,由这里采 */
		let logTail: string[] = [];
		let logFor: string | null = null;

		/** 换了 mission 就重读;同一个 mission 的内容交给 2s 定时器刷 */
		const syncLog = (id: string | null, force = false) => {
			if (!id) {
				logTail = [];
				logFor = null;
				return;
			}
			if (id === logFor && !force) return;
			logFor = id;
			try {
				logTail = readLog(statePaths(l, id).logMd).trim().split("\n").filter(Boolean).slice(-5);
			} catch {
				logTail = [];
			}
		};

		const refresh = () => {
			try {
				missions = scanMissions(l);
			} catch {
				/* keep last good */
			}
			syncLog(logFor, true);
			if (!closed) tui.requestRender();
		};
		const timer = setInterval(refresh, 2_000);

		const close = () => {
			if (closed) return;
			closed = true;
			clearInterval(timer);
			done(undefined);
		};

		return {
			render: (w: number) => {
				const selectedMission = detail ? filterMissions(missions, filter)[selected - 1] : undefined;
				syncLog(selectedMission?.missionId ?? null);
				const r = renderPanel({
					theme,
					width: w,
					rows: Number(tui.terminal?.rows) || 24,
					now: Date.now(),
					page,
					missions,
					filter,
					selected,
					detail,
					tierIdx,
					roleIdx,
					listScroll,
					picking,
					// 只有模型页需要它:getData() 会读 models.json + 重扫模型目录,
					// 放在任务页每帧跑一遍是纯浪费
					models: page === "models" && cb.models ? cb.models.getData() : null,
					logTail,
				});
				listScroll = r.listScroll;
				return r.lines;
			},
			invalidate: () => {},
			handleInput: (input: string) => {
				// ── 模型选择器子模式 ──
				const pick = picking;
				if (pick) {
					const list = cb.models ? filterModels(cb.models.getData().models, pick.filter) : [];
					if (matchesKey(input, Key.escape)) {
						picking = null;
						return tui.requestRender();
					}
					if (matchesKey(input, Key.up)) {
						picking = { ...pick, cursor: Math.max(0, pick.cursor - 1) };
						return tui.requestRender();
					}
					if (matchesKey(input, Key.down)) {
						picking = { ...pick, cursor: Math.min(Math.max(0, list.length - 1), pick.cursor + 1) };
						return tui.requestRender();
					}
					if (matchesKey(input, Key.enter)) {
						const m = list[pick.cursor];
						if (m) cb.models?.setModel(pick.role, { provider: m.provider, id: m.id });
						picking = null;
						return tui.requestRender();
					}
					if (matchesKey(input, Key.backspace)) {
						picking = { ...pick, filter: pick.filter.slice(0, -1), cursor: 0 };
						return tui.requestRender();
					}
					// 可打印字符 → 过滤
					if (input.length === 1 && input >= " " && input !== "\x7f") {
						picking = { ...pick, filter: pick.filter + input, cursor: 0 };
						return tui.requestRender();
					}
					return;
				}

				if (matchesKey(input, Key.escape)) {
					// 任务页有筛选文本时,第一次 Esc 先清筛选
					if (page === "missions" && filter) {
						filter = "";
						selected = 0;
						return tui.requestRender();
					}
					return close();
				}

				// ── 页签切换:Tab / Shift+Tab,←→ 作为别名保留 ──
				const flipPage = (step: number) => {
					page = PAGES[(PAGES.findIndex((p) => p.id === page) + step + PAGES.length) % PAGES.length].id;
					return tui.requestRender();
				};
				if (matchesKey(input, Key.tab) || matchesKey(input, Key.right)) return flipPage(1);
				if (matchesKey(input, Key.shift("tab")) || matchesKey(input, Key.left)) return flipPage(-1);

				// ── 模型页(无筛选,T/X 是快捷键) ──
				if (page === "models") {
					const role = ROLE_ORDER[roleIdx];
					if (matchesKey(input, Key.up)) {
						roleIdx = Math.max(0, roleIdx - 1);
						return tui.requestRender();
					}
					if (matchesKey(input, Key.down)) {
						roleIdx = Math.min(ROLE_ORDER.length - 1, roleIdx + 1);
						return tui.requestRender();
					}
					if (matchesKey(input, Key.enter)) {
						if (cb.models) picking = { role, cursor: 0, filter: "" };
						return tui.requestRender();
					}
					if (matchesKey(input, "t")) {
						const cur = cb.models?.getData().config[role]?.thinking;
						cb.models?.setThinking(role, cycleThinking(cur, role));
						return tui.requestRender();
					}
					if (matchesKey(input, "x")) {
						cb.models?.setModel(role, null);
						return tui.requestRender();
					}
					if (matchesKey(input, "q")) return close();
					return;
				}

				// ── 任务页:输入即筛选,动作走 Enter/Ctrl+L/Ctrl+D ──
				const filtered = filterMissions(missions, filter);
				if (matchesKey(input, Key.up)) {
					selected = Math.max(0, selected - 1);
					return tui.requestRender();
				}
				if (matchesKey(input, Key.down)) {
					selected = Math.min(filtered.length, selected + 1);
					return tui.requestRender();
				}
				// 档位循环。Ctrl+L 在 pi 全局是"打开模型选择器",但面板是替换编辑器的
				// 自定义组件(ui.setFocus 指向它),按键先到这里,不会触发全局那条。
				if (matchesKey(input, Key.ctrl("l"))) {
					tierIdx = (tierIdx + 1) % TIER_ORDER.length;
					return tui.requestRender();
				}
				if (matchesKey(input, Key.ctrl("d"))) {
					if (selected > 0) {
						detail = !detail;
						return tui.requestRender();
					}
					return;
				}
				if (matchesKey(input, Key.enter)) {
					if (selected === 0) {
						close();
						cb.onSelectTier(TIER_ORDER[tierIdx] as TierId);
						return;
					}
					const m = filtered[selected - 1];
					if (!m) return;
					close();
					cb.onDetail(m.missionId);
					return;
				}
				if (matchesKey(input, Key.backspace)) {
					filter = filter.slice(0, -1);
					selected = 0;
					listScroll = 0;
					return tui.requestRender();
				}
				// 可打印字符 → 筛选(IME 组合字符 length>1,暂时不支持,与模型选择器一致)
				if (input.length === 1 && input >= " " && input !== "\x7f") {
					filter += input;
					selected = 0;
					listScroll = 0;
					return tui.requestRender();
				}
			},
		};
	});
}

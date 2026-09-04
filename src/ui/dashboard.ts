/**
 * pi-missions · ui/dashboard
 *
 * 状态信息的纯渲染层。产出两种形态:
 *   - 分段的行数组(概览/验收/任务/日志)→ status-view.ts 按栏宽拼成双栏内联页
 *   - renderStatusDashboard:拼接所有段落的扁平文本 → 非 TUI 环境的 entry 卡片
 * 与 runtime 解耦,纯函数,可单测。
 */

import { visibleWidth } from "@earendil-works/pi-tui";
import type { InconclusiveCause, MissionState } from "../core/types.ts";
import type { LiveScoutState } from "../core/scout.ts";
import { ROLE_OF } from "../core/machine.ts";
import { nearThreshold, thresholdFor } from "../core/breaker.ts";
import type { EvidenceRecord } from "../store/evidence.ts";
import type { CheckStage, CheckState, VerifierStatus } from "../store/check.ts";
import { findTask, type MissionPlan } from "../store/mission.ts";
import { clip, miniBar, pad, wrap } from "./chrome.ts";

/**
 * 无结论成因 → 给人看的一句话。别用万能兜底:
 * 核验模型 400 时说"环境可能漂移",人就会去查 git 状态而不是去查 models.json(真实事故)。
 *
 * 成因是可选字段(第一次无结论之前没有值),所以留一条 undefined 的入口 ——
 * 但它只兜 undefined,不兜"表里没有的成因":那种情况要在编译期就被 Record 挡住。
 */
const INCONCLUSIVE_HINT: Record<InconclusiveCause, string> = {
	evidence: "证据没采到",
	judge: "核验裁判不可用",
};

function inconclusiveHint(cause: InconclusiveCause | undefined): string {
	return cause ? INCONCLUSIVE_HINT[cause] : "证据没采到";
}

export interface EvidenceSummary {
	/** acId/verify 分支 → 最近一次判定 */
	latest: Record<string, EvidenceRecord>;
}

/**
 * 行构造器的可选主题。传了就上色(TUI 的 status-view),不传就出纯文本
 * (renderStatusDashboard → 非 TUI 环境的 entry 卡片)—— 同一份内容两种形态。
 */
export interface LineTheme {
	fg(color: string, s: string): string;
	bold(s: string): string;
}

/** 无主题时的恒等着色器 —— 让下面的代码不必到处写 t ? ... : ... */
const PLAIN: LineTheme = { fg: (_c, s) => s, bold: (s) => s };

/** 对齐的「标签 值」行:标签占固定列,muted;比 "key: value" 散文好扫 */
const LABEL_W = 10;
function field(t: LineTheme, label: string, value: string): string {
	return t.fg("muted", pad(label, LABEL_W)) + value;
}

/**
 * 会折行的「标签 值」:续行悬挂缩进到值那一列。
 * 目标 / 失败原因这类长句必须折行 —— 截断等于把最该看的东西丢掉。
 */
function fieldWrapped(
	t: LineTheme,
	label: string,
	value: string,
	width: number,
	maxLines: number,
	color?: string,
): string[] {
	const paint = (x: string) => (color ? t.fg(color, x) : x);
	const parts = wrap(value, Math.max(12, width - LABEL_W), maxLines);
	return parts.map((part, i) =>
		i === 0 ? field(t, label, paint(part)) : " ".repeat(LABEL_W) + paint(part),
	);
}

const EV_ICON: Record<string, string> = { pass: "✓", fail: "✗", inconclusive: "?" };
const STAGE_LABELS: Record<CheckStage, string> = {
	preparing: "准备环境",
	running_scripts: "执行脚本",
	running_verifier: "独立核验",
	// 人在等你点,不是模型在跑。曾经这里复用 running_verifier,widget 就显示
	// "独立核验 17m7s" —— 把"等人"说成"等模型",人自然不知道该去点什么。
	awaiting_human: "等待你终审",
	judging: "生成判定",
	completed: "完成",
	error: "异常",
};

/**
 * 独立核验的状态标签。这里原来直接把枚举值印出去,于是 widget 上是一行
 * `独立核验 running · 1m34s` —— 界面其余部分全是中文,只有这一格漏出英文。
 */
const VERIFIER_LABELS: Record<VerifierStatus, string> = {
	pending: "待启动",
	running: "核验中",
	completed: "已完成",
	skipped: "已跳过",
	timeout: "超时",
	degraded: "已降级",
	failed: "失败",
};

/**
 * 把 activity 里的绝对路径压成尾部两段。
 *
 * verifier 报的是 `读取 /Users/kim/Projects/todo-list/internal/keymap/keymap.go`,
 * 而 widget 只有几十列 —— 整条印出去,真正有信息的文件名恰好被挤掉。
 * 前缀对读的人是零信息(他就在这个仓库里),尾部两段才是。
 */
export function shortenActivity(activity: string): string {
	return activity.replace(/(^|\s)(\/[^\s]+)/g, (_m, lead: string, abs: string) => {
		const parts = abs.split("/").filter(Boolean);
		if (parts.length <= 2) return `${lead}${abs}`;
		return `${lead}…/${parts.slice(-2).join("/")}`;
	});
}

export function costTotal(state: MissionState): number {
	return Object.values(state.cost).reduce((a, b) => a + (b ?? 0), 0);
}

/** 全角色 token 合计(个)。与美元账并列:网关不报价时只有它是真的 */
export function tokenTotal(state: MissionState): number {
	return Object.values(state.tokens).reduce(
		(a, u) => a + (u ? u.input + u.output + u.cacheRead + u.cacheWrite : 0),
		0,
	);
}

/** token 数的紧凑格式:1234 → 1.2k */
export function formatTokens(n: number): string {
	return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`;
}

export function fmtDuration(fromMs: number, nowMs: number): string {
	const mins = Math.max(0, Math.round((nowMs - fromMs) / 60_000));
	if (mins < 60) return `${mins}min`;
	return `${Math.floor(mins / 60)}h${mins % 60}m`;
}

export function fmtCheckDuration(durationMs: number): string {
	if (durationMs < 1000) return `${Math.max(0, Math.floor(durationMs))}ms`;
	if (durationMs < 10_000) {
		return `${(durationMs / 1000).toFixed(1).replace(/\.0$/, "")}s`;
	}
	const seconds = Math.max(0, Math.floor(durationMs / 1000));
	if (seconds < 60) return `${seconds}s`;
	return `${Math.floor(seconds / 60)}m${seconds % 60}s`;
}

/** CHECK 运行态摘要,供状态页与非 TUI 卡片复用。 */
export function checkProgressLines(
	check: CheckState,
	now = Date.now(),
	t: LineTheme = PLAIN,
	width = 96,
): string[] {
	const elapsed = fmtCheckDuration(
		check.stage === "completed" || check.stage === "error"
			? check.updatedAt - check.startedAt
			: now - check.startedAt,
	);
	const lines = [
		field(t, "验证阶段", `${t.fg("accent", STAGE_LABELS[check.stage])} ${t.fg("dim", `· ${elapsed}`)}`),
	];
	if (check.currentBranch) {
		lines.push(field(t, "正在执行", t.fg("accent", check.currentBranch)));
	}
	if (check.completedBranches.length > 0) {
		const completed = check.completedBranches
			.map((b) => {
				const icon = EV_ICON[b.status] ?? "?";
				const color = EV_COLOR[b.status] ?? "dim";
				const duration = b.durationMs == null ? "" : ` ${fmtCheckDuration(b.durationMs)}`;
				return t.fg(color, `${icon} ${b.acId}${duration}`);
			})
			.join(t.fg("dim", " · "));
		lines.push(...fieldWrapped(t, "已完成", completed, width, 3));
	}
	if (check.verifier && check.verifier.status !== "pending") {
		const v = check.verifier;
		// 跑起来之后 durationMs 还没有值(它只在结束时写),那时用 startedAt 现算 ——
		// 否则一个跑了两分钟的核验在卡上是没有时长的,看不出它是在干活还是卡住了。
		const ms = v.durationMs ?? (v.startedAt == null ? null : now - v.startedAt);
		const bits = [VERIFIER_LABELS[v.status] ?? v.status];
		if (ms != null) bits.push(fmtCheckDuration(ms));
		// 轮数与调用数是"它真的在干活"的唯一证据 —— 一个 0 调用的核验和一个
		// 22 次调用的核验都显示 running,但前者是降级前兆,后者是正常工作。
		if (v.turns) bits.push(`${v.turns} 轮`);
		if (v.toolCalls) bits.push(`${v.toolCalls} 次调用`);
		lines.push(field(t, "独立核验", `${t.fg("accent", bits[0])}${t.fg("dim", ` · ${bits.slice(1).join(" · ")}`)}`));
		// 当前动作只在跑着的时候有意义;结束了再印一条"读取 xx.go"是误导。
		if (v.status === "running" && v.activity) {
			lines.push(...fieldWrapped(t, "", shortenActivity(v.activity), width, 3, "dim"));
		}
	}
	if (check.error) lines.push(...fieldWrapped(t, "异常", check.error, width, 3, "error"));
	return lines.map((line) => clip(line, width));
}

// ─────────────────────────── 常驻状态条(主题化卡片) ───────────────────────────

/**
 * 相位的图标/颜色/中文名 —— panel.ts、status-view.ts 与状态条共用同一套。
 *
 * 图标只从「空心圆 / 空心菱形 / 实心圆 / 实心菱形 / 勾 / 叉」里选:
 * ◌ ◍ ◑ 这类字形在不少等宽字体里会被渲染成又大又糊的圆盘,别再往回加。
 * 空心 → 实心表示"从想清楚到动手",act 与 do 同形靠颜色区分(警告色)。
 */
export const PHASE_STYLE: Record<string, { icon: string; color: string; label: string }> = {
	define: { icon: "○", color: "accent", label: "定义" },
	plan: { icon: "◇", color: "accent", label: "规划" },
	do: { icon: "●", color: "accent", label: "执行" },
	check: { icon: "◆", color: "accent", label: "判定" },
	act: { icon: "●", color: "warning", label: "调整" },
	done: { icon: "✓", color: "success", label: "完成" },
	halted: { icon: "✕", color: "error", label: "熔断" },
};

/** 熔断临界的预警文案。widget 卡片与 /missions 详情页共用,别再各抄一份 */
export function nearBreakerWarn(task: { sameSignatureCount: number }): string {
	return `⚠ 同一失败签名 ×${task.sameSignatureCount},再失败一次将升级`;
}

/** 相位徽标:● 执行(带色);plain 形态退化成 "● 执行" 纯文本 */
export function phaseBadge(t: LineTheme, phase: string): string {
	const st = PHASE_STYLE[phase] ?? PHASE_STYLE.halted;
	return t.fg(st.color, `${st.icon} ${st.label}`);
}

/**
 * id 的显示形态:只剥日期前缀。`2026-09-03-mission-mtl9aicc` → `mission-mtl9aicc`。
 *
 * **别改成取末段**(`split("-").pop()`)—— id 的构造是 `<日期>-<slugify(goal)>`
 * (`runtime.ts` 的 newMission),拉丁 goal 的 id 本身就是 goal,取末段等于把它扔了:
 * `2026-09-03-migrate-auth-to-jwt` 只剩 `jwt`,没有日期前缀的 `auth-refactor`
 * 还会被砍成 `refactor`。中文 goal 才落到 `mission-<base36>` 那个无信息的兜底形态。
 * 日期能从同一行的时长读出来,而 id 唯一的机器用途是拼 missions/state/<id>/ 的
 * 路径 —— 前缀补回去就行。
 */
export function shortId(missionId: string): string {
	return missionId.replace(/^\d{4}-\d{2}-\d{2}-/, "");
}

/**
 * goal 上屏所需的最小列数(CJK 宽 2,约合 12 个汉字)。低于这个数就整条不显示:
 * `首屏双…` 认不出是哪个 mission,还白占列。
 */
const GOAL_MIN = 24;

/**
 * 主题化状态卡片(输入框上方)。结构:
 *   行1: 短id(accent 粗体) · 档位(dim) · 相位(带色)  goal(截断,占满剩余列) …… 时长+成本(右对齐)
 *   行2: ▸ T2 任务标题(按实际宽度折行,续行悬挂到标题列) · 进度条(多任务) · attempt(≥2 才显示)
 *   行3: 判定进度(CHECK 相位,缩进成任务行的子行)
 *   行4+: 预警(熔断/无结论/换脑,警告色)
 *
 * **这张卡的高度是永久成本** —— 它不是一条消息,是常驻 chrome,多出来的每一行都从
 * 聊天区永久扣掉。所以两条规矩:
 *   ① goal 用 `clip` 截断,是全卡唯一允许截断的字段。它全程不变,只需要够认出
 *     "这是哪个 mission";全文在 `/mission status` 的概览里按 `wrap` 折行显示。
 *     曾经这里用过 `wrap`,结果 COLUMNS=56 + 一个正常长度的中文 goal → 12 行常驻。
 *   ② 每一行出栈前都过 `clip(…, width)`。越界不是掉字,是炸 TUI 主循环
 *     (CLAUDE.md「UI 层的四个坑」),而这里的 goal/标题/换脑原因都是外部输入。
 *
 * 相位图标是 `◆`(判定)时,不要在别处再放 `◆` —— 一屏三个同形字符三种含义。
 */
export function renderWidgetCard(
	theme: LineTheme,
	plan: MissionPlan,
	state: MissionState,
	now = Date.now(),
	width = 120,
	checkState?: CheckState | null,
	scout?: LiveScoutState | null,
): string[] {
	const task = state.currentTask ? findTask(plan, state.currentTask) : undefined;
	const t = state.currentTask ? state.tasks[state.currentTask] : undefined;
	const threshold = thresholdFor(state.tier);
	const done = Object.values(state.tasks).filter((x) => x.status === "done").length;
	const total = state.taskOrder.length;
	const cost = costTotal(state);
	const sep = theme.fg("dim", " · ");

	// 行 1:左半 + 右对齐(时长/成本)。角色不显示 —— ROLE_OF 是 phase 的纯函数,
	// ● 执行 恒等于 executor,同一个事实说两遍。
	// id 前不再放 ◆:CHECK 的相位图标就是 ◆,同一行两个 ◆ 是两个意思。
	const left = [
		theme.fg("accent", theme.bold(shortId(state.missionId))),
		theme.fg("dim", state.tier),
		phaseBadge(theme, state.phase),
	].join(sep);

	const rightBits: string[] = [];
	const elapsed = plan.createdAt ? fmtDuration(plan.createdAt, now) : null;
	if (elapsed && elapsed !== "0min") rightBits.push(theme.fg("dim", elapsed));
	if (cost >= 0.005) rightBits.push(theme.fg("accent", `$${cost.toFixed(2)}`));
	else {
		// 网关不报价时美元恒 0,token 才是真实消耗
		const tok = tokenTotal(state);
		if (tok > 0) rightBits.push(theme.fg("accent", `${formatTokens(tok)} tok`));
	}
	const right = rightBits.join(" ");

	const leftW = visibleWidth(left);
	const rightW = visibleWidth(right);
	const lines: string[] = [];

	// goal 填左半与右侧账目之间的空当;预算 = 全宽 − 左半 − 一个空格 − 右侧 − 两格间隙。
	// 装不下就整条不显示(见文件头 ①):goal 是常量字段,不值得用高度去换。
	const goalBudget = width - leftW - 1 - rightW - (rightW > 0 ? 2 : 0);
	const goal = plan.goal && goalBudget >= GOAL_MIN ? clip(plan.goal, goalBudget) : "";
	const head = goal ? `${left} ${goal}` : left;
	const headW = visibleWidth(head);
	lines.push(rightW > 0 && headW + rightW < width ? pad(head, width - rightW) + right : clip(head, width));

	// 行 2 的尾部固定位:进度条(多任务才有)+ attempt。
	// attempt 在 1/N 时收起 —— 跑到 1 还什么都没失败,常显只会训练出选择性失明,
	// 而真正该跳出来的临界另有警告行。
	const tailBits: string[] = [];
	if (total > 1) tailBits.push(`${miniBar(theme, done, total, 8)} ${theme.fg("dim", `${done}/${total}`)}`);
	if (t && ["do", "check", "act"].includes(state.phase) && t.attempts >= 2) {
		const near = nearThreshold(t, state.tier);
		tailBits.push(theme.fg(near ? "warning" : "dim", `attempt ${t.attempts}/${threshold}`));
	}
	const tail = tailBits.join(sep);
	const tailW = tail ? visibleWidth(tail) + visibleWidth(sep) : 0;

	// 行 2:▸ T2 任务标题。标题按实际剩余宽度折行(CLAUDE.md:任务标题属于
	// "一律折行"那一档),续行悬挂到标题列 —— 悬挂量必须等于 "  " + 前缀的实际宽度,
	// 差一列不会报错,只会看着像另起了一段。
	if (task) {
		const prefix = `${theme.fg("accent", "▸")} ${task.id} `;
		const prefixW = visibleWidth(prefix);
		const titleBudget = Math.max(12, width - 2 - prefixW - tailW);
		// 折两行封顶。标题该折不该截(CLAUDE.md),但这张卡的高度是永久成本:
		// 56 列时预算只剩 18,一个正常标题能折出 4 行常驻。宽 ≥72 基本折不到第二行,
		// 真折到第三行的窄终端里,全文在 /mission status 的任务区。
		const titleParts = wrap(task.title, titleBudget, 2);
		lines.push(clip(`  ${prefix}${titleParts[0]}${tail ? sep + tail : ""}`, width));
		const hang = " ".repeat(2 + prefixW);
		for (const part of titleParts.slice(1)) lines.push(clip(hang + part, width));
	} else if (state.currentTask) {
		// 计划里查不到这个任务(plan 与 state 漂移):id 照显,别把整行吞掉
		lines.push(clip(`  ${theme.fg("accent", "▸")} ${state.currentTask}${tail ? sep + tail : ""}`, width));
	} else if (tail) {
		lines.push(clip(`  ${tail}`, width));
	}

	// 判定进度:缩进成任务行的子行。刻意不带图标 —— 相位徽标已经是 ◆ 判定,
	// 这里再放一个 ◆ 就是一屏三个同形字符(见文件头)。
	if (state.phase === "check" && checkState?.taskId === state.currentTask) {
		const stage = STAGE_LABELS[checkState.stage];
		const elapsed = fmtCheckDuration(now - checkState.startedAt);
		const current = checkState.currentBranch ? ` · ${checkState.currentBranch}` : "";
		const doneCount = checkState.completedBranches.length;
		const completed = doneCount > 0 ? ` · 脚本 ${doneCount} 项` : "";
		lines.push(
			clip(`    ${theme.fg("accent", stage)} ${theme.fg("dim", `${elapsed}${completed}${current}`)}`, width),
		);
	}

	// 侦查扇出进度:与判定进度同一个位置、同一个形状(缩进 4、无图标)。
	// **只占一行** —— 每路一行的话 4 路就是 4 行常驻,而这张卡的高度是永久成本;
	// 逐路的明细在工具调用块里(ui/scout-view.ts),那儿的高度是临时的。
	if (scout && scout.progress.total > 0) {
		const p = scout.progress;
		const bar = miniBar(theme, p.done, p.total, 8);
		const el = fmtCheckDuration(now - scout.startedAt);
		// 点名一路仍在跑的 —— 只报 x/y 的话,卡住的时候看不出卡在哪
		const first = p.running[0];
		const who = first ? ` · ${first} ${p.activity[first] ?? ""}`.trimEnd() : "";
		lines.push(
			clip(`    ${theme.fg("accent", "侦查扇出")} ${bar} ${theme.fg("dim", `${p.done}/${p.total} · ${el}${who}`)}`, width),
		);
	}

	// 预警行(警告色)。三条都必须过 clip:窄终端下 pendingHandoff 的
	// "promote standard→complex on T12" 在 56 列就越界,而越界会炸 TUI。
	if (t && nearThreshold(t, state.tier)) {
		lines.push(clip(theme.fg("warning", `  ${nearBreakerWarn(t)}`), width));
	}
	if (t && t.inconclusiveStreak > 0) {
		lines.push(
			clip(
				theme.fg(
					"warning",
					`  ⚠ 连续 ${t.inconclusiveStreak} 次无法判定(${inconclusiveHint(t.lastInconclusiveCause)})`,
				),
				width,
			),
		);
	}
	if (state.pendingHandoff) {
		lines.push(clip(theme.fg("warning", `  ⏸ 等待换脑 —— 执行 /mission next:${state.pendingHandoff}`), width));
	}
	return lines;
}

// ─────────────────────────── tab:概览 ───────────────────────────

export interface OverviewOptions {
	now?: number;
	theme?: LineTheme;
	/** 可用列宽,决定折行位置 */
	width?: number;
	/**
	 * 调用方顶部已经显示了 id / 档位 / 相位 / 进度(status-view 的盒标题 + 头行)。
	 * 置 true 就不再重复这些 —— 概览栏的空间要留给目标和当前任务。
	 */
	omitIdentity?: boolean;
	checkState?: CheckState | null;
}

/**
 * 概览栏。排序即优先级:先说要干什么、现在卡在哪,再说机制性的账。
 * 刻意**不**显示会话文件名与逐字段的原始 SNAPSHOT —— 那是排障时查看仓库文件的事,
 * 放在这里只会把目标挤没。
 */
export function overviewLines(plan: MissionPlan, state: MissionState, opts: OverviewOptions = {}): string[] {
	const t = opts.theme ?? PLAIN;
	const now = opts.now ?? Date.now();
	const width = opts.width ?? 96;
	const dim = (s2: string) => t.fg("dim", s2);
	const lines: string[] = [];

	// ① 目标 —— 折行,绝不截断
	lines.push(...fieldWrapped(t, "目标", plan.goal, width, 4));

	// ② 身份与进度:只有在调用方没显示时才出(非 TUI 的扁平卡片)
	if (!opts.omitIdentity) {
		const done = Object.values(state.tasks).filter((x) => x.status === "done").length;
		const total = state.taskOrder.length;
		lines.push(
			field(
				t,
				"mission",
				[state.missionId, state.tier, `${PHASE_STYLE[state.phase]?.label ?? state.phase}(${state.phase})`, ROLE_OF[state.phase]]
					.filter(Boolean)
					.join(dim(" · ")),
			),
			field(
				t,
				"进度",
				`${miniBar(t, done, total, 10)} ${done}/${total} 任务` +
					(plan.createdAt ? dim(` · 已运行 ${fmtDuration(plan.createdAt, now)}`) : ""),
			),
		);
	}

	// ③ 现在卡在哪
	if (state.currentTask) {
		const ts = state.tasks[state.currentTask];
		const pt = findTask(plan, state.currentTask);
		const attempt = ` · attempt ${ts?.attempts ?? 0}/${thresholdFor(state.tier)}`;
		// attempt 尽量挂在折行后的最后一行末尾;那一行放不下就另起一行 ——
		// 直接拼上去会被列宽截掉,而 attempt 正是判断"卡住了没"的那个数
		const cur = fieldWrapped(t, "当前", `${state.currentTask} ${pt?.title ?? ""}`, width, 2);
		if (visibleWidth(cur[cur.length - 1]) + visibleWidth(attempt) <= width) {
			cur[cur.length - 1] += dim(attempt);
		} else {
			cur.push(" ".repeat(LABEL_W) + dim(attempt.replace(" · ", "")));
		}
		lines.push(...cur);
		if (ts?.lastFailureReason) {
			lines.push(...fieldWrapped(t, "上次失败", ts.lastFailureReason, width, 3, "error"));
		}
	}
	if (state.phase === "check" && opts.checkState?.taskId === state.currentTask) {
		lines.push(...checkProgressLines(opts.checkState, now, t, width));
	}
	if (state.pendingHandoff) {
		lines.push(t.fg("warning", `⏸ 等待换脑: ${state.pendingHandoff} —— /mission next`));
	}

	lines.push("");

	// ④ 机制性的账:升级阶梯 / 花费
	const esc = state.escalation;
	lines.push(
		field(
			t,
			"阶梯",
			`L${esc.level}` +
				(esc.history.length > 0
					? dim(` · ${esc.history.map((h) => `L${h.from}→L${h.to}(${h.taskId})`).join(" ")}`)
					: dim(" · 无升级历史")),
		),
	);

	// 合计放最前面:这几行是次要信息,窄栏会被截掉,截掉的必须是分账明细而不是总额
	const costEntries = Object.entries(state.cost).filter(([, v]) => (v ?? 0) > 0);
	const tokMap = state.tokens;
	const tokSum = tokenTotal(state);
	const costSummary = [
		costEntries.length > 0 ? `$${costTotal(state).toFixed(3)}` : "",
		tokSum > 0 ? `${formatTokens(tokSum)} tok` : "",
	]
		.filter(Boolean)
		.join(" + ");
	// 分账按角色合并美元与 token(哪边有数显哪边)
	const roles = [
		...new Set([...costEntries.map(([r]) => r), ...Object.keys(tokMap)]),
	] as Array<keyof typeof tokMap>;
	const roleDetail = roles
		.map((r) => {
			const parts: string[] = [];
			const money = state.cost[r];
			if ((money ?? 0) > 0) parts.push(`$${money!.toFixed(3)}`);
			const u = tokMap[r];
			if (u) parts.push(`${formatTokens(u.input + u.output + u.cacheRead + u.cacheWrite)} tok`);
			return `${r} ${parts.join("/")}`;
		})
		.join(" · ");
	lines.push(
		field(
			t,
			"成本",
			costSummary ? `${costSummary}${dim(` · ${roleDetail}`)}` : dim("尚无记录"),
		),
	);

	// 上面这几行(阶梯/成本)不折行 —— 它们的信息是"前重后轻",截断即可
	return lines.map((l) => clip(l, width));
}

// ─────────────────────────── tab:任务 ───────────────────────────

/** 任务状态 → 图标 + 颜色 */
const TASK_STYLE: Record<string, { icon: string; color: string }> = {
	done: { icon: "✓", color: "success" },
	running: { icon: "▸", color: "accent" },
	pending: { icon: "○", color: "dim" },
	blocked: { icon: "✗", color: "error" },
};

export interface TaskBlock {
	taskId: string;
	lines: string[];
}

export function taskBlocks(
	plan: MissionPlan,
	state: MissionState,
	t: LineTheme = PLAIN,
	width = 96,
): TaskBlock[] {
	const blocks: TaskBlock[] = [];
	const dim = (s2: string) => t.fg("dim", s2);
	// verify 分支名很长,窄栏里它会把标题挤没 —— 分支与 AC 的对应关系在「验收」段有
	const showVerify = width >= 56;

	for (const [mi, ms] of plan.milestones.entries()) {
		const msDone = ms.tasks.every((x) => state.tasks[x.id]?.status === "done");
		const showMsHeader = plan.tier === "complex" || plan.milestones.length > 1;

		for (const [ti, task] of ms.tasks.entries()) {
			const blockLines: string[] = [];
			// 里程碑标题与间隔空行归入首个任务块,避免任务选择时标题脱离
			if (ti === 0) {
				if (mi > 0) blockLines.push("");
				if (showMsHeader) {
					blockLines.push(
						`${t.fg(msDone ? "success" : "accent", msDone ? "✓" : "▾")} ${t.bold(`${ms.id} ${ms.title}`)}`,
					);
				}
			}

			const ts = state.tasks[task.id];
			const st = TASK_STYLE[ts?.status ?? "pending"] ?? TASK_STYLE.pending;
			const running = ts?.status === "running";
			const prefix = `  ${st.icon} ${task.id} `;
			const indent = " ".repeat(visibleWidth(prefix));
			const titleLines = wrap(task.title, Math.max(16, width - visibleWidth(prefix)), 2);
			blockLines.push(
				`  ${t.fg(st.color, st.icon)} ${t.fg(st.color, task.id)} ` +
					(running ? t.bold(titleLines[0]) : titleLines[0]),
			);
			for (const extra of titleLines.slice(1)) blockLines.push(indent + (running ? t.bold(extra) : extra));

			// 元信息挂在标题末尾:attempt 为 0 说明还没动过,不占版面
			const meta: string[] = [];
			// 只标 spike 两个字:它是什么意思写在 phases/plan.md 里,列表里放不下也不该放
			if (task.kind === "spike") meta.push("spike");
			if ((ts?.attempts ?? 0) > 0) meta.push(`attempt ${ts?.attempts}`);
			if (showVerify && task.kind !== "spike" && task.verify.length > 0) {
				meta.push(`verify ${task.verify.join(", ")}`);
			}
			if (meta.length > 0) blockLines[blockLines.length - 1] += dim(` · ${meta.join(" · ")}`);

			if (ts?.lastFailureReason && ts.status !== "done") {
				const reason = wrap(ts.lastFailureReason, Math.max(16, width - 6), 2);
				blockLines.push(`      ${dim("上次失败:")} ${t.fg("error", reason[0])}`);
				for (const l of reason.slice(1)) blockLines.push(`      ${t.fg("error", l)}`);
			}
			if (ts && ts.sameSignatureCount > 1) {
				blockLines.push(`      ${t.fg("warning", `签名 ${ts.lastSignature} ×${ts.sameSignatureCount}`)}`);
			}

			blocks.push({ taskId: task.id, lines: blockLines });
		}
	}
	return blocks;
}

export function taskLines(
	plan: MissionPlan,
	state: MissionState,
	t: LineTheme = PLAIN,
	width = 96,
): string[] {
	const blocks = taskBlocks(plan, state, t, width);
	if (blocks.length === 0) return [t.fg("dim", "(计划尚未冻结,无任务列表)")];
	return blocks.flatMap((b) => b.lines);
}

// ─────────────────────────── tab:验收 ───────────────────────────

const EV_COLOR: Record<string, string> = { pass: "success", fail: "error", inconclusive: "warning" };

export function acLines(
	plan: MissionPlan,
	evidence: EvidenceSummary,
	dirName: string,
	t: LineTheme = PLAIN,
	width = 96,
	verifyScriptPath?: string,
): string[] {
	const dim = (s: string) => t.fg("dim", s);
	if (plan.acceptanceCriteria.length === 0) {
		return plan.tier === "quick"
			? [dim("(quick 档:无 AC,判定依据是 --verify 冻结的验证命令)")]
			: [dim("(尚未冻结 AC:PLAN 相位调用 mission_write_plan 后显示)")];
	}
	const lines: string[] = [dim(`执行入口 ${verifyScriptPath ?? `./${dirName}/state/<mission>/generations/<generation>/verify.sh`} <分支>`), ""];
	for (const [i, ac] of plan.acceptanceCriteria.entries()) {
		if (i > 0) lines.push("");
		const ev = evidence.latest[ac.verify];
		const color = ev ? (EV_COLOR[ev.result] ?? "dim") : "dim";
		const icon = ev ? (EV_ICON[ev.result] ?? "?") : "·";
		const where = ev?.taskId ? `${ev.taskId}-a${ev.attempt}` : null;
		const tag = ev ? `${ev.result}@${ev.level}${where ? ` · ${where}` : ""}` : "尚无证据";
		lines.push(`${t.fg(color, icon)} ${t.fg(color, ac.id)} ${dim(ac.verify)}  ${t.fg(color, tag)}`);
		// AC 正文是判定标准本身,截断等于看不出这条要求什么 —— 折行
		for (const l of wrap(ac.text, Math.max(16, width - 4), 4)) lines.push(`    ${l}`);
		if (ev?.rawTail) {
			for (const l of ev.rawTail.split("\n").filter(Boolean).slice(-4)) {
				lines.push(`    ${t.fg("borderMuted", "│")} ${dim(l)}`);
			}
		}
	}
	return lines;
}

// ─────────────────────────── 扁平拼接(非 TUI 环境的卡片) ───────────────────────────

export function renderStatusDashboard(
	plan: MissionPlan,
	state: MissionState,
	evidence: EvidenceSummary,
	logTail: string[],
	dirName: string,
	now = Date.now(),
	checkState?: CheckState | null,
	verifyScriptPath?: string,
): string {
	const sections = [
		overviewLines(plan, state, { now, checkState }),
		["任务:", ...taskLines(plan, state).map((l) => (l ? `  ${l}` : l))],
		["验收:", ...acLines(plan, evidence, dirName, PLAIN, 96, verifyScriptPath).map((l) => (l ? `  ${l}` : l))],
	];
	if (logTail.length > 0) sections.push(["最近日志:", ...logTail.map((l) => `  ${l}`)]);
	return sections.map((s) => s.join("\n")).join("\n\n");
}

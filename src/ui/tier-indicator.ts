/**
 * pi-missions · ui/tier-indicator
 *
 * 档位选择的编辑器外化。全部长在编辑器自己身上,**不额外占一行**:
 *   0. 信息分工:状态(哪一档、实际用什么模型)进**顶边框**,常驻;
 *      上手提示(怎么输、怎么退)进 **placeholder**,输入即消失。别把两者混在一处。
 *   1. 拼成和 chrome.ts 同一套形状语言的圆角盒:顶边框改写成
 *      `╭─ standard ──…── glm-5.3-flash ─╮`(titledTopBorder + withSideBorders)。
 *      pi-tui 的 Editor 刻意不画侧边,所以按 width-2 渲染再补两列。
 *      这里的宽度是 Editor.render 拿到的真实终端宽度,所以右端对齐是安全的 ——
 *      pi 发给 widget 的 width 则不可信,那条路上填充到 width 会越界炸 TUI。
 *   2. 空编辑器贴 placeholder:Proxy 拦 render,把行尾空格换成等宽提示
 *      (pi 本身没有 placeholder 概念,见 withPlaceholder)。
 *   3. 不预填命令:用户直接输入目标,提交时 onSubmit 被 Proxy 包裹,自动拼成
 *      /mission quick <目标> 或 /mission new <目标>;以 / 开头的输入原样放行。
 *   4. Esc 取消选择:Proxy 拦 handleInput,清掉指示与 pendingTier,保留已输入文字。
 *   5. 底座必须是 pi 主包的 CustomEditor,不是 pi-tui 的裸 Editor ——
 *      Ctrl+V 图片粘贴(app.clipboard.pasteImage)拦截在 CustomEditor.handleInput 里,
 *      pi 接线自定义编辑器时也只对带 actionHandlers 的组件回接 onPasteImage;
 *      裸 Editor 会让 tier 模式下粘贴图片失效(文字的 bracketed paste 不受影响,
 *      所以这个 bug 之前只露出一半)。换上之后 onEscape/onCtrlD/模型切换等
 *      app 级键位也被正确接回。
 *
 * 边框本身**不染档位色**:整框染色太吵,还要跟 pi 每帧重设 borderColor 打架;
 * 档位色只上标题,信号更准(它就贴在输入框上)。
 * mission 启动后自动清除(状态条接管显示)。
 */

import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import type { Tier } from "../core/types.ts";
import { actualModelOf, type RoleModelView } from "../roles/models.ts";

/**
 * 档位色。主题的 success/warning 在 minimal 等主题里是接近灰色的暗色,
 * quick/complex 用了会看着像没变色 —— 所以这两档直接用主题无关的高亮 ANSI;
 * standard 用主题 accent(各主题里都是最鲜明的那个)。
 */
const TIER_ANSI: Record<Tier, string> = {
	quick: "\x1b[38;5;40m", // 亮绿
	standard: "", // 走主题 accent
	complex: "\x1b[38;5;208m", // 亮橙
};

/** 档位着色:standard 用主题 accent,quick/complex 用 ANSI 高亮 */
function colorize(theme: any, tier: Tier, s: string): string {
	if (tier === "standard") return theme.fg("accent", s);
	return `${TIER_ANSI[tier]}${s}\x1b[39m`;
}

/**
 * 角色模型折成一段。四个角色在绝大多数配置下是同一个模型 —— 逐个列出来
 * 等于把同一个值抄四遍,而这条指示只有一行。所以取多数派当主模型,
 * 只列偏离它的角色:一眼要看到的是"有没有例外",不是"每个角色配了啥"
 * (那是 /mission models 和模型页的职责)。
 *
 * provider 前缀在这里剥掉:同一行里它对每个角色都一样,是纯噪音;
 * 需要完整 id 的场合(模型页)另有出处。
 */
export function modelSummary(views: RoleModelView[], sessionLabel: string): string {
	if (views.length === 0) return "";
	const pairs = views.map((v) => ({ role: v.role, model: shortModel(actualModelOf(v, sessionLabel)) }));

	const tally = new Map<string, number>();
	for (const p of pairs) tally.set(p.model, (tally.get(p.model) ?? 0) + 1);
	let head = pairs[0].model;
	for (const [model, n] of tally) {
		if (n > (tally.get(head) ?? 0)) head = model;
	}

	const deviations = pairs.filter((p) => p.model !== head).map((p) => `${p.role} ${p.model}`);
	if (deviations.length > 0) return `${head}(${deviations.join(", ")})`;
	// 全员未配置:主模型就是会话模型。标出来 —— 这正是"以为在用便宜模型
	// 实际一直烧会话模型"那个坑的可见化(见 roles/models.ts resolveRoleView)
	return views.every((v) => v.state === "inherit") ? `${head}(跟随会话)` : head;
}

function shortModel(id: string): string {
	const i = id.indexOf("/");
	return i > 0 ? id.slice(i + 1) : id;
}

/** 空编辑器上的提示。一输入就消失 —— 上手提示本来就只在"还没动手"时有用 */
export const TIER_PLACEHOLDER = "请输入目标,Enter 开始 · Esc 取消";

/**
 * 往空编辑器里贴提示文字。pi 没有 placeholder 概念(EditorComponent 接口、
 * Editor 类、ctx.ui 都没有),这是自己画的。
 *
 * 实现只碰**行尾那串空格**:不去推断 pi-tui 编辑器盒的内部结构
 * (paddingX、边框占几列都是私有实现,猜了就会随 pi 升级漂),
 * 只把已经在那儿的空格换成等宽的文字 —— 每行可见宽度严格不变,
 * 差一列就会把盒子撕开(CLAUDE.md「UI 层的三个坑」第三条)。
 * 左内边距原样保留;放不下就整条不贴 —— 提示是附加信息,不值得动版面。
 */
export function withPlaceholder(lines: string[], hint: string, dim: (s: string) => string): string[] {
	// [0] 是上边框,[1] 是文本区第一行。空编辑器不会滚动,所以这个下标是稳的
	if (lines.length < 2 || !hint) return lines;
	const line = lines[1];
	const lead = line.length - line.trimStart().length;
	const body = line.slice(lead);
	const tail = /( +)$/.exec(body);
	if (!tail) return lines; // 整行都是空格 = 编辑器未聚焦,这时不打扰
	const room = tail[1].length;
	const need = visibleWidth(hint);
	if (need > room) return lines;
	const out = [...lines];
	out[1] = line.slice(0, line.length - room) + dim(hint) + " ".repeat(room - need);
	return out;
}

/**
 * 把档位与模型嵌进编辑器的**顶边框**。
 *
 * 为什么在这儿而不是单开一行 widget:
 *   - 不占额外行,且和输入框物理绑定 —— 一眼看到的是"这个框现在是什么框";
 *   - 这里的 width 是 Editor.render 拿到的**真实**宽度,不是 pi 发给 widget
 *     的那个可能超过终端的值,所以右端对齐在这里是安全的(对比文件头第 1 条)。
 *
 * 只改写纯 ─ 的边框:滚动时那一行是 ↑N 指示器,"上面还有内容"比档位重要。
 * 宽度精确等于 width —— 顶边框差一列会把整个盒子撕开。
 */
export function titledTopBorder(
	top: string,
	width: number,
	title: string,
	right: string,
	paint: { border: (s: string) => string; title: (s: string) => string; right: (s: string) => string },
): string {
	if (!/^─+$/.test(stripTerminalSequences(top))) return top;
	const t = title ? ` ${title} ` : "";
	const tw = visibleWidth(t);
	if (tw === 0 || tw + 2 > width) return top;
	const r = right ? ` ${right} ` : "";
	const rw = visibleWidth(r);
	// 窄终端先牺牲模型:档位是这条边框的本职,模型是附加信息
	const withRight = rw > 0 && tw + rw + 3 <= width;
	const mid = width - 2 - tw - (withRight ? rw : 0);
	return (
		paint.border("─") +
		paint.title(t) +
		paint.border("─".repeat(mid)) +
		(withRight ? paint.right(r) : "") +
		paint.border("─")
	);
}

/**
 * 编辑器的横线:pi-tui 只有两种产法 —— 纯 ─,或滚动指示 `─── ↑ 3 more ───`。
 * 认得出这两种,才能知道盒子从哪行开始到哪行结束。认不出就整条不套边(见 withSideBorders)。
 */
function isRule(line: string): boolean {
	const plain = stripTerminalSequences(line);
	return /^─+$/.test(plain) || /^─── [↑↓] \d+ more ─*$/.test(plain);
}

/**
 * 给编辑器补上左右边框,拼成和 chrome.ts 一样的圆角盒。
 *
 * pi-tui 的 Editor 是刻意不画侧边的("no side borders, just horizontal lines
 * above and below"),所以这两列得自己加。**调用方必须按 width-2 渲染** ——
 * 在已经排好版的行上硬塞两列会撑破宽度,而不是把文字挤窄。
 *
 * 自动补全菜单渲染在下边框**之外**,不能套进盒里:那几行改用两列空格占位,
 * 整体宽度仍然一致。认不出盒子边界(pi 改了边框写法)就原样返回 —— 退化成
 * 现在这种没侧边的样子,不会撕版面。
 */
export function withSideBorders(lines: string[], border: (s: string) => string): string[] {
	// lines[0] 一定是上边框(Editor.render 第一件事就是 push 它),而且此时
	// 已经被 titledTopBorder 写上标题,不再是纯 ─ —— 所以只对**下**边框做识别
	if (lines.length < 2) return lines;
	const bottom = lines.findIndex((l, i) => i > 0 && isRule(l));
	if (bottom < 0) return lines;
	const out = lines.slice();
	out[0] = border("╭") + lines[0] + border("╮");
	for (let i = 1; i < bottom; i++) out[i] = border("│") + lines[i] + border("│");
	out[bottom] = border("╰") + lines[bottom] + border("╯");
	for (let i = bottom + 1; i < out.length; i++) out[i] = ` ${lines[i]} `;
	return out;
}

/** 当前生效的档位;null = 无档位包裹 */
let activeTier: Tier | null = null;

/** 设置档位指示:Proxy 包住 Editor,接管 render(标题+placeholder)、handleInput(Esc)、onSubmit(拼命令) */
export function applyTierIndicator(ctx: any, tier: Tier, onCancel?: () => void, models?: string): void {
	if (!ctx.hasUI) return;
	activeTier = tier;

	// 编辑器:顶边框标题(档位+模型) + 空态 placeholder + onSubmit 自动包命令 + Esc 取消。
	// 全部长在编辑器自己身上,不再额外占一行。
	ctx.ui.setEditorComponent((tui: any, editorTheme: any, keybindings: any) => {
		// CustomEditor(不是 pi-tui 裸 Editor):否则 Ctrl+V 图片粘贴失效,见文件头第 5 条
		const base = new CustomEditor(tui, editorTheme, keybindings);
		const theme = ctx.ui.theme; // 边框着色用主题 accent 或 ANSI 高亮
		const proxied = new Proxy(base, {
			get(target: any, prop: string | symbol, receiver: any): unknown {
				if (prop === "render") {
					return (width: number) => {
						// 留出左右两列给侧边框:必须在**排版之前**让出来,
						// 事后往成品行里塞两列只会撑破宽度
						const inner = Math.max(1, width - 2);
						let lines = target.render(inner) as string[];
						// "dim" 是已验证的主题色名(models-page/dashboard 在用,受 theme-colors 测试保护)。
						// 这里绝不能引入没验证过的色名:theme.fg 遇到未知色名直接抛,而渲染在 TUI 主循环里
						const dim = (x: string) => theme.fg("dim", x);
						// 边框沿用 pi 当前的色(默认/thinking/bash),只有标题带档位色 ——
						// 整框染色太吵,而且要跟 pi 每帧的 borderColor 赋值打架
						const border = (x: string) => (base.borderColor ? base.borderColor(x) : x);
						if (!base.getText()) lines = withPlaceholder(lines, TIER_PLACEHOLDER, dim);
						if (lines.length === 0) return lines;
						const out = [...lines];
						out[0] = titledTopBorder(out[0], inner, tier, models ?? "", {
							border,
							title: (x) => colorize(theme, tier, x),
							right: dim,
						});
						return withSideBorders(out, border);
					};
				}
				if (prop === "handleInput") {
					return (data: string) => {
						// Esc = 放弃这次档位选择;只在档位指示生效的窗口期拦截
						if (matchesKey(data, Key.escape)) {
							const text = base.getText();
							clearTierIndicator(ctx);
							if (text) ctx.ui.setEditorText(text);
							ctx.ui.notify("已取消档位选择", "info");
							onCancel?.();
							return;
						}
						target.handleInput(data);
					};
				}
				return Reflect.get(target, prop, receiver);
			},
			set(target: any, prop: string | symbol, value: unknown, receiver: any): boolean {
				if (prop === "onSubmit") {
					const original = value as ((text: string) => void) | undefined;
					value = (text: string) => {
						const wrapped = wrapGoal(text);
						// 包裹成功(真的拼了命令):清空文本 + 恢复默认编辑器(档位已被消费)
						if (wrapped !== text) {
							base.setText("");
							clearTierIndicator(ctx);
						}
						original?.(wrapped);
					};
				}
				return Reflect.set(target, prop, value, receiver);
			},
		});
		return proxied;
	});
}

/**
 * 自动包裹:非 / 开头的输入 → 拼上档位命令。
 * quick → /mission quick <text>;standard/complex → /mission new <text>
 * (/mission new 会消费 runtime.pendingTier,不必显式带 --tier)
 */
export function wrapGoal(text: string, tier: Tier | null = activeTier): string {
	const trimmed = text.trim();
	if (!trimmed || trimmed.startsWith("/")) return text;
	if (tier === null || tier === undefined) return text; // 无档位 = 不包裹
	if (tier === "quick") return `/mission quick ${trimmed}`;
	return `/mission new ${trimmed}`;
}

/** 清除指示,恢复默认编辑器 */
export function clearTierIndicator(ctx: any): void {
	activeTier = null;
	if (!ctx.hasUI) return;
	ctx.ui.setEditorComponent(undefined);
}

/** 选中档位后的完整动作:指示 + 清空编辑器等待输入;onCancel 在 Esc 取消时回调(清 pendingTier) */
export function applyTierSelection(ctx: any, tier: Tier, onCancel?: () => void, models?: string): void {
	applyTierIndicator(ctx, tier, onCancel, models);
	ctx.ui.setEditorText("");
	// 怎么用已经写在 placeholder 上了,toast 只确认命令生效
	ctx.ui.notify(`已选 ${tier} 档`, "info");
}

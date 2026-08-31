/**
 * pi-missions · ui/tier-indicator
 *
 * 档位选择的编辑器外化。选中档位后:
 *   1. 编辑器上方出现彩色档位指示(widget,绝不填充到 width —— pi 给的 widget
 *      width 可能超过终端真实宽度,填充即越界炸 TUI;按 min(width,120) 截断)
 *   2. 编辑器边框随档位变色 —— 用 Proxy 拦截 borderColor 赋值。pi 每次渲染都会
 *      给 this.editor.borderColor 重新赋值(thinking/bash 色),直接覆盖会被冲掉,
 *      Proxy 在 set 时把任何赋值都染成档位色,才能压住。
 *   3. 不预填命令:用户直接输入目标,提交时 onSubmit 被 Proxy 包裹,自动拼成
 *      /mission quick <目标> 或 /mission new <目标>;以 / 开头的输入原样放行。
 * mission 启动后自动清除(状态条接管显示)。
 */

import { Editor, truncateToWidth } from "@earendil-works/pi-tui";
import type { Tier } from "../core/types.ts";

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

const TIER_LABEL: Record<Tier, string> = {
	quick: "quick · 单任务快速循环",
	standard: "standard · 任务列表 + 验证闸门",
	complex: "complex · 里程碑 + 独立验证",
};

/** 档位着色:standard 用主题 accent,quick/complex 用 ANSI 高亮 */
function colorize(theme: any, tier: Tier, s: string): string {
	if (tier === "standard") return theme.fg("accent", s);
	return `${TIER_ANSI[tier]}${s}\x1b[39m`;
}

const WIDGET_KEY = "missions-tier";

/** 当前生效的档位;null = 无档位包裹 */
let activeTier: Tier | null = null;

/**
 * 设置档位指示:彩色 widget + 编辑器边框 Proxy + onSubmit 自动包裹。
 * 必须在 setEditorComponent 之后立刻把 borderColor 换掉 ——
 * pi 会把默认编辑器的 borderColor 拷给自定义编辑器,而 Proxy 保证后续
 * 每次渲染的赋值都被染成档位色。
 */
export function applyTierIndicator(ctx: any, tier: Tier): void {
	if (!ctx.hasUI) return;
	activeTier = tier;

	// 编辑器上方的彩色指示条
	ctx.ui.setWidget(WIDGET_KEY, (_tui: any, theme: any) => ({
		render: (width: number) => [
			colorize(theme, tier, truncateToWidth(`◆ mission 档位: ${TIER_LABEL[tier]} · 输入目标回车即可`, Math.min(width, 120))),
		],
		invalidate: () => {},
	}));

	// 编辑器:边框染档位色 + onSubmit 自动包命令
	ctx.ui.setEditorComponent((tui: any, editorTheme: any) => {
		const base = new Editor(tui, editorTheme);
		const theme = ctx.ui.theme; // 边框着色用主题 accent 或 ANSI 高亮
		const proxied = new Proxy(base, {
			set(target: any, prop: string | symbol, value: unknown, receiver: any): boolean {
				if (prop === "borderColor") {
					// pi 每次渲染都重新赋值(默认/thinking/bash 色),统一染成档位色
					value = (s: string) => colorize(theme, tier, s);
				} else if (prop === "onSubmit") {
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
	ctx.ui.setWidget(WIDGET_KEY, undefined);
	ctx.ui.setEditorComponent(undefined);
}

/** 选中档位后的完整动作:指示 + 清空编辑器等待输入 */
export function applyTierSelection(ctx: any, tier: Tier): void {
	applyTierIndicator(ctx, tier);
	ctx.ui.setEditorText("");
	ctx.ui.notify(`已选 ${tier} 档 —— 直接输入目标,回车自动带上档位命令`, "info");
}

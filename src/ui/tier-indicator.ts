/**
 * pi-missions · ui/tier-indicator
 *
 * 档位选择的编辑器外化:在 /missions 面板或 /mission tier 选定档位后,
 *   1. 编辑器上方出现彩色档位指示(widget)
 *   2. 编辑器边框颜色随档位变化(quick=绿 / standard=accent / complex=橙)
 *   3. 编辑器预填对应命令,用户只需补目标
 * mission 启动后自动清除(状态条接管显示)。
 */

import { Editor } from "@earendil-works/pi-tui";
import type { Tier } from "../core/types.ts";

const TIER_COLOR: Record<Tier, string> = {
	quick: "success",
	standard: "accent",
	complex: "warning",
};

const TIER_LABEL: Record<Tier, string> = {
	quick: "quick · 单任务快速循环",
	standard: "standard · 任务列表 + 验证闸门",
	complex: "complex · 里程碑 + 独立验证",
};

const WIDGET_KEY = "missions-tier";

/**
 * 设置档位指示。pi 在 setEditorComponent 后会把默认编辑器的 borderColor
 * 拷给自定义编辑器,所以必须在工厂执行之后再覆盖 borderColor。
 */
export function applyTierIndicator(ctx: any, tier: Tier): void {
	if (!ctx.hasUI) return;
	const color = TIER_COLOR[tier];

	// 编辑器上方的彩色指示条
	ctx.ui.setWidget(WIDGET_KEY, (_tui: any, theme: any) => ({
		render: (width: number) => {
			const label = `◆ mission 档位: ${TIER_LABEL[tier]}`;
			const padded = label.length < width ? label + " ".repeat(Math.max(0, width - label.length)) : label;
			return [theme.fg(color, padded)];
		},
		invalidate: () => {},
	}));

	// 编辑器边框换色
	let ed: any;
	ctx.ui.setEditorComponent((tui: any, editorTheme: any) => {
		ed = new Editor(tui, editorTheme);
		return ed;
	});
	if (ed) {
		const fg = ctx.ui.theme.fg.bind(ctx.ui.theme);
		ed.borderColor = (s: string) => fg(color, s);
	}
}

/** 清除指示,恢复默认编辑器 */
export function clearTierIndicator(ctx: any): void {
	if (!ctx.hasUI) return;
	ctx.ui.setWidget(WIDGET_KEY, undefined);
	ctx.ui.setEditorComponent(undefined);
}

/** 选中档位后的完整动作:指示 + 预填命令 */
export function applyTierSelection(ctx: any, tier: Tier): void {
	applyTierIndicator(ctx, tier);
	ctx.ui.setEditorText(tier === "quick" ? "/mission quick " : "/mission new ");
	ctx.ui.notify(`已选 ${tier} 档 —— 在输入框补全目标后回车`, "info");
}

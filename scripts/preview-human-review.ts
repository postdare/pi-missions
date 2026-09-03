/**
 * 人工终审页离线预览:不起 pi,直接把页面渲染到 stdout。
 *
 * 用法:
 *   node --experimental-strip-types scripts/preview-human-review.ts          # 未选态(进入时)
 *   node --experimental-strip-types scripts/preview-human-review.ts pass     # 游标停在通过
 *   node --experimental-strip-types scripts/preview-human-review.ts reason   # 写理由
 *   COLUMNS=56 node --experimental-strip-types scripts/preview-human-review.ts
 */
import { renderHumanReview } from "../src/ui/human-review.ts";

const theme = {
	fg: (_c: string, s: string) => `\x1b[90m${s}\x1b[0m`,
	bg: (_c: string, s: string) => `\x1b[7m${s}\x1b[0m`,
	bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

const width = Number(process.env.COLUMNS) || 96;
const mode = process.argv[2] ?? "empty";

const { lines } = renderHumanReview({
	theme,
	width,
	rows: Number(process.env.LINES) || 32,
	missionId: "2026-09-03-mission-mtll5d8t",
	criterionText:
		"在新标签页实际验证:把一个小组件卡片和一个书签分组移到副屏后,通过指示点(ScreenDots 第二点亮起)或 → 方向键切到副屏,副屏上能实际看到该卡片(标题栏+内容)和该书签分组(分组标题+链接图标)渲染出来,而不是空白;同时任务答复中给出了导致副屏空白的具体代码级原因(定位到文件与逻辑)。",
	stage: mode === "reason" ? "reason" : "decide",
	sel: mode === "pass" ? 0 : mode === "reason" ? 1 : -1,
	reason: mode === "reason" ? "副屏切过去还是空的,ScreenDots 第二点也没亮" : "",
	scroll: 0,
});

console.log(`── width=${width} mode=${mode} ──`);
console.log(lines.join("\n"));

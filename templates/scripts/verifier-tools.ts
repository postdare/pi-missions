/**
 * pi-missions · 子进程 Verifier 扩展(I3 · 判定权外置)
 *
 * 由系统以独立进程启动:
 *   pi -p --mode json --no-extensions -e missions/scripts/verifier-tools.ts --model <verifier> <brief>
 *
 * 只给 read + bash + mission_verdict 三个工具 —— 验证者不能写文件,
 * 否则它会"顺手修一下"然后判自己通过。
 * 结论通过 mission_verdict 工具提交(terminate: 提交后立即结束),
 * 结果以 MISSION_VERDICT::<base64> 标记行出现在 stdout,由父进程解析。
 */
export default function (pi) {
	pi.on("session_start", async () => {
		pi.setActiveTools(["read", "bash", "mission_verdict"]);
	});

	pi.registerTool({
		name: "mission_verdict",
		description: "提交逐条 AC 核对结论。提交后立即结束。",
		parameters: {
			type: "object",
			properties: {
				verdicts: {
					type: "array",
					items: {
						type: "object",
						properties: {
							acId: { type: "string", description: "AC id 或 verify 分支名" },
							result: { type: "string", enum: ["pass", "fail", "inconclusive"] },
							rationale: { type: "string", description: "核对依据:看了什么文件/跑了什么命令/结论为什么成立" },
						},
						required: ["acId", "result", "rationale"],
						additionalProperties: false,
					},
				},
			},
			required: ["verdicts"],
			additionalProperties: false,
		},
		terminate: true,
		async execute(_id, params) {
			const payload = Buffer.from(JSON.stringify(params.verdicts), "utf8").toString("base64");
			return {
				content: [{ type: "text", text: `MISSION_VERDICT::${payload}` }],
				details: {},
			};
		},
	});
}

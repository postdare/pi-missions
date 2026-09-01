/**
 * pi-missions · LLM 可调用的工具(五个,按相位分发;mission_verdict 在子进程里)
 *
 *   FRAME: mission_ask / mission_frame
 *   PLAN:  mission_write_plan
 *   DO:    mission_submit
 *   ACT:   mission_escalate
 *
 * 工具越少越好。状态推进由 L0 驱动,不给 LLM 直接改 STATE.json 的工具。
 */

import { Type } from "typebox";
import type { Runtime } from "./runtime.ts";

type GetRuntime = (ctx: any) => Runtime;

const ACSchema = Type.Object({
	id: Type.String({ description: "AC id,如 AC1" }),
	text: Type.String({ description: "人类可读的验收描述" }),
	verify: Type.String({ description: "verify.sh 的分支名 —— AC 的唯一执行入口,不写裸命令" }),
	baseline: Type.Optional(
		Type.Union([Type.Literal("red"), Type.Literal("green")], {
			description:
				"冻结时该分支应有的状态,缺省 red。red=现在必须失败(冻结时系统会跑一遍核对,`exit 0` 这类空壳分支会被当场打回);" +
				"green=回归项(如\"现有测试不许挂\"),现在必须已经通过。至少要有一条 red。",
		}),
	),
});

const TaskSchema = Type.Object({
	id: Type.String({ description: "任务 id,如 T1" }),
	title: Type.String(),
	verify: Type.Array(Type.String(), {
		description: "本任务必须通过的 verify.sh 分支名。spike 任务必须给空数组",
	}),
	kind: Type.Optional(
		Type.Union([Type.Literal("impl"), Type.Literal("spike")], {
			description:
				"缺省 impl(写代码)。spike = 探针:答案只能靠看代码/量一下才知道时用它。" +
				"产出是书面结论不是代码,闸门只放行写结论文件,一次机会不重试," +
				"完成后系统带着结论回 PLAN 重写计划。每个 mission 最多一个。",
		}),
	),
	question: Type.Optional(
		Type.String({ description: "spike 必填:这根探针要回答的那一个问题。判定就是核对结论有没有回答它" }),
	),
});

const MilestoneSchema = Type.Object({
	id: Type.String({ description: "里程碑 id,如 M1" }),
	title: Type.String(),
	tasks: Type.Array(TaskSchema),
});

export function registerMissionTools(pi: any, getRuntime: GetRuntime): void {
	pi.registerTool({
		name: "mission_ask",
		description:
			"[FRAME 相位] 把\"不知道就写不出验收标准\"的问题交给人。" +
			"每个 mission 只许问一轮、最多 3 个问题 —— 这是系统强制的,不是建议。" +
			"提问后本轮结束,等人回答;不需要提问就直接调用 mission_frame。",
		parameters: Type.Object({
			questions: Type.Array(Type.String(), {
				minItems: 1,
				maxItems: 3,
				description: "只问那些答案会改变验收标准的问题。措辞具体,给出选项更好。",
			}),
		}),
		async execute(_id: string, params: any, _signal: any, _onUpdate: any, ctx: any) {
			const r = await getRuntime(ctx).ask(ctx, params.questions ?? []);
			if ("error" in r) return toolError(r.error);
			return {
				content: [
					{
						type: "text",
						text: `问题已交给人(${r.questions.length} 个)。本轮到此为止:不要继续分析,不要自问自答,等回答之后再调用 mission_frame。`,
					},
				],
				details: { ok: true },
			};
		},
	});

	pi.registerTool({
		name: "mission_frame",
		description:
			"[FRAME 相位] 提交问题定义:一句说得清的目标 + 已确认的约束 + 明确不做的事。" +
			"提交后进入 PLAN 相位设计验收标准。",
		parameters: Type.Object({
			goal: Type.String({ description: "锐化后的目标。别人照着这句话就能判断做完没有" }),
			constraints: Type.Array(Type.String(), {
				description: "已确认的约束/前提:人回答的、代码里读到的事实。没有就给空数组",
			}),
			nonGoals: Type.Array(Type.String(), {
				description: "明确不做的事。边界写不出来,验收标准就会漂",
			}),
		}),
		async execute(_id: string, params: any, _signal: any, _onUpdate: any, ctx: any) {
			const r = await getRuntime(ctx).frame(ctx, {
				goal: params.goal,
				constraints: params.constraints ?? [],
				nonGoals: params.nonGoals ?? [],
			});
			if ("error" in r) return toolError(r.error);
			return {
				content: [
					{
						type: "text",
						text: "问题定义已确定,进入 PLAN 相位。现在设计可执行的验收标准与任务分解,然后调用 mission_write_plan。",
					},
				],
				details: { ok: true },
			};
		},
	});

	pi.registerTool({
		name: "mission_write_plan",
		description:
			"[PLAN 相位] 原子提交 Mission 计划:验收标准(AC)+ 任务分解 + verify.sh 内容。" +
			"人工确认后系统会跑一遍基线(每条 AC 的分支必须与其 baseline 声明一致)," +
			"通过才冻结 AC 并进入 DO 相位。",
		parameters: Type.Object({
			goal: Type.String({ description: "Mission 目标" }),
			acceptanceCriteria: Type.Array(ACSchema, { minItems: 1 }),
			milestones: Type.Array(MilestoneSchema, {
				minItems: 1,
				description: "standard 档放单个里程碑即可;complex 档按里程碑拆分",
			}),
			verifyScript: Type.String({ description: "missions/scripts/verify.sh 的完整内容,含所有 AC 引用的分支" }),
		}),
		async execute(_id: string, params: any, _signal: any, _onUpdate: any, ctx: any) {
			const r = await getRuntime(ctx).writePlan(ctx, params);
			if ("error" in r) {
				return { content: [{ type: "text", text: `计划未被接受:${r.error}` }], details: { ok: false } };
			}
			return {
				content: [
					{
						type: "text",
						text: `计划已冻结,进入 DO 相位。任务顺序:${r.taskOrder.join(" → ")}。开始执行第一个任务,完成后调用 mission_submit。`,
					},
				],
				details: { ok: true },
			};
		},
	});

	pi.registerTool({
		name: "mission_submit",
		description:
			"[DO 相位] 声明当前任务已提交,触发系统判定(不等于通过)。" +
			"提交后写工具会被冻结,不要继续改代码。",
		// 无参数:判定依据(AC / quick 的验证命令)在进入 DO 之前就已冻结,
		// 提交时不接受任何"补一条标准"的入口 —— 那等于让被判定方事后选裁判(I2/I3)。
		parameters: Type.Object({}),
		async execute(_id: string, _params: any, _signal: any, _onUpdate: any, ctx: any) {
			const rt = getRuntime(ctx);
			const a = rt.active;
			if (!a) return toolError("无活动 mission");
			if (a.state.tier === "quick" && !a.quickVerifyCommand?.trim()) {
				// 正常不可达:无验证命令的 quick 输入在 startQuick 就被升档挡住了
				return toolError("quick 档缺少验证命令(判定的唯一依据),无法判定。请 /mission abort 后带 --verify 重来");
			}
			const r = await rt.applyEvent({ type: "SUBMIT", at: Date.now() }, ctx);
			if (r.error) return toolError(r.error);
			return {
				content: [
					{ type: "text", text: "已提交。判定由系统执行(verify.sh 退出码 + 独立验证者),本轮结束后自动进行。不要自行宣布通过。" },
				],
				details: { ok: true },
			};
		},
	});

	pi.registerTool({
		name: "mission_escalate",
		description:
			"[ACT 相位] 主动请求升级:L2=改方案(回 PLAN 重分解,AC 不变),L3=改问题定义(可改 AC,需人工确认)。" +
			"当你判断继续修实现不会通过时使用,附明确理由。",
		parameters: Type.Object({
			level: Type.Union([Type.Literal(2), Type.Literal(3)]),
			reason: Type.String({ description: "为什么当前层级解决不了问题" }),
		}),
		async execute(_id: string, params: any, _signal: any, _onUpdate: any, ctx: any) {
			const r = await getRuntime(ctx).applyEvent({ type: "ESCALATE", at: Date.now(), to: params.level, reason: params.reason }, ctx);
			if (r.error) return toolError(r.error);
			const msg =
				params.level === 2
					? "已升级到 L2:回到 PLAN 相位重新分解方案(AC 不变),换脑后生效。"
					: "L3 升级已提交,等待人工确认。";
			return { content: [{ type: "text", text: msg }], details: { ok: true } };
		},
	});
}

function toolError(message: string) {
	return { content: [{ type: "text", text: `已拒绝:${message}` }], details: { ok: false } };
}

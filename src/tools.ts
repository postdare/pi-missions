/**
 * pi-missions · LLM 可调用的工具(五个,按相位分发;mission_verdict 在子进程里)
 *
 *   DEFINE: mission_ask / mission_define
 *   PLAN:  mission_write_plan
 *   DO:    mission_submit
 *   ACT:   mission_escalate
 *
 * 工具越少越好。状态推进由 L0 驱动,不给 LLM 直接改 SNAPSHOT.json 的工具。
 */

import { Type } from "typebox";
import type { Runtime } from "./runtime.ts";

type GetRuntime = (ctx: any) => Runtime;

const QuestionSchema = Type.Object({
	id: Type.String({ description: "问题 id,如 Q1。用它在 settled 里指代已落定的决策" }),
	text: Type.String({ description: "问题正文。措辞具体,别问\"能详细说说需求吗\"" }),
	options: Type.Optional(Type.Array(Type.String(), { description: "可选项。给选项永远优于开放式提问" })),
	recommend: Type.String({
		description:
			"必填:你倾向的答案。没有推荐答案的问题会被直接拒绝 —— 你连倾向都没有,说明这个问题你自己还没想过。",
	}),
	impact: Type.String({ description: "必填:这个答案会改变哪条完成条件、哪个方案分支。改变不了任何东西的问题不该问" }),
});

const DoneWhenSchema = Type.Object({
	id: Type.String({ description: "完成条件 id,如 DW1。AC 的 covers 用它指代" }),
	text: Type.String({ description: "人话的完成条件,但要能判真假" }),
});

const DecisionSchema = Type.Object({
	id: Type.String({ description: "决策 id,如 D1" }),
	text: Type.String({ description: "决定了什么" }),
	why: Type.String({ description: "为什么这么定。没有理由的决策不是决策,是偏好" }),
	rejected: Type.Optional(
		Type.String({ description: "否决了什么方案。半年后有人再提同一个方案时,这一行能省掉一整轮讨论" }),
	),
	sticky: Type.Optional(
		Type.Boolean({ description: "难以逆转 + 反直觉 + 有真权衡(ADR 三条判据全中)时标 true" }),
	),
});

const ACSchema = Type.Object({
	id: Type.String({ description: "AC id,如 AC1" }),
	text: Type.String({ description: "人类可读的验收描述" }),
	verify: Type.String({ description: "verify.sh 的分支名 —— AC 的唯一执行入口,不写裸命令" }),
	covers: Type.Array(Type.String(), {
		description:
			"这条 AC 覆盖 definition.doneWhen 里的哪几条(如 [\"DW1\",\"DW2\"])。" +
			"每条 doneWhen 都必须被至少一条 AC 覆盖,每条 AC 也必须至少覆盖一条 —— 两个方向都会被机器校验。",
	}),
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
			"[DEFINE 相位] 把\"不知道就写不出验收标准\"的问题交给人。" +
			"一轮最多 3 个问题;轮次上限由档位定(standard 2 轮、complex 3 轮)——— 系统强制,不是建议。" +
			"每个问题**必须带推荐答案**:人回一句\"用你的\"就能过,这是多轮问答付得起的前提。" +
			"第二轮起还要求 settled 比上一轮增长 —— 上一轮问完什么都没定下来,就不给下一轮。" +
			"提问后本轮结束,等人回答;不需要提问就直接调用 mission_define。",
		parameters: Type.Object({
			questions: Type.Array(QuestionSchema, {
				minItems: 1,
				maxItems: 3,
				description: "只问那些答案会改变完成条件或方案分支的问题。措辞具体,给选项优于开放式提问。",
			}),
			settled: Type.Array(Type.String(), {
				description:
					"到目前为止**已经落定**的决策 id(如 [\"D1\",\"D2\"])。首轮通常为空;" +
					"第二轮起它必须比上一轮长 —— 这是你上一轮问答有产出的证明。",
			}),
		}),
		async execute(_id: string, params: any, _signal: any, _onUpdate: any, ctx: any) {
			const r = await getRuntime(ctx).ask(ctx, params.questions ?? [], params.settled ?? []);
			if ("error" in r) return toolError(r.error);
			return {
				content: [
					{
						type: "text",
						text:
							`问题已交给人(第 ${r.round} 轮,${r.questions.length} 个)。` +
							"本轮到此为止:不要继续分析,不要自问自答,等回答之后再决定是追问下一轮还是调用 mission_define。",
					},
				],
				details: { ok: true },
			};
		},
	});

	pi.registerTool({
		name: "mission_criterion",
		description:
			"[PLAN 相位 · quick 档] 冻结这次任务的判定依据,然后立刻进入 DO 开始写代码。\n" +
			"**先用只读工具看几眼相关代码再定**——没看过代码的判据只会是「样式正确显示」这种,核对时等于没有判据。\n" +
			"判据是「做完之后能观察到什么」,不是「要做什么」:把目标那句祈使句转写成可观察的状态," +
			"照抄目标会被直接拒绝。系统会机械校验(太短 / 复读目标 / 空泛且无具体锚点),不合格会退回让你重写。\n" +
			"judge 选谁来核对:默认 ai(独立验证者读 diff 核对);真机、视觉、交互这类你自己读 diff 判不了的," +
			"如实选 human —— 选 human 不丢人,硬判一个自己核实不了的判据才是把判定权还给了执行者。",
		parameters: Type.Object({
			text: Type.String({
				description:
					"一句能判真假的话。具体到哪个界面/接口/文件上的什么表现," +
					"能带上数字(断点、状态码、条数)或标识符(函数名、CSS 属性、文件名)就带上。",
			}),
			judge: Type.Union([Type.Literal("ai"), Type.Literal("human"), Type.Literal("command")], {
				description:
					"ai=独立验证者核对(默认,无人值守);human=做完由人终审(真机/视觉);" +
					"command=有现成命令能判(退出码即判定,最省也最可重放)。",
			}),
			command: Type.Optional(
				Type.String({ description: "judge=command 时必填:退出码即判定的那条命令" }),
			),
		}),
		async execute(_id: string, params: any, _signal: any, _onUpdate: any, ctx: any) {
			const rt = getRuntime(ctx);
			const judge = params.judge === "human" || params.judge === "command" ? params.judge : "ai";
			const command = String(params.command ?? "").trim();
			if (judge === "command" && !command) return toolError("judge=command 必须给 command");
			const criterion =
				judge === "command"
					? { judge: "command" as const, text: String(params.text ?? ""), command }
					: { judge, text: String(params.text ?? "") };
			const r = await rt.freezeQuickCriterion(ctx, criterion);
			if ("error" in r) return toolError(r.error);
			const who =
				judge === "command"
					? `命令 \`${command}\` 的退出码`
					: judge === "human"
						? "人工终审(做完会弹出来问)"
						: "独立验证者(它会主动找反证)";
			return {
				content: [
					{
						type: "text",
						text: `判据已冻结:${criterion.text}\n核对方:${who}\n现在进入 DO,可以改代码了;改完调用 mission_submit。`,
					},
				],
				details: { ok: true },
			};
		},
	});

	pi.registerTool({
		name: "mission_define",
		description:
			"[DEFINE 相位] 提交问题定义:目标 + **完成条件清单(doneWhen)** + 已确认的约束 + 明确不做的事。" +
			"doneWhen 是这一相位唯一有机械后果的产出 —— PLAN 的每条 AC 必须声明它覆盖哪几条," +
			"漏掉任何一条都冻结不了计划。提交后(必要时经人工确认范围)进入 PLAN 相位。",
		parameters: Type.Object({
			goal: Type.String({ description: "锐化后的目标。别人照着这句话就能判断做完没有" }),
			doneWhen: Type.Array(DoneWhenSchema, {
				minItems: 1,
				description:
					"完成条件清单:满足哪些条件就算做完了。用人话写,但每条都要能判真假 —— " +
					"\"体验良好\"这种写不成退出码的不算。PLAN 会把每条翻译成一个 verify 分支。",
			}),
			constraints: Type.Array(Type.String(), {
				description: "已确认的约束/前提:人回答的、代码里读到的事实。没有就给空数组",
			}),
			nonGoals: Type.Array(Type.String(), {
				description: "明确不做的事。边界写不出来,验收标准就会漂",
			}),
			verifySeam: Type.Optional(
				Type.String({
					description:
						"打算在哪一层验证(优先用已有的、用尽可能高的那一层):如\"已有集成测试 test/auth/*\"" +
						"、\"契约快照比对\"、\"grep 计数\"。接缝要事先约定,不留到写 AC 时临时决定。",
				}),
			),
			resolved: Type.Optional(
				Type.Array(
					Type.Object({ q: Type.String(), a: Type.String() }),
					{
						description:
							"DEFINE 问答记录。**只要调用过 mission_ask 就必须给** —— " +
							"人的回答只活在上下文里,换脑即丢,而提问额度已经烧掉了。",
					},
				),
			),
		}),
		async execute(_id: string, params: any, _signal: any, _onUpdate: any, ctx: any) {
			const r = await getRuntime(ctx).define(ctx, {
				goal: params.goal,
				doneWhen: params.doneWhen ?? [],
				constraints: params.constraints ?? [],
				nonGoals: params.nonGoals ?? [],
				verifySeam: params.verifySeam,
				resolved: params.resolved,
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
			approach: Type.Optional(
				Type.Object(
					{
						summary: Type.String({ description: "整体怎么做:动哪几个模块、接口怎么变、数据怎么迁" }),
						decisions: Type.Array(DecisionSchema, { minItems: 1 }),
					},
					{
						description:
							"方案。**complex 档必填**(standard/quick 可选)。它是 L2 升级改的那一段," +
							"也是人在计划评审页真正要读的东西 —— 只有验收标准的计划没法评审。",
					},
				),
			),
			acceptanceCriteria: Type.Array(ACSchema, { minItems: 1 }),
			milestones: Type.Array(MilestoneSchema, {
				minItems: 1,
				description: "standard 档放单个里程碑即可;complex 档按里程碑拆分",
			}),
			verifyScript: Type.String({ description: "当前 mission 独立 verify.sh 的完整内容,含所有 AC 引用的分支" }),
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
		// 无参数:判定依据(AC / quick 的判据)在进入 DO 之前就已冻结,
		// 提交时不接受任何"补一条标准"的入口 —— 那等于让被判定方事后选裁判(I2/I3)。
		parameters: Type.Object({}),
		async execute(_id: string, _params: any, _signal: any, _onUpdate: any, ctx: any) {
			const rt = getRuntime(ctx);
			const a = rt.active;
			if (!a) return toolError("无活动 mission");
			if (a.state.tier === "quick" && !a.quickCriterion) {
				// 正常不可达:没有判据的 quick 输入在 startQuick 就被升档挡住了
				return toolError("quick 档缺少判定依据,无法判定。请 /mission abort 后重开");
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

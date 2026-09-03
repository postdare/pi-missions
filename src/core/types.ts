/**
 * pi-missions · core 层共享类型
 *
 * 本文件及 core/ 下所有模块必须保持纯净:
 * 不 import pi、不读文件、不调用网络、除事件携带的 at 之外不依赖环境。
 * 它们是整个系统唯一的裁判,必须可单测。
 */

// ─────────────────────────────── 基础枚举 ───────────────────────────────

import type { TaskKind } from "./spike.ts";

export type Phase = "define" | "plan" | "do" | "check" | "act" | "done" | "halted";

export type Tier = "quick" | "standard" | "complex";

/**
 * 升级阶梯:1=改实现 2=改方案 3=改问题定义。
 * 每一级对应相位图上的一条反向边:L1 回 DO、L2 回 PLAN、L3 回 DEFINE。
 */
export type EscalationLevel = 1 | 2 | 3;

export type Role = "planner" | "executor" | "verifier" | "escalator";

/** 单角色累计 token 用量(单位:个,不是美元) */
export interface RoleTokenUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

// ─────────────────────────────── 证据 ───────────────────────────────

/**
 * hard  —— 编译/测试/lint/类型检查的退出码。由 L0 直接执行 verify.sh 采集,零模型成本。
 * semi  —— 逐条核对冻结 AC。由独立 Verifier AgentSession 产出。
 * human —— 人工终审。人在执行者之外,所以它满足 I3;代价是**不可重放** ——
 *          mission 结束后这条判据没有留下能重跑的东西,升档时要提示补机械验证。
 * soft  —— 执行者自述。只能触发 ACT,永远不能触发 PASS。
 */
export type EvidenceLevel = "hard" | "semi" | "human" | "soft";

/**
 * 自然语言裁判(semi/human)的失败类别。
 *
 * 存在的唯一理由是**熔断**:breaker 的 normalize() 是为编译/测试输出设计的
 * (抓测试标识、异常类型、断言种类),自然语言理由里它抽不到稳定 token,
 * 每次措辞一变签名就变 —— sameSignatureCount 恒为 1,I4 的升级阶梯整个失效。
 *
 * 只留三类,边界要足够清楚:类别摇摆等于签名摇摆,等于熔断又失效了。
 * 粒度宁可粗 —— 见 breaker.ts 顶部的取舍。
 */
export type FailureCategory =
	/** 判据要求的东西没做,或只做了一部分 */
	| "missing"
	/** 做了,但行为/结果不对 */
	| "incorrect"
	/** 把本来正常的东西改坏了 */
	| "regression";

export type EvidenceResult = "pass" | "fail" | "inconclusive";

export interface Evidence {
	level: EvidenceLevel;
	/** 对应的 verify.sh 分支名(如 "auth-integration"),即验收的可执行 id */
	acId: string;
	result: EvidenceResult;
	/** 原始输出(已截断)。hard 证据据此生成失败签名,并用于归档 */
	raw: string;
	/**
	 * 自然语言裁判给出的失败类别。semi 失败时必填 —— 失败签名用它算,
	 * 而不是用措辞每次都变的 rationale(见 FailureCategory)。
	 * human 不填:人不该被要求做分类,它的签名固定为"人说不行"。
	 */
	failureTag?: FailureCategory;
	exitCode?: number;
	/** 完整执行命令(可选) */
	command?: string;
	/** 开始时间戳(可选) */
	startedAt?: number;
	/** 执行耗时毫秒数(可选) */
	durationMs?: number;
	/** 完整 stdout(可选) */
	stdout?: string;
	/** 完整 stderr(可选) */
	stderr?: string;
}

export type VerdictOutcome = "pass" | "fail" | "inconclusive";

/**
 * 无结论的成因。两者的处置完全不同,别合并:
 * - evidence 该采的证据没采到 —— 执行者补机械证据后重试有意义
 * - judge    裁判本身不可用(核验模型报错、人工终审弹不出来)—— 执行者做什么都没用,
 *            重试只是拿同一个坏裁判再空转一轮,直接停机等人
 *
 * 曾经还有一个 `env`(环境指纹漂移)。取消了 —— 见 core/verdict.ts 文件头。
 */
export type InconclusiveCause = "evidence" | "judge";

export interface Verdict {
	outcome: VerdictOutcome;
	/** 失败签名。仅 outcome==="fail" 时有值,用于熔断计数 */
	signature?: string;
	failing: Evidence[];
	/** 人类可读的判定理由,直接写入 LOG.md */
	reason: string;
	/** 无结论的具体成因,决定停机文案与是否值得重试。见 InconclusiveCause */
	inconclusiveCause?: InconclusiveCause;
	/** 缺证据的 AC 列表(用于缺失验收证据时明确提示) */
	missingAcIds?: string[];
}

// ─────────────────────────────── 任务与 Mission ───────────────────────────────

export type TaskStatus = "pending" | "running" | "done" | "blocked";

export interface TaskState {
	id: string;
	/** impl = 写代码;spike = 打探针出结论(见 core/spike.ts)。缺省 impl */
	kind?: TaskKind;
	status: TaskStatus;
	/** 已进行的 do→check 周期数,从 1 开始计 */
	attempts: number;
	/** 上一次失败的签名 */
	lastSignature?: string;
	/** 上一次失败的人类可读原因(注入 State Card 用) */
	lastFailureReason?: string;
	/** 同一签名连续出现次数。签名变化时重置为 1 */
	sameSignatureCount: number;
	/** 连续 INCONCLUSIVE 次数。判不出结论时防死循环,达到上限直接停机 */
	inconclusiveStreak: number;
	/** 最近一次 INCONCLUSIVE 的成因。UI 的措辞按它分流 —— 说错成因会把人指到错误的方向 */
	lastInconclusiveCause?: InconclusiveCause;
	/** 最近一次提交时的工作区树指纹(用于判定原样重交) */
	submittedTreeFp?: string | null;
	/** 上一轮因缺证据判 inconclusive 时挂上的待补证据要求 */
	awaitingEvidence?: {
		reason: string;
		acIds: string[];
		treeFp: string | null;
	} | null;
}

export interface EscalationRecord {
	at: number;
	taskId: string;
	from: EscalationLevel;
	to: EscalationLevel;
	signature?: string;
	reason: string;
}

/** 升档判据的机械可测输入(I7:不让 LLM 自评复杂度) */
export interface MissionMetrics {
	/** 本 mission 内被 edit/write 触碰过的文件(去重) */
	touchedFiles: string[];
	/** 是否触及公开 API(由配置的 glob 判定) */
	touchedPublicApi: boolean;
}

export interface MissionState {
	missionId: string;
	tier: Tier;
	phase: Phase;
	currentTask: string | null;
	/** 任务推进顺序。complex 档由里程碑展开而来 */
	taskOrder: string[];
	tasks: Record<string, TaskState>;
	escalation: {
		level: EscalationLevel;
		history: EscalationRecord[];
	};
	/**
	 * Plan 冻结时记录的 git HEAD commit hash。
	 * verifier 的 diff 基准:从这次冻结开始的所有改动才是本次 mission 的产出,
	 * 从 HEAD 开始 diff 会把冻结前的工作也混进去。
	 */
	baseCommit: string | null;
	/**
	 * 换脑挂起原因;null = 无挂起。
	 * 挂起期间闸门硬阻断一切写操作,唯一出口是 /mission next(HANDOFF_DONE)。
	 * I5 的物理实现:升级后的重新规划绝不在被污染的上下文里进行。
	 */
	pendingHandoff: string | null;
	/** taskId → 执行该任务的 session 文件路径(换脑后更新) */
	sessionMap: Record<string, string>;
	/** DEFINE 相位已用掉的提问轮数(闸门见 core/define.ts) */
	defineAsks: number;
	/**
	 * 上一轮提问时记下的"已落定决策 id"快照。
	 * 结账判据靠它判断上一轮问答有没有推进决策(见 core/define.ts 的 evaluateAsk)——
	 * 必须落盘:换脑之后新会话不知道上一轮问过什么,内存态不可信。
	 */
	defineSettled: string[];
	/**
	 * 各轮问答记录(人答的 + 回落到推荐的),按轮次累积。
	 * 必须落盘:换脑之后模型照抄这里的记录填 mission_define.resolved,
	 * 没有它提问额度就白烧了(同一判据,define() 里那句"问过就必须交 resolved"是它的下游)。
	 */
	defineAnswers: { q: string; a: string }[];
	/**
	 * 计划评审的打回记账。判据见 core/review.ts:连续打回到上限就转 L3。
	 * notes 必须落盘 —— 打回意见只活在上下文里的话,换脑之后 planner 又只剩 1 bit。
	 */
	planReview: { rejections: number; notes: string[] };
	/**
	 * 已经跑完的探针数(不论成败)。
	 * 不能靠扫 tasks 得知:重写计划时 PLAN_FROZEN 只保留新 taskOrder 里的任务,
	 * 跑过的 spike 会从 tasks 里消失 —— 额度必须自己记账。
	 */
	spikesRun: number;
	/** 按角色分账的累计成本(美元),来自 message_end 的 usage.cost.total */
	cost: Partial<Record<Role, number>>;
	/**
	 * 按角色分账的累计 token 用量。与 cost 并列的原因:
	 * 自建网关常常不报价(usage.cost.total = 0),美元账是空的,
	 * 但 token 账永远是真的 —— 成本优化只能看它。
	 */
	tokens?: Partial<Record<Role, RoleTokenUsage>>;
	metrics: MissionMetrics;
	updatedAt: number;
}

// ─────────────────────────────── 状态机 I/O ───────────────────────────────

export type MissionEvent =
	/** DEFINE 用掉一轮提问(闸门判定在 core/define.ts,机器只记账 + 存结账快照) */
	| { type: "DEFINE_ASKED"; at: number; settled: string[] }
	/** 人对第 N 轮提问作答(问答页收到的答案,已按 core/define.ts 的 normalizeAskAnswers 规整) */
	| { type: "DEFINE_ANSWERED"; at: number; answers: { q: string; a: string }[] }
	/** 问题定义完成,进入 PLAN。goal 由调用方写进 plan,机器只管相位 */
	| { type: "DEFINE_DONE"; at: number }
	| {
			type: "PLAN_FROZEN";
			at: number;
			taskOrder?: string[];
			spikes?: string[];
			/** 冻结时的 git HEAD,verifier 的 diff 基准。首次冻结必传,重冻结(L2/L3)可不传 */
			baseCommit?: string | null;
			sessionFile?: string;
	  }
	/** 人工在计划评审页打回。达到上限时机器直接转 DEFINE(判据在 core/review.ts) */
	| { type: "PLAN_REJECTED"; at: number; comment: string }
	| { type: "SUBMIT"; at: number; treeFp?: string | null }
	| { type: "VERDICT"; at: number; verdict: Verdict }
	/** ACT 相位完成调整,回到 DO 重试。act 相位一轮对话结束后由 tick 发出 */
	| { type: "ADJUST_DONE"; at: number }
	/** 人工/LLM 主动升级(熔断自动升级走 VERDICT 内部判定,不经此事件) */
	| { type: "ESCALATE"; at: number; to: 2 | 3; reason: string }
	/** L3 需要人工确认;确认后重写 MISSION.md */
	| { type: "ESCALATION_CONFIRMED"; at: number }
	| { type: "ESCALATION_REJECTED"; at: number }
	/** 请求换脑(上下文水位、人工 /mission next)。进入 pendingHandoff 硬阻断 */
	| { type: "HANDOFF_REQUEST"; at: number; reason: string }
	/** 换脑完成(新会话 session_start)。解除硬阻断 */
	| { type: "HANDOFF_DONE"; at: number; sessionFile?: string; token?: string; revision?: number }
	/** newSession 被取消或人工恢复。显式解除换脑挂起,不允许 runtime 直接改 state */
	| { type: "HANDOFF_CANCELLED"; at: number; reason: string }
	/** 进程退出打断 CHECK/ACT。恢复时统一回 DO,尝试次数保持不变 */
	| { type: "RECOVER_INTERRUPTED_CHECK"; at: number; from: "check" | "act" }
	/** 机械升档(tier.ts 判定)。quick→standard 会补落盘(PERSIST_PLAN) */
	| { type: "PROMOTE_TIER"; at: number; to: Tier; reason: string }
	/** 独立 AgentSession 的模型费用与 token 用量。只记账,不参与相位判定。 */
	| { type: "RECORD_ROLE_COST"; at: number; role: Role; amount: number; tokens?: RoleTokenUsage }
	/** 工具结果记录改动面，供机械升档使用 */
	| { type: "RECORD_TOUCHED_FILE"; at: number; path: string; publicApi: boolean }
	| { type: "ABORT"; at: number; reason: string };

/**
 * 状态机产出的副作用。机器本身不执行任何一条,
 * 由 hooks 层翻译成 pi API 调用。这是 core 保持纯净的关键。
 */
export type Effect =
	| { type: "SET_TOOLS"; phase: Phase }
	| { type: "SET_ROLE"; role: Role }
	/** 换脑:创建干净上下文。I5 要求每次升级必须换 */
	| { type: "HANDOFF"; reason: string }
	| { type: "LOG"; line: string }
	| { type: "CONFIRM"; question: string }
	| { type: "ADVANCE_TASK"; taskId: string }
	| { type: "FREEZE_AC" }
	/** quick 升 standard 时把内存中的计划补写到仓库 */
	| { type: "PERSIST_PLAN" }
	| { type: "ARCHIVE_PLAN"; reason: string }
	/** mission 结束/中止:恢复用户工具集、模型与 thinking level */
	| { type: "RESTORE" }
	| { type: "NOTIFY"; level: "info" | "warning" | "error"; message: string };

export interface TransitionResult {
	state: MissionState;
	effects: Effect[];
	/** 非法迁移时填充。状态保持不变,调用方应记录并忽略该事件 */
	error?: string;
}

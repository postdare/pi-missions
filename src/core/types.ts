/**
 * pi-missions · core 层共享类型
 *
 * 本文件及 core/ 下所有模块必须保持纯净:
 * 不 import pi、不读文件、不调用网络、除事件携带的 at 之外不依赖环境。
 * 它们是整个系统唯一的裁判,必须可单测。
 */

// ─────────────────────────────── 基础枚举 ───────────────────────────────

export type Phase = "plan" | "do" | "check" | "act" | "done" | "halted";

export type Tier = "quick" | "standard" | "complex";

/** 升级阶梯:1=改实现 2=改方案 3=改问题定义 */
export type EscalationLevel = 1 | 2 | 3;

export type Role = "planner" | "executor" | "verifier" | "escalator";

// ─────────────────────────────── 证据 ───────────────────────────────

/**
 * hard —— 编译/测试/lint/类型检查的退出码。由 L0 直接执行 verify.sh 采集,零模型成本。
 * semi —— 逐条核对冻结 AC。由独立 Verifier 子进程产出。
 * soft —— 执行者自述。只能触发 ACT,永远不能触发 PASS。
 */
export type EvidenceLevel = "hard" | "semi" | "soft";

export type EvidenceResult = "pass" | "fail" | "inconclusive";

export interface Evidence {
	level: EvidenceLevel;
	/** 对应的 verify.sh 分支名(如 "auth-integration"),即验收的可执行 id */
	acId: string;
	result: EvidenceResult;
	/** 原始输出(已截断)。用于生成失败签名与归档 */
	raw: string;
	exitCode?: number;
	/** 采集该证据时的环境指纹。与 mission 记录不符则整份判定 inconclusive */
	envFingerprint?: string;
}

export type VerdictOutcome = "pass" | "fail" | "inconclusive";

export interface Verdict {
	outcome: VerdictOutcome;
	/** 失败签名。仅 outcome==="fail" 时有值,用于熔断计数 */
	signature?: string;
	failing: Evidence[];
	/** 人类可读的判定理由,直接写入 LOG.md */
	reason: string;
}

// ─────────────────────────────── 任务与 Mission ───────────────────────────────

export type TaskStatus = "pending" | "running" | "done" | "blocked";

export interface TaskState {
	id: string;
	status: TaskStatus;
	/** 已进行的 do→check 周期数,从 1 开始计 */
	attempts: number;
	/** 上一次失败的签名 */
	lastSignature?: string;
	/** 上一次失败的人类可读原因(注入 State Card 用) */
	lastFailureReason?: string;
	/** 同一签名连续出现次数。签名变化时重置为 1 */
	sameSignatureCount: number;
	/** 连续 INCONCLUSIVE 次数。环境漂移时防死循环,达到上限直接停机 */
	inconclusiveStreak: number;
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
	/** Plan 冻结时记录的环境指纹 */
	envFingerprint: string | null;
	/**
	 * 换脑挂起原因;null = 无挂起。
	 * 挂起期间闸门硬阻断一切写操作,唯一出口是 /mission next(HANDOFF_DONE)。
	 * I5 的物理实现:升级后的重新规划绝不在被污染的上下文里进行。
	 */
	pendingHandoff: string | null;
	/** taskId → 执行该任务的 session 文件路径(换脑后更新) */
	sessionMap: Record<string, string>;
	/** 按角色分账的累计成本(美元),来自 message_end 的 usage.cost.total */
	cost: Partial<Record<Role, number>>;
	metrics: MissionMetrics;
	updatedAt: number;
}

// ─────────────────────────────── 状态机 I/O ───────────────────────────────

export type MissionEvent =
	| { type: "PLAN_FROZEN"; at: number; taskOrder?: string[] }
	| { type: "SUBMIT"; at: number }
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
	| { type: "HANDOFF_DONE"; at: number; sessionFile?: string }
	/** 机械升档(tier.ts 判定)。quick→standard 会补落盘(PERSIST_PLAN) */
	| { type: "PROMOTE_TIER"; at: number; to: Tier; reason: string }
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

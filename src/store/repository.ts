/**
 * pi-missions · store/repository
 *
 * v2 唯一持久化入口。SNAPSHOT.json 是机器真相源；MISSION.md 与 verify.sh
 * 是 snapshot 指向的不可变 generation。计划发布顺序固定为 generation → snapshot；
 * CURRENT 只在 create/activate 时更新，普通 revision 提交不重写定位提示。
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { MissionState } from "../core/types.ts";
import type { MissionPlan } from "./mission.ts";
import { renderMissionMd } from "./mission.ts";
import { currentPointer, statePaths, type RepoLayout } from "./paths.ts";
import { atomicWriteJson } from "./io.ts";

export const SNAPSHOT_SCHEMA_VERSION = 2 as const;

export interface SnapshotArtifacts {
	generation: number;
	missionHash: string;
	verifyHash: string;
}

export interface MissionSnapshotV2 {
	schemaVersion: typeof SNAPSHOT_SCHEMA_VERSION;
	revision: number;
	missionId: string;
	plan: MissionPlan;
	state: MissionState;
	artifacts: SnapshotArtifacts;
	handoff: HandoffRecord | null;
}

export interface HandoffRecord {
	token: string;
	parentSession: string;
	requestedRevision: number;
	reason: string;
}

export interface SnapshotContent {
	plan: MissionPlan;
	state: MissionState;
	handoff: HandoffRecord | null;
}

export interface CurrentRefV2 {
	schemaVersion: typeof SNAPSHOT_SCHEMA_VERSION;
	missionId: string;
	revision: number;
}

export type SnapshotLoadResult =
	| { ok: true; snapshot: MissionSnapshotV2 }
	| { ok: false; code: "missing" | "corrupt" | "conflict"; error: string };

export interface StagedPlan {
	missionId: string;
	expectedRevision: number;
	generation: number;
	tempDir: string;
	finalDir: string;
	missionMd: string;
	verifySh: string;
	artifacts: SnapshotArtifacts;
}

const MISSION_ID_RE = /^[a-z0-9][a-z0-9-]{0,100}$/;

export class MissionRepository {
	private readonly layout: RepoLayout;

	constructor(layout: RepoLayout) {
		this.layout = layout;
	}

	/**
	 * 首次落盘。
	 *
	 * `handoff` 必须由调用方传进来:quick 升档 standard 时,pendingHandoff 与 handoff
	 * record 是同一次 applyEvent 里生成的,而 record 只在内存。这里若硬写 null,磁盘上
	 * 就留下一个"pendingHandoff 有值、handoff 为 null"的快照 —— 当场 /mission next
	 * 还能用(读内存),换个会话重附着就变成"换脑状态损坏:缺少 handoff token",
	 * 而换脑本身就是开新会话,于是这条路必然卡死(真实事故)。
	 */
	create(plan: MissionPlan, state: MissionState, handoff: HandoffRecord | null = null): MissionSnapshotV2 {
		this.assertIdentity(plan.missionId, plan, state);
		const sp = statePaths(this.layout, plan.missionId);
		if (fs.existsSync(sp.snapshotJson)) throw new Error(`mission 已存在:${plan.missionId}`);
		fs.mkdirSync(sp.generationsDir, { recursive: true });
		const staged = this.stageFiles(plan.missionId, 0, 1, plan);
		this.publishGeneration(staged);
		const snapshot: MissionSnapshotV2 = {
			schemaVersion: SNAPSHOT_SCHEMA_VERSION,
			revision: 1,
			missionId: plan.missionId,
			plan,
			state,
			artifacts: staged.artifacts,
			handoff,
		};
		this.writeSnapshot(snapshot);
		this.setCurrent(snapshot);
		return snapshot;
	}

	load(missionId: string): SnapshotLoadResult {
		try {
			this.assertMissionId(missionId);
			const sp = statePaths(this.layout, missionId);
			if (!fs.existsSync(sp.snapshotJson)) {
				return { ok: false, code: "missing", error: `找不到 v2 mission "${missionId}"` };
			}
			const value: unknown = migrate(JSON.parse(fs.readFileSync(sp.snapshotJson, "utf8")));
			if (!isSnapshot(value) || value.missionId !== missionId) {
				return { ok: false, code: "corrupt", error: `mission "${missionId}" 的 SNAPSHOT.json 格式无效` };
			}
			this.assertIdentity(missionId, value.plan, value.state);
			if (
				hashText(renderMissionMd(value.plan)) !== value.artifacts.missionHash ||
				hashText(value.plan.verifyScript) !== value.artifacts.verifyHash
			) {
				return { ok: false, code: "corrupt", error: `mission "${missionId}" 的 plan 与 generation hash 不匹配` };
			}
			const missionMd = sp.generationMissionMd(value.artifacts.generation);
			const verifySh = sp.generationVerifySh(value.artifacts.generation);
			if (!fs.existsSync(missionMd) || !fs.existsSync(verifySh)) {
				return { ok: false, code: "corrupt", error: `mission "${missionId}" 的 generation 文件缺失` };
			}
			if (hashFile(missionMd) !== value.artifacts.missionHash || hashFile(verifySh) !== value.artifacts.verifyHash) {
				return { ok: false, code: "corrupt", error: `mission "${missionId}" 的冻结文件 hash 不匹配` };
			}
			return { ok: true, snapshot: value };
		} catch (error) {
			return { ok: false, code: "corrupt", error: errorMessage(error) };
		}
	}

	commit(
		missionId: string,
		expectedRevision: number,
		content: SnapshotContent,
	): SnapshotLoadResult {
		const loaded = this.load(missionId);
		if (!loaded.ok) return loaded;
		if (loaded.snapshot.revision !== expectedRevision) {
			return conflict(missionId, expectedRevision, loaded.snapshot.revision);
		}
		this.assertIdentity(missionId, content.plan, content.state);
		const renderedHash = hashText(renderMissionMd(content.plan));
		const verifyHash = hashText(content.plan.verifyScript);
		if (
			renderedHash !== loaded.snapshot.artifacts.missionHash ||
			verifyHash !== loaded.snapshot.artifacts.verifyHash
		) {
			const staged = this.stageFiles(missionId, expectedRevision, expectedRevision + 1, content.plan);
			return this.commitStaged(staged, content);
		}
		const snapshot: MissionSnapshotV2 = {
			...loaded.snapshot,
			revision: expectedRevision + 1,
			plan: content.plan,
			state: content.state,
			handoff: content.handoff,
		};
		this.writeSnapshot(snapshot);
		return { ok: true, snapshot };
	}

	stagePlan(missionId: string, expectedRevision: number, plan: MissionPlan): StagedPlan {
		const loaded = this.load(missionId);
		if (!loaded.ok) throw new Error(loaded.error);
		if (loaded.snapshot.revision !== expectedRevision) {
			throw new Error(conflictMessage(missionId, expectedRevision, loaded.snapshot.revision));
		}
		this.assertIdentity(missionId, plan, loaded.snapshot.state);
		return this.stageFiles(missionId, expectedRevision, expectedRevision + 1, plan);
	}

	commitStaged(staged: StagedPlan, content: SnapshotContent): SnapshotLoadResult {
		const loaded = this.load(staged.missionId);
		if (!loaded.ok) {
			this.discardStaged(staged);
			return loaded;
		}
		if (loaded.snapshot.revision !== staged.expectedRevision) {
			this.discardStaged(staged);
			return conflict(staged.missionId, staged.expectedRevision, loaded.snapshot.revision);
		}
		this.assertIdentity(staged.missionId, content.plan, content.state);
		if (
			hashText(renderMissionMd(content.plan)) !== staged.artifacts.missionHash ||
			hashText(content.plan.verifyScript) !== staged.artifacts.verifyHash
		) {
			this.discardStaged(staged);
			return {
				ok: false,
				code: "corrupt",
				error: `mission "${staged.missionId}" 的 staged generation 与提交 plan 不一致`,
			};
		}
		this.publishGeneration(staged);
		const snapshot: MissionSnapshotV2 = {
			schemaVersion: SNAPSHOT_SCHEMA_VERSION,
			revision: staged.expectedRevision + 1,
			missionId: staged.missionId,
			plan: content.plan,
			state: content.state,
			artifacts: staged.artifacts,
			handoff: content.handoff,
		};
		this.writeSnapshot(snapshot);
		return { ok: true, snapshot };
	}

	discardStaged(staged: StagedPlan): void {
		try {
			fs.rmSync(staged.tempDir, { recursive: true, force: true });
		} catch {
			/* 临时 generation 留给下次启动清理，不影响已发布 snapshot */
		}
	}

	readCurrent(): SnapshotLoadResult {
		try {
			const file = currentPointer(this.layout);
			if (!fs.existsSync(file)) return { ok: false, code: "missing", error: "没有 CURRENT mission" };
			const value: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
			if (!isCurrentRef(value)) return { ok: false, code: "corrupt", error: "CURRENT 格式无效" };
			const loaded = this.load(value.missionId);
			if (!loaded.ok) return loaded;
			// CURRENT 只负责定位 mission，snapshot 才是 revision 真相源。
			// 普通 commit 不重写 CURRENT，因此其 revision 允许落后。
			return loaded;
		} catch (error) {
			return { ok: false, code: "corrupt", error: errorMessage(error) };
		}
	}

	/** 显式切换 CURRENT；普通 revision 提交不需要重写定位提示。 */
	activate(missionId: string): SnapshotLoadResult {
		const loaded = this.load(missionId);
		if (!loaded.ok) return loaded;
		this.setCurrent(loaded.snapshot);
		return loaded;
	}

	list(): SnapshotLoadResult[] {
		let dirs: fs.Dirent[];
		try {
			dirs = fs.readdirSync(this.layout.state, { withFileTypes: true });
		} catch {
			return [];
		}
		// 没有 SNAPSHOT.json 的目录不是"损坏的 mission",它根本就不是 mission ——
		// quick 档(inMemory)留下的日志目录、人手工建的目录都长这样。
		// 把它们当损坏项报错,只会在每次开面板时弹一条谁也修不了的红字。
		return dirs
			.filter((d) => d.isDirectory() && MISSION_ID_RE.test(d.name))
			.filter((d) => fs.existsSync(statePaths(this.layout, d.name).snapshotJson))
			.map((d) => this.load(d.name));
	}

	generationMissionMd(snapshot: MissionSnapshotV2): string {
		return statePaths(this.layout, snapshot.missionId).generationMissionMd(snapshot.artifacts.generation);
	}

	generationVerifySh(snapshot: MissionSnapshotV2): string {
		return statePaths(this.layout, snapshot.missionId).generationVerifySh(snapshot.artifacts.generation);
	}

	verifyScriptPath(missionId: string, generation: number): string {
		this.assertMissionId(missionId);
		return statePaths(this.layout, missionId).generationVerifySh(generation);
	}

	private stageFiles(
		missionId: string,
		expectedRevision: number,
		generation: number,
		plan: MissionPlan,
	): StagedPlan {
		this.assertMissionId(missionId);
		const sp = statePaths(this.layout, missionId);
		fs.mkdirSync(sp.generationsDir, { recursive: true });
		const tempDir = path.join(sp.generationsDir, `.tmp-${generation}-${crypto.randomUUID()}`);
		const finalDir = sp.generationDir(generation);
		// generation 编号总是 expectedRevision + 1，因此同名目录不可能被当前 snapshot 引用。
		// 它只能是上次崩溃在“发布 generation → 替换 snapshot”之间留下的孤儿。
		fs.rmSync(finalDir, { recursive: true, force: true });
		for (const entry of fs.readdirSync(sp.generationsDir)) {
			if (entry.startsWith(`.tmp-${generation}-`)) {
				fs.rmSync(path.join(sp.generationsDir, entry), { recursive: true, force: true });
			}
		}
		fs.mkdirSync(tempDir, { recursive: false });
		const missionMd = path.join(tempDir, "MISSION.md");
		const verifySh = path.join(tempDir, "verify.sh");
		fs.writeFileSync(missionMd, renderMissionMd(plan), "utf8");
		fs.writeFileSync(verifySh, plan.verifyScript, "utf8");
		fs.chmodSync(verifySh, 0o755);
		return {
			missionId,
			expectedRevision,
			generation,
			tempDir,
			finalDir,
			missionMd,
			verifySh,
			artifacts: {
				generation,
				missionHash: hashFile(missionMd),
				verifyHash: hashFile(verifySh),
			},
		};
	}

	private publishGeneration(staged: StagedPlan): void {
		if (fs.existsSync(staged.finalDir)) throw new Error(`generation 已存在:${staged.generation}`);
		fs.renameSync(staged.tempDir, staged.finalDir);
		staged.missionMd = path.join(staged.finalDir, "MISSION.md");
		staged.verifySh = path.join(staged.finalDir, "verify.sh");
	}

	private writeSnapshot(snapshot: MissionSnapshotV2): void {
		const file = statePaths(this.layout, snapshot.missionId).snapshotJson;
		atomicWriteJson(file, snapshot);
	}

	private setCurrent(snapshot: MissionSnapshotV2): void {
		const ref: CurrentRefV2 = {
			schemaVersion: SNAPSHOT_SCHEMA_VERSION,
			missionId: snapshot.missionId,
			revision: snapshot.revision,
		};
		atomicWriteJson(currentPointer(this.layout), ref);
	}

	private assertIdentity(missionId: string, plan: MissionPlan, state: MissionState): void {
		this.assertMissionId(missionId);
		if (plan.missionId !== missionId || state.missionId !== missionId) {
			throw new Error(`mission identity 不一致:${missionId}`);
		}
	}

	private assertMissionId(missionId: string): void {
		if (!MISSION_ID_RE.test(missionId)) throw new Error(`非法 mission id:${missionId}`);
	}
}

function hashText(text: string): string {
	return `sha256:${crypto.createHash("sha256").update(text).digest("hex")}`;
}

function hashFile(file: string): string {
	return hashText(fs.readFileSync(file, "utf8"));
}

function conflict(missionId: string, expected: number, actual: number): SnapshotLoadResult {
	return {
		ok: false,
		code: "conflict",
		error: conflictMessage(missionId, expected, actual),
	};
}

function conflictMessage(missionId: string, expected: number, actual: number): string {
	return `mission "${missionId}" revision 冲突:expected=${expected},actual=${actual}`;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isSnapshot(value: unknown): value is MissionSnapshotV2 {
	if (!value || typeof value !== "object") return false;
	const v = value as Partial<MissionSnapshotV2>;
	return (
		v.schemaVersion === SNAPSHOT_SCHEMA_VERSION &&
		Number.isInteger(v.revision) &&
		(v.revision ?? 0) > 0 &&
		typeof v.missionId === "string" &&
		isPlan(v.plan) &&
		isState(v.state) &&
		!!v.artifacts &&
		Number.isInteger(v.artifacts.generation) &&
		typeof v.artifacts.missionHash === "string" &&
		typeof v.artifacts.verifyHash === "string" &&
		(v.handoff === null ||
			(!!v.handoff &&
				typeof v.handoff.token === "string" &&
				typeof v.handoff.parentSession === "string" &&
				Number.isInteger(v.handoff.requestedRevision) &&
				typeof v.handoff.reason === "string"))
	);
}

function isPlan(value: unknown): value is MissionPlan {
	if (!value || typeof value !== "object") return false;
	const v = value as Partial<MissionPlan>;
	return (
		typeof v.missionId === "string" &&
		(v.tier === "quick" || v.tier === "standard" || v.tier === "complex") &&
		typeof v.goal === "string" &&
		Array.isArray(v.acceptanceCriteria) &&
		Array.isArray(v.milestones) &&
		typeof v.verifyScript === "string" &&
		typeof v.createdAt === "number"
	);
}

/**
 * MissionState 的结构校验。**类型里是必填的字段,这里就要逐条查到** ——
 * 漏掉一条,坏快照就会被放进 core,然后在某个纯函数里以 `undefined is not
 * iterable` 的形态炸掉,离出错的地方隔着十几帧。加字段时同步加校验。
 */
/**
 * 就地补齐 v2 之后新增的 state 字段。
 *
 * `isState` 是严格的:少一个字段就判 corrupt(那是 I1 的防线 —— 内存不可信,
 * 盘上的东西必须自证完整)。但严格校验遇上"给 MissionState 加字段"就会把
 * **盘上所有既有 mission 一次性判死**,而它们只是写在这个字段存在之前。
 *
 * 所以新增字段走这里补缺省,不走放宽校验。补的值必须是"这个字段出现之前
 * 系统实际的行为",而不是最方便的值:
 *
 * - `replanCause` —— 缺省 null(= 不锁 AC)。这个字段出现之前没有任何 AC 闸门,
 *   null 就是当时的真实行为。代价是一份正卡在 L2 重规划中途的旧快照,升级后
 *   那一次 AC 改动拦不住;窗口只有"升级瞬间恰好停在 L2 重规划"这一种,
 *   而计划评审仍然会看到它。相比之下把所有 mission 判死要糟得多。
 */
function migrate(value: unknown): unknown {
	if (!value || typeof value !== "object") return value;
	const state = (value as { state?: Record<string, unknown> }).state;
	if (state && typeof state === "object" && !("replanCause" in state)) {
		state.replanCause = null;
	}
	return value;
}

function isState(value: unknown): value is MissionState {
	if (!value || typeof value !== "object") return false;
	const v = value as Partial<MissionState>;
	return (
		typeof v.missionId === "string" &&
		(v.tier === "quick" || v.tier === "standard" || v.tier === "complex") &&
		["define", "plan", "do", "check", "act", "done", "halted"].includes(String(v.phase)) &&
		(v.currentTask === null || typeof v.currentTask === "string") &&
		Array.isArray(v.taskOrder) &&
		!!v.tasks &&
		typeof v.tasks === "object" &&
		!!v.escalation &&
		typeof v.escalation === "object" &&
		Array.isArray(v.escalation.history) &&
		(v.baseCommit === null || typeof v.baseCommit === "string") &&
		(v.pendingHandoff === null || typeof v.pendingHandoff === "string") &&
		!!v.sessionMap &&
		typeof v.sessionMap === "object" &&
		typeof v.defineAsks === "number" &&
		Array.isArray(v.defineSettled) &&
		Array.isArray(v.defineAnswers) &&
		!!v.planReview &&
		Array.isArray(v.planReview.notes) &&
		typeof v.spikesRun === "number" &&
		(v.replanCause === null || v.replanCause === "escalation" || v.replanCause === "spike") &&
		typeof v.scoutRounds === "number" &&
		Array.isArray(v.scoutAsked) &&
		Array.isArray(v.scoutFindings) &&
		!!v.cost &&
		typeof v.cost === "object" &&
		!!v.tokens &&
		typeof v.tokens === "object" &&
		!!v.metrics &&
		Array.isArray(v.metrics.touchedFiles) &&
		typeof v.metrics.touchedPublicApi === "boolean" &&
		typeof v.updatedAt === "number"
	);
}

function isCurrentRef(value: unknown): value is CurrentRefV2 {
	if (!value || typeof value !== "object") return false;
	const v = value as Partial<CurrentRefV2>;
	return (
		v.schemaVersion === SNAPSHOT_SCHEMA_VERSION &&
		typeof v.missionId === "string" &&
		Number.isInteger(v.revision) &&
		(v.revision ?? 0) > 0
	);
}

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { initialState } from "../src/core/machine.ts";
import type { MissionPlan } from "../src/store/mission.ts";
import { currentPointer, layout } from "../src/store/paths.ts";
import { MissionRepository } from "../src/store/repository.ts";

function fixture() {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-missions-repo-"));
	const missionId = "2026-09-02-repository-test";
	const plan: MissionPlan = {
		missionId,
		tier: "standard",
		goal: "验证 v2 repository",
		acceptanceCriteria: [],
		milestones: [],
		verifyScript: "",
		createdAt: Date.now(),
	};
	const state = initialState({ missionId, tier: "standard", taskOrder: [] });
	return { tmp, missionId, plan, state, repo: new MissionRepository(layout(tmp, "missions")) };
}

test("v2 repository:create/load 将 plan 与 state 绑定到同一 revision", () => {
	const { repo, missionId, plan, state } = fixture();
	const created = repo.create(plan, state);
	assert.equal(created.schemaVersion, 2);
	assert.equal(created.revision, 1);

	const loaded = repo.load(missionId);
	assert.ok(loaded.ok, loaded.error);
	assert.deepEqual(loaded.snapshot.plan, plan);
	assert.deepEqual(loaded.snapshot.state, state);
	assert.equal(repo.readCurrent().ok, true);
	assert.ok(fs.existsSync(repo.generationMissionMd(created)));
	assert.ok(fs.existsSync(repo.generationVerifySh(created)));
});

test("v2 repository:CAS 拒绝陈旧 revision", () => {
	const { repo, missionId, plan, state } = fixture();
	repo.create(plan, state);
	const committed = repo.commit(missionId, 1, { plan, state: { ...state, updatedAt: 1 }, handoff: null });
	assert.ok(committed.ok, committed.error);
	assert.equal(committed.snapshot.revision, 2);

	const stale = repo.commit(missionId, 1, { plan, state: { ...state, updatedAt: 2 }, handoff: null });
	assert.equal(stale.ok, false);
	if (!stale.ok) {
		assert.equal(stale.code, "conflict");
		assert.match(stale.error, /expected=1,actual=2/);
	}
});

test("v2 repository:冻结文件被改后拒绝加载", () => {
	const { repo, missionId, plan, state } = fixture();
	const created = repo.create(plan, state);
	fs.appendFileSync(repo.generationMissionMd(created), "\n篡改\n");

	const loaded = repo.load(missionId);
	assert.equal(loaded.ok, false);
	if (!loaded.ok) {
		assert.equal(loaded.code, "corrupt");
		assert.match(loaded.error, /hash 不匹配/);
	}
});

// MissionState 的每一个字段都要被 isState 查到。逐个删过去而不是抽查一条:
// 漏查的字段会让坏快照直接进 core,然后在某个纯函数里以 "undefined is not
// iterable" 的形态炸掉 —— 离出错的地方隔着十几帧。给 state 加字段而忘了加校验,
// 这条会当场变红。
test("v2 repository:state 少任何一个必填字段都要判 corrupt", () => {
	const { tmp, repo, missionId, plan, state } = fixture();
	repo.create(plan, state);
	const file = path.join(tmp, "missions", "state", missionId, "SNAPSHOT.json");
	const pristine = JSON.parse(fs.readFileSync(file, "utf8"));

	for (const key of Object.keys(pristine.state)) {
		const snapshot = JSON.parse(JSON.stringify(pristine));
		delete snapshot.state[key];
		fs.writeFileSync(file, JSON.stringify(snapshot));

		const loaded = repo.load(missionId);
		assert.equal(loaded.ok, false, `删掉 state.${key} 之后仍然载入成功 —— isState 没查这个字段`);
		if (!loaded.ok) {
			assert.equal(loaded.code, "corrupt", `state.${key}`);
			assert.match(loaded.error, /格式无效|不一致/, `state.${key}`);
		}
	}
});

test("v2 repository:snapshot plan 必须与 generation hash 一致", () => {
	const { tmp, repo, missionId, plan, state } = fixture();
	repo.create(plan, state);
	const file = path.join(tmp, "missions", "state", missionId, "SNAPSHOT.json");
	const snapshot = JSON.parse(fs.readFileSync(file, "utf8"));
	snapshot.plan.goal = "未发布的新目标";
	fs.writeFileSync(file, JSON.stringify(snapshot));

	const loaded = repo.load(missionId);
	assert.equal(loaded.ok, false);
	if (!loaded.ok) assert.match(loaded.error, /plan 与 generation hash 不匹配/);
});

test("v2 repository:非法 missionId 不能逃逸 missions 目录", () => {
	const { repo, plan, state } = fixture();
	const loaded = repo.load("../../outside");
	assert.equal(loaded.ok, false);
	if (!loaded.ok) assert.match(loaded.error, /非法 mission id/);
	assert.throws(
		() => repo.create({ ...plan, missionId: "../../outside" }, { ...state, missionId: "../../outside" }),
		/非法 mission id/,
	);
});

test("v2 repository:stage 未发布时旧 snapshot 仍可加载", () => {
	const { repo, missionId, plan, state } = fixture();
	repo.create(plan, state);
	const staged = repo.stagePlan(missionId, 1, { ...plan, goal: "新计划", verifyScript: "exit 1\n" });

	const before = repo.load(missionId);
	assert.ok(before.ok, before.error);
	assert.equal(before.snapshot.revision, 1);
	assert.equal(before.snapshot.plan.goal, plan.goal);

	repo.discardStaged(staged);
	assert.ok(repo.load(missionId).ok);
});

test("v2 repository:CURRENT revision 落后时仍以 snapshot 为准恢复", () => {
	const { tmp, repo, missionId, plan, state } = fixture();
	repo.create(plan, state);
	const committed = repo.commit(missionId, 1, {
		plan,
		state: { ...state, updatedAt: 2 },
		handoff: null,
	});
	assert.ok(committed.ok, committed.error);
	fs.writeFileSync(
		currentPointer(layout(tmp, "missions")),
		JSON.stringify({ schemaVersion: 2, missionId, revision: 1 }) + "\n",
	);

	const current = repo.readCurrent();
	assert.ok(current.ok, current.error);
	assert.equal(current.snapshot.revision, 2);
});

test("v2 repository:发布后、snapshot 前崩溃留下的孤儿 generation 可安全重试", () => {
	const { repo, missionId, plan, state } = fixture();
	repo.create(plan, state);
	const orphan = repo.stagePlan(missionId, 1, { ...plan, goal: "第一次候选" });
	fs.renameSync(orphan.tempDir, orphan.finalDir);

	const retry = repo.stagePlan(missionId, 1, { ...plan, goal: "重试候选" });
	assert.ok(fs.existsSync(retry.missionMd));
	const committed = repo.commitStaged(retry, {
		plan: { ...plan, goal: "重试候选" },
		state,
		handoff: null,
	});
	assert.ok(committed.ok, committed.error);
	assert.equal(committed.snapshot.plan.goal, "重试候选");
});

test("v2 repository:commitStaged 拒绝与候选 generation 不一致的 plan", () => {
	const { repo, missionId, plan, state } = fixture();
	repo.create(plan, state);
	const staged = repo.stagePlan(missionId, 1, { ...plan, goal: "候选 A" });
	const committed = repo.commitStaged(staged, {
		plan: { ...plan, goal: "候选 B" },
		state,
		handoff: null,
	});
	assert.equal(committed.ok, false);
	if (!committed.ok) assert.match(committed.error, /staged generation 与提交 plan 不一致/);
	const loaded = repo.load(missionId);
	assert.ok(loaded.ok, loaded.error);
	assert.equal(loaded.snapshot.revision, 1);
});

test("v2 repository:普通 commit 不重写 CURRENT，activate 才更新定位提示", () => {
	const { tmp, repo, missionId, plan, state } = fixture();
	repo.create(plan, state);
	const pointer = currentPointer(layout(tmp, "missions"));
	const before = fs.readFileSync(pointer, "utf8");
	const committed = repo.commit(missionId, 1, { plan, state: { ...state, updatedAt: 2 }, handoff: null });
	assert.ok(committed.ok, committed.error);
	assert.equal(fs.readFileSync(pointer, "utf8"), before);

	const activated = repo.activate(missionId);
	assert.ok(activated.ok, activated.error);
	assert.equal(JSON.parse(fs.readFileSync(pointer, "utf8")).revision, 2);
});

test("v2 repository:create 保留传入的 handoff —— 硬写 null 会把换脑的钥匙锁在内存里", () => {
	const { repo, missionId, plan, state, tmp } = fixture();
	const record = {
		token: "tok-1",
		parentSession: "/sessions/a.jsonl",
		requestedRevision: 2,
		reason: "promote quick→standard on T1",
	};
	repo.create(plan, { ...state, pendingHandoff: record.reason }, record);
	const onDisk = JSON.parse(
		fs.readFileSync(path.join(tmp, "missions", "state", missionId, "SNAPSHOT.json"), "utf8"),
	);
	assert.equal(onDisk.state.pendingHandoff, record.reason);
	assert.deepEqual(onDisk.handoff, record, "pendingHandoff 与 handoff record 必须同生共死");
	const loaded = repo.load(missionId);
	assert.ok(loaded.ok);
	if (loaded.ok) assert.equal(loaded.snapshot.handoff?.token, "tok-1");
});

test("v2 repository:list 跳过没有 SNAPSHOT.json 的目录,而不是报成损坏项", () => {
	const { repo, missionId, plan, state, tmp } = fixture();
	repo.create(plan, state);
	// quick 档(inMemory)曾经在这里留下过只有 LOG.md 的孤儿目录
	const orphan = path.join(tmp, "missions", "state", "quick-mtkybh0p");
	fs.mkdirSync(orphan, { recursive: true });
	fs.writeFileSync(path.join(orphan, "LOG.md"), "WARN 独立核验降级为 hard-only\n");

	const all = repo.list();
	assert.equal(all.length, 1, "孤儿目录不该出现在列表里");
	assert.ok(all[0].ok && all[0].snapshot.missionId === missionId);

	// 真正损坏的(有 SNAPSHOT.json 但内容不合法)仍要报出来
	fs.writeFileSync(path.join(orphan, "SNAPSHOT.json"), "{ not json");
	const withCorrupt = repo.list();
	assert.equal(withCorrupt.length, 2);
	assert.ok(withCorrupt.some((r) => !r.ok));
});

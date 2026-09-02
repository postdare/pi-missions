import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadCheckState, removeCheckState, saveCheckState, type CheckState } from "../src/store/check.ts";

test("CHECK.json:保存、读取与清理运行态", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "check-state-"));
	const file = path.join(dir, "state", "m1", "CHECK.json");
	const state: CheckState = {
		taskId: "T1",
		attempt: 2,
		startedAt: 1000,
		updatedAt: 2000,
		stage: "running_scripts",
		currentBranch: "integration",
		completedBranches: [{ acId: "lint", status: "pass", exitCode: 0, durationMs: 80 }],
		verifier: { status: "pending" },
	};

	saveCheckState(file, state);
	assert.deepEqual(loadCheckState(file), state);
	removeCheckState(file);
	assert.equal(loadCheckState(file), null);
});

test("CHECK.json:文件缺失或损坏时安全返回 null", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "check-state-"));
	const file = path.join(dir, "CHECK.json");
	assert.equal(loadCheckState(file), null);
	fs.writeFileSync(file, "{broken");
	assert.equal(loadCheckState(file), null);
	fs.writeFileSync(file, JSON.stringify({ taskId: "T1", stage: "running_scripts" }));
	assert.equal(loadCheckState(file), null);
});

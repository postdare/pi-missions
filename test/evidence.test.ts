import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { saveEvidence, readTaskEvidenceHistory, latestEvidenceResults } from "../src/store/evidence.ts";
import type { Evidence } from "../src/core/types.ts";

test("readTaskEvidenceHistory: 正常读取多 attempt 并按 attempt 升序排序", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ev-test-"));
	try {
		const ev1: Evidence[] = [
			{ level: "hard", acId: "build", result: "fail", raw: "error: syntax error line 10\nsecond line\nthird line", exitCode: 1 },
		];
		const ev2: Evidence[] = [
			{ level: "hard", acId: "build", result: "pass", raw: "build successful", exitCode: 0 },
			{ level: "semi", acId: "ac1", result: "pass", raw: "all AC verified" },
		];

		// 先写 attempt 2, 再写 attempt 1
		saveEvidence(dir, "T1", 2, ev2);
		saveEvidence(dir, "T1", 1, ev1);

		const history = readTaskEvidenceHistory(dir, "T1");
		assert.equal(history.length, 2);
		assert.equal(history[0].attempt, 1);
		assert.equal(history[0].taskId, "T1");
		assert.equal(history[0].evidences[0].raw, "error: syntax error line 10\nsecond line\nthird line");
		assert.equal(history[1].attempt, 2);
		assert.equal(history[1].evidences.length, 2);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("readTaskEvidenceHistory: 正确过滤不同 taskId 的证据", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ev-test-"));
	try {
		saveEvidence(dir, "T1", 1, [{ level: "hard", acId: "b1", result: "pass", raw: "ok" }]);
		saveEvidence(dir, "T2", 1, [{ level: "hard", acId: "b2", result: "fail", raw: "bad" }]);

		const t1Hist = readTaskEvidenceHistory(dir, "T1");
		assert.equal(t1Hist.length, 1);
		assert.equal(t1Hist[0].taskId, "T1");

		const t2Hist = readTaskEvidenceHistory(dir, "T2");
		assert.equal(t2Hist.length, 1);
		assert.equal(t2Hist[0].taskId, "T2");

		const t3Hist = readTaskEvidenceHistory(dir, "T3");
		assert.equal(t3Hist.length, 0);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("readTaskEvidenceHistory: 容错跳过损坏 JSON 文件与非法文件", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ev-test-"));
	try {
		saveEvidence(dir, "T1", 1, [{ level: "hard", acId: "b1", result: "pass", raw: "ok" }]);
		// 写入坏 json
		fs.writeFileSync(path.join(dir, "T1-attempt2.json"), "{ broken json");
		fs.writeFileSync(path.join(dir, "not-json.txt"), "hello");

		const hist = readTaskEvidenceHistory(dir, "T1");
		assert.equal(hist.length, 1);
		assert.equal(hist[0].attempt, 1);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("readTaskEvidenceHistory: 不存在的目录或空 taskId 返回空数组", () => {
	assert.deepEqual(readTaskEvidenceHistory("/non/existent/path/for/evidence", "T1"), []);
	assert.deepEqual(readTaskEvidenceHistory("", "T1"), []);
	assert.deepEqual(readTaskEvidenceHistory("/tmp", ""), []);
});

test("证据归档完整保留命令、时间、耗时与 stdout/stderr", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ev-test-"));
	const evidence: Evidence = {
		level: "hard",
		acId: "integration",
		result: "fail",
		raw: "尾部摘要",
		exitCode: 2,
		command: "npm test -- integration",
		startedAt: 1_756_737_000_000,
		durationMs: 1234,
		stdout: "完整标准输出\n第二行",
		stderr: "完整错误输出",
	};
	saveEvidence(dir, "T1", 3, [evidence]);
	const loaded = readTaskEvidenceHistory(dir, "T1")[0].evidences[0];
	assert.equal(loaded.command, evidence.command);
	assert.equal(loaded.startedAt, evidence.startedAt);
	assert.equal(loaded.durationMs, evidence.durationMs);
	assert.equal(loaded.stdout, evidence.stdout);
	assert.equal(loaded.stderr, evidence.stderr);
});

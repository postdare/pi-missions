import { test } from "node:test";
import assert from "node:assert/strict";
import { parseNameStatus } from "../src/store/git.ts";

test("parseNameStatus:常规状态码译成中文", () => {
	const got = parseNameStatus(
		["A\tinternal/schema/envelope.go", "M\tinternal/storage/storage.go", "D\told/dead.go"].join("\n"),
	);
	assert.deepEqual(got, [
		"新增 internal/schema/envelope.go",
		"修改 internal/storage/storage.go",
		"删除 old/dead.go",
	]);
});

// R/C 是三列,和其余两列的格式不同 —— 这一条就是这个函数不能用一句 split 糊过去的理由。
test("parseNameStatus:重命名与复制是三列,两个路径都要留", () => {
	const got = parseNameStatus(["R100\ta/old.go\ta/new.go", "C75\tsrc/x.go\tsrc/y.go"].join("\n"));
	assert.deepEqual(got, ["重命名 a/old.go → a/new.go", "复制 src/x.go → src/y.go"]);
});

test("parseNameStatus:认不出的状态码原样带出,不吞文件", () => {
	const got = parseNameStatus("U\tinternal/conflict.go");
	assert.equal(got.length, 1, "清单少一个文件就等于它没有存在的理由");
	assert.match(got[0], /internal\/conflict\.go/);
});

test("parseNameStatus:空行与残缺行跳过,不产出空条目", () => {
	assert.deepEqual(parseNameStatus(""), []);
	assert.deepEqual(parseNameStatus("\n\n"), []);
	assert.deepEqual(parseNameStatus("M"), [], "只有状态码没有路径的行是残缺的");
});

test("parseNameStatus:路径里的空格不被切开", () => {
	assert.deepEqual(parseNameStatus("M\tdocs/some file.md"), ["修改 docs/some file.md"]);
});

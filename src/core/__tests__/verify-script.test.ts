import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { formatVerifyScriptIssues, inspectVerifyScript } from "../verify-script.ts";

// ─────────────────────────── 真实事故素材 ───────────────────────────
//
// 三次事故的脚本都不在磁盘上了(两个 mission 目录在考场复位时清掉了,
// 第三次的计划从没冻结过、verify.sh 是 0 字节占位)。下面两份是从当时的
// SNAPSHOT.json / 升级诊断里逐字抄下来的**原文**,不是简化重写 ——
// 简化版会把当时没想到的形态漏掉,那就失去了拿真实素材做夹具的意义。

/**
 * 事故一 · 2026-09-03 tui-q-esc gen 17。
 * L2 升级诊断的原话:「冻结的 verify.sh 第 5 行 `cd "$(dirname "$0")"` 将工作目录
 * 切到 missions/state/.../generations/17/(无 go.mod),导致所有 go test 分支必然 exit 1」。
 * 五个 AC 同时红,代价是一次换脑重冻。
 */
const ACCIDENT_1 = `#!/usr/bin/env bash
set -uo pipefail
BRANCH="\${1:-}"

cd "$(dirname "$0")"

case "$BRANCH" in
  ac1-q-shows-confirm)
    go test ./internal/tui -run TestQuitConfirm -count=1 || exit 1
    ;;
  ac6-all-tests-pass)
    go test ./... -count=1 || exit 1
    ;;
  *)
    echo "usage: verify.sh <branch>" >&2; exit 2 ;;
esac
`;

/**
 * 事故二 · 2026-09-04 restful-api-web gen 19。
 * 脚本开头已经正确 `cd "$REPO"` 了,却在 start_server 的子 shell 里前功尽弃:
 * `( cd "$TMP" && go build -o "$TMP/todo-server" ./cmd/todo-server )` ——
 * 失败签名是 `go: go.mod file not found`,同样换来一次换脑重冻。
 */
const ACCIDENT_2 = `#!/usr/bin/env bash
# 每个 AC 对应一个分支;所有分支幂等、可重复执行、退出码确定。
set -uo pipefail
REPO="$(git rev-parse --show-toplevel)"
cd "$REPO"
BRANCH="\${1:-}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

start_server() { # $1=port $2=xdg_dir
  ( cd "$TMP" && go build -o "$TMP/todo-server" ./cmd/todo-server ) || fail "$BRANCH" "build cmd/todo-server"
  XDG_CONFIG_HOME="$2" "$TMP/todo-server" -addr "127.0.0.1:$1" >/dev/null 2>&1 &
  SRV_PID=$!
}

case "$BRANCH" in
  server_entry)
    start_server 18741 "$TMP/xdg"
    ;;
esac
`;

/**
 * 事故二修对之后 · gen 85。构建回到仓库根跑,TMP 只接产物。
 * 注释是当时模型自己写的。
 */
const FIXED_2 = `#!/usr/bin/env bash
set -uo pipefail
REPO="$(git rev-parse --show-toplevel)"
cd "$REPO"
TMP="$(mktemp -d)"

start_server() {
  # go build 必须在模块根(含 go.mod)执行;产物放到 TMP,避免污染工作区。
  go build -o "$TMP/todo-server" ./cmd/todo-server || fail "$BRANCH" "build cmd/todo-server"
  XDG_CONFIG_HOME="$2" "$TMP/todo-server" -addr "127.0.0.1:$1" >/dev/null 2>&1 &
}
`;

/** 考场里现存的、完全正确的一版(gen 31)。它连 cd 都不写。 */
const REAL_GOOD_PATH =
	"/Users/kim/Projects/todo-list/missions/state/2026-09-04-rest-api-get-api-v1-todos-status-limit-o/generations/31/verify.sh";

// ─────────────────────────── 三次事故都要被拦下 ───────────────────────────

test("事故一:cd \"$(dirname \"$0\")\" 被拦下,并指出是第几行", () => {
	const issues = inspectVerifyScript(ACCIDENT_1);
	assert.equal(issues.length, 1, `应当只报这一处,实际:${JSON.stringify(issues, null, 2)}`);
	assert.equal(issues[0].line, 5, "行号要对得上,人得能直接跳过去");
	assert.match(issues[0].reason, /冻结件|generations/, "要说清 $0 指向哪里");
	assert.match(issues[0].fix, /删掉/, "正确答案是什么都不写");
});

test("事故二:子 shell 里 cd \"$TMP\" 再 go build 被拦下 —— 开头 cd \"$REPO\" 救不了它", () => {
	const issues = inspectVerifyScript(ACCIDENT_2);
	assert.equal(issues.length, 1, `应当只报子 shell 那一处,实际:${JSON.stringify(issues, null, 2)}`);
	assert.match(issues[0].text, /cd "\$TMP" && go build/);
	assert.match(issues[0].reason, /临时目录/);
	assert.match(issues[0].fix, /-o/, "该教它用 -o 把产物写进 TMP");
});

test("事故二修对之后不再被拦 —— 同一个 TMP,只是不拿它当工作目录", () => {
	assert.deepEqual(inspectVerifyScript(FIXED_2), []);
});

test("考场里现存的正确脚本(gen 31)一处都不该报", () => {
	if (!fs.existsSync(REAL_GOOD_PATH)) return; // 考场被复位过就跳过,不让它变成脆弱依赖
	const issues = inspectVerifyScript(fs.readFileSync(REAL_GOOD_PATH, "utf8"));
	assert.deepEqual(issues, [], `正确的真实脚本被误判:${JSON.stringify(issues, null, 2)}`);
});

// ─────────────────────────── R1 的边界 ───────────────────────────

test("R1:$0 推导目录的各种写法都认得出", () => {
	for (const line of [
		'cd "$(dirname "$0")"',
		"cd $(dirname $0)",
		'cd "$(cd "$(dirname "$0")" && pwd)"',
		'cd "$(dirname "${BASH_SOURCE[0]}")"',
	]) {
		const issues = inspectVerifyScript(`#!/usr/bin/env bash\n${line}\ngo test ./...\n`);
		assert.equal(issues.length, 1, `没认出:${line}`);
	}
});

test("R1:先赋值再 cd 也算 —— SCRIPT_DIR 这个惯用法太常见了", () => {
	const issues = inspectVerifyScript(`#!/usr/bin/env bash
SCRIPT_DIR="$(dirname "$0")"
cd "$SCRIPT_DIR"
go test ./...
`);
	assert.equal(issues.length, 1);
	assert.equal(issues[0].line, 3, "报的是 cd 那一行,不是赋值那一行");
});

// 反例:提到 $0 不等于 cd 到 $0
test("R1 反例:拿 $0 只是为了读同目录的文件或打日志,不该拦", () => {
	assert.deepEqual(
		inspectVerifyScript(`#!/usr/bin/env bash
SCRIPT_DIR="$(dirname "$0")"
echo "判据文件在 $SCRIPT_DIR/expected.txt"
diff "$SCRIPT_DIR/expected.txt" build/actual.txt
go test ./...
`),
		[],
		"没有 cd 就不该报 —— 读同目录的冻结件是完全正当的用法",
	);
});

test("R1 反例:cd 到 git 仓库根是正确写法,不能拦", () => {
	assert.deepEqual(
		inspectVerifyScript(`#!/usr/bin/env bash
REPO="$(git rev-parse --show-toplevel)"
cd "$REPO"
go test ./...
`),
		[],
	);
});

// ─────────────────────────── R2 的边界 ───────────────────────────

test("R2:内联 cd \"$(mktemp -d)\" 也认得出", () => {
	const issues = inspectVerifyScript(`#!/usr/bin/env bash
( cd "$(mktemp -d)" && go test ./... )
`);
	assert.equal(issues.length, 1);
});

test("R2:顶层切进临时目录且没切回来,整份脚本的相对路径都废了", () => {
	const issues = inspectVerifyScript(`#!/usr/bin/env bash
TMP="$(mktemp -d)"
cd "$TMP"
echo hi
`);
	assert.equal(issues.length, 1, "即使这一行本身没跑构建,后面所有相对路径也都落空了");
	assert.match(issues[0].reason, /没有再切回来/);
});

test("R2 反例:切进临时目录又切回来,不该拦", () => {
	assert.deepEqual(
		inspectVerifyScript(`#!/usr/bin/env bash
REPO="$(git rev-parse --show-toplevel)"
TMP="$(mktemp -d)"
cd "$TMP"
tar xzf "$REPO/testdata/fixture.tgz"
cd "$REPO"
go test ./...
`),
		[],
	);
});

test("R2 反例:在临时目录里解包 / 跑已经建好的二进制,是正当用法", () => {
	assert.deepEqual(
		inspectVerifyScript(`#!/usr/bin/env bash
TMP="$(mktemp -d)"
go build -o "$TMP/server" ./cmd/server
( cd "$TMP" && tar xzf bundle.tgz )
( cd "$TMP" && ./server -check )
`),
		[],
		"解包和跑产物都不消费项目源码,不该拦",
	);
});

test("R2 反例:cargo init / npm init 在空临时目录里跑本来就对", () => {
	assert.deepEqual(
		inspectVerifyScript(`#!/usr/bin/env bash
TMP="$(mktemp -d)"
( cd "$TMP" && cargo init --name probe )
( cd "$TMP" && npm init -y )
cd "$(git rev-parse --show-toplevel)"
`),
		[],
		"init 类子命令是去建新工程,不是消费现有源码",
	);
});

test("R2 反例:构建工具自己带了 -C/--manifest-path,cwd 就不重要了", () => {
	assert.deepEqual(
		inspectVerifyScript(`#!/usr/bin/env bash
REPO="$(git rev-parse --show-toplevel)"
TMP="$(mktemp -d)"
( cd "$TMP" && make -C "$REPO" build )
cd "$REPO"
`),
		[],
	);
});

// ─────────────────────────── 整体 ───────────────────────────

test("干净的脚本(压根不写 cd)一处都不报", () => {
	assert.deepEqual(
		inspectVerifyScript(`#!/usr/bin/env bash
# 工作目录必须是仓库根(系统已保证),脚本不做 cd。
set -u
case "\${1:-}" in
  ac1) go test ./internal/api -run TestX ;;
  ac2) go vet ./... ;;
esac
`),
		[],
	);
});

test("注释里的 cd 不算 —— 讲解怎么写错的注释很常见", () => {
	assert.deepEqual(
		inspectVerifyScript(`#!/usr/bin/env bash
# 别写 cd "$(dirname "$0")",那会切到冻结件目录
go test ./...
`),
		[],
	);
});

test("空脚本与空白脚本不报错也不崩", () => {
	assert.deepEqual(inspectVerifyScript(""), []);
	assert.deepEqual(inspectVerifyScript("\n\n   \n"), []);
});

test("打回信息三件事齐全:哪一行、为什么、该写成什么", () => {
	const [msg] = formatVerifyScriptIssues(inspectVerifyScript(ACCIDENT_1));
	assert.match(msg, /第 5 行/);
	assert.match(msg, /dirname/);
	assert.match(msg, /→ /, "修法要单独起一行,别混在原因里");
	assert.match(msg, /不是换一种 cd/, "反直觉的那半句必须在");
});

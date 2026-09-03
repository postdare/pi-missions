#!/usr/bin/env bash
# 技术报告验收:docs/TECH-REPORT.md
REPORT="docs/TECH-REPORT.md"
fail() { echo "FAIL: $1"; exit 1; }
[ -f "$REPORT" ] || fail "报告文件不存在: $REPORT"

case "$1" in
  ac1)
    grep -q "pi-missions" "$REPORT" || fail "未提及 pi-missions"
    grep -q "双层" "$REPORT" || fail "未描述双层循环"
    for kw in "DEFINE" "PLAN" "ACT" "唯一裁判"; do
      grep -q "$kw" "$REPORT" || fail "缺少关键词: $kw"
    done
    ;;
  ac2)
    for m in "src/index.ts" "runtime" "core" "store" "hooks" "ui" "templates" "skills" "phase-prompts" "roles"; do
      grep -q "$m" "$REPORT" || fail "模块地图缺少: $m"
    done
    ;;
  ac3)
    grep -q "npm test" "$REPORT" || fail "缺 npm test"
    grep -q "node --test" "$REPORT" || fail "缺 node --test"
    grep -q "tsc --noEmit" "$REPORT" || fail "缺 tsc --noEmit"
    grep -q -- "-e" "$REPORT" || fail "缺 pi -e 装载方法"
    ;;
  ac4)
    for kw in "纯净" "applyEvent" "不可信" "STATE" "冻结" "mission_submit"; do
      grep -q "$kw" "$REPORT" || fail "硬约束缺少: $kw"
    done
    ;;
  ac5)
    for p in "src/index.ts" "src/runtime.ts" "src/core" "src/store" "src/hooks" "src/ui" "templates" "skills" "docs/ARCHITECTURE.md"; do
      [ -e "$p" ] || fail "报告中引用的路径不存在: $p"
    done
    grep -q "ARCHITECTURE" "$REPORT" || fail "报告未引用 ARCHITECTURE.md 作为依据"
    ;;
  *)
    fail "未知分支: $1"
    ;;
esac
echo "PASS: $1"
exit 0
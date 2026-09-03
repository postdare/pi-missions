#!/usr/bin/env bash
# 技术报告验收:docs/TECH-REPORT.md
REPORT="docs/TECH-REPORT.md"
fail() { echo "FAIL: $1"; exit 1; }
[ -f "$REPORT" ] || fail "报告文件不存在: $REPORT"

case "$1" in
  ac1)
    grep -q "项目定位" "$REPORT" || fail "缺「项目定位」章节"
    grep -q "工作流机制" "$REPORT" || fail "缺「工作流机制」章节"
    grep -q "扩展包" "$REPORT" || fail "未说明 pi-missions 是跑在 pi 上的扩展包"
    grep -q "双层" "$REPORT" || fail "未描述双层循环"
    for kw in "PDCA" "唯一裁判"; do
      grep -q "$kw" "$REPORT" || fail "缺少关键词: $kw"
    done
    ;;
  ac2)
    grep -q "模块地图" "$REPORT" || fail "缺「模块地图」章节"
    for m in "src/index.ts" "runtime" "phase-prompts" "core" "store" "roles" "hooks" "ui" "templates" "skills"; do
      grep -q "$m" "$REPORT" || fail "模块地图缺少: $m"
    done
    ;;
  ac3)
    grep -q "开发与验证" "$REPORT" || fail "缺「开发与验证」章节"
    grep -q "npm test" "$REPORT" || fail "缺 npm test"
    grep -q "node --test" "$REPORT" || fail "缺 node --test"
    grep -q "test-name-pattern" "$REPORT" || fail "缺 test-name-pattern 单用例"
    grep -q "tsc --noEmit" "$REPORT" || fail "缺 tsc --noEmit"
    grep -q -- "-e" "$REPORT" || fail "缺 pi -e 装载方法"
    ;;
  ac4)
    grep -q "硬约束" "$REPORT" || fail "缺「硬约束」章节"
    for kw in "纯净" "applyEvent" "不可信" "STATE" "冻结" "mission_submit"; do
      grep -q "$kw" "$REPORT" || fail "硬约束缺少: $kw"
    done
    ;;
  ac5)
    # 报告引用的路径必须真实存在(逐个核对,防编造)
    for p in "src/index.ts" "src/runtime.ts" "src/phase-prompts.ts" "src/core" "src/store" "src/roles" "src/hooks" "src/ui" "templates" "skills" "README.md" "CLAUDE.md" "docs/ARCHITECTURE.md" "src/core/machine.ts" "src/core/types.ts" "src/ui/chrome.ts" "src/ui/panel.ts"; do
      grep -q "$p" "$REPORT" || true
      [ -e "$p" ] || fail "报告中引用的路径不存在: $p"
    done
    # 事实性抽查:与来源文档的关键陈述一致
    grep -q "ARCHITECTURE" "$REPORT" || fail "报告未引用 ARCHITECTURE.md 作为依据"
    grep -q "哑管道" "$REPORT" || fail "对 runtime 的描述与 ARCHITECTURE.md 不一致(应为哑管道)"
    grep -q "quick" "$REPORT" || fail "未提及三档(quick/standard/complex)"
    grep -q "standard" "$REPORT" || fail "未提及三档(quick/standard/complex)"
    grep -q "complex" "$REPORT" || fail "未提及三档(quick/standard/complex)"
    ;;
  *)
    fail "未知分支: $1"
    ;;
esac
echo "PASS: $1"
exit 0
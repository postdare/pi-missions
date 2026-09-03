# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> 本仓库的 README、注释、commit 全部是中文,保持一致。

## 这是什么

跑在 [pi](https://github.com/earendil-works/pi-coding-agent) 上的**扩展包**(不是应用、不是库):
双层循环工作流引擎,外层 PDCA 管任务分解,内层操控循环管执行质量。
入口 `src/index.ts`(由 `package.json` 的 `pi.extensions` 声明),没有构建步骤 —— pi 直接跑 `.ts`。

核心断言:**L0(`src/core/` 里的纯 TypeScript)是唯一的裁判,LLM 只是执行者。**
改任何东西前先想清楚这条会不会被破坏。

## 命令

```bash
npm test                                           # 全部:core 单测 + runtime/UI 冒烟(328 个)
node --test src/core/__tests__/breaker.test.ts     # 单个文件
node --test --test-name-pattern="熔断" src/core/__tests__/breaker.test.ts   # 单个用例(名字是中文)
npx tsc --noEmit                                   # 类型检查(tsconfig 只 include src/)
```

无构建、无 lint 配置。Node ≥ 22.6(`node --test` 直接跑 `.ts` 靠 type stripping)。

## 调试

**UI/渲染优先离线调,不起 pi** —— UI 全是纯函数,渲染问题不需要真机:

```bash
# plan-review 离线预览:COLUMNS 模拟窄终端,第二个参数是段,第三是滚动
COLUMNS=56 node --experimental-strip-types scripts/preview-plan-review.ts all

# 样式快照:观感变了(标签/间距/缩进)就红;确认是想要的改动后重新冻结
UPDATE_SNAPSHOTS=1 node --test test/plan-review.snapshot.test.ts
```

渲染的分层防线与分工:
- `test/render.test.ts` → 宽度不变式(盒不裂、行不越界)
- `test/plan-review.snapshot.test.ts` → 版面观感(快照,剥离 ANSI 的纯文本)
- `test/theme-colors.test.ts` → 主题色名合法性(写错会炸整个 pi 进程)

新渲染路径三项都要过,快照口径变更要同步重生成。

**真机调试**(交互输入、按键处理这类离线测不了的):

```bash
pi -e .                                        # 在目标仓库里临时装载本扩展
/debug                                         # pi 内置:写 ~/.pi/agent/pi-debug.log(含渲染后的 TUI 行)
PI_TUI_WRITE_LOG=/tmp/tui.log pi -e .          # 捕获写往 stdout 的原始 ANSI 流
```

手工跑扩展:在**目标仓库**里 `pi -e /absolute/path/to/pi-missions`(临时装载,不落设置),
然后 `/missions` / `/mission new "…"`。别在本仓库里跑 mission —— 它会往这里铺 `missions/` 脚手架。

## 分层与硬约束

完整架构、术语表、时序、不变量落点见 **[docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)**(定位到`文件 + 符号名`,不写行号 —— 行号每次编辑都会漂;与代码不符以代码为准);
使用侧行为见 README.md。下面只列改代码时必须守住的东西。

```
src/index.ts    装配:挂 pi 事件、注册工具与命令、entry renderer
src/runtime.ts  哑管道:采证据 → judge() → 喂事件给 machine → 翻译 Effect[] 成 pi 调用
src/phase-prompts.ts  相位提示词的选取(按判定装置分流:standard 读盘,quick 走内联)
src/core/       纯函数,唯一裁判(machine/breaker/verdict/baseline/tier/define/spike/coverage/review)
src/store/      v2 Repository、generation 投影、log/evidence/git/scaffold
src/roles/      models.json 角色模型 + 进程内 Verifier AgentSession
src/hooks/      tool_call 闸门 + 编辑级增量反馈
src/ui/         chrome(圆角盒框架)/ panel(/missions)/ plan-review(冻结前评审)/ ask-review(DEFINE 问答)/ status-view / dashboard / models-page
templates/      scaffold 铺进目标仓库的工作流文件(standard/complex 的相位提示词、脚本)
skills/         随包分发的 pi skill(入场导览:该不该开 mission、选哪档)
```

1. **`src/core/` 必须保持纯净** —— 不 import pi、不读文件、不调网络、除事件携带的 `at`
   之外不依赖环境(`src/core/types.ts` 顶部写明)。所有"对不对 / 升不升 / 停不停"的
   判定都在这里,并且必须有单测。`runtime.ts` 里出现任何 if 判定逻辑都是味道。
2. **状态推进只走 `Runtime.applyEvent()`** —— 它是唯一的漏斗:`transition()` → 落盘 →
   翻译 effects → 刷 widget。非法迁移不抛异常,返回 `error` 字段、状态不变。
   不要在别处直接改 `state.*`。新增行为的正确形状是:加一个 `MissionEvent` +
   在 `machine.ts` 里处理 + 返回 `Effect`,由 `translateEffects()` 执行。
3. **内存态不可信** —— pi 在 newSession/reload/重启时重建扩展实例。所有关键路径都从
   `missions/state/CURRENT` 指针 + `SNAPSHOT.json` 重附着(`ensureAttached()`)。
   换脑用 snapshot 中的 token/revision + 新会话 marker 握手,不走内存。
4. **闸门只依赖 STATE**(`src/hooks/gate.ts`),不依赖"上一个工具的结果" ——
   并行工具执行时序不保证。相位能力矩阵在 `toolsForPhase()`。
5. **AC 冻结后只读** —— 三道锁:工具集切换、`gate.ts` 拦 `missions/state/`
   (snapshot 与所有 generation)的 edit/write、bash 写操作粗检。别加绕过其中任何一道的"方便入口"。
6. **`mission_submit` 不接受任何参数** —— 判定依据必须先于执行冻结(I2/I3)。
   任何让执行者事后补判定标准的改动都是在拆这套设计。

## UI 层的三个坑(都有真实事故)

- **主题色名写错会炸整个 pi 进程**,不是掉色 —— `theme.fg()` 遇到未知颜色名直接抛,
  而渲染在 TUI 主循环里。合法名单和严格主题在 `test/theme-colors.test.ts`,
  新增渲染路径要加进那个测试。宽松 mock 主题测不出这类错误。
- **行宽越界同样会炸 TUI** —— 用 `chrome.ts` 的 `clip()`(基于 `truncateToWidth`,
  ANSI 安全),不要手搓 `slice`;补空格用 `chrome.pad()`,宽度计算用 `visibleWidth`
  (CJK 宽 2,`.length`/`padEnd` 按码位算会差列)。
- **拼装时差一列不会报错,只会把盒子撕开** —— 盒顶右上角对不齐这个 bug 出现过三次。
  `test/render.test.ts` 是防线:它跑 `renderPanel`/`renderStatus` 的所有页面 × 宽度 ×
  选中态,断言每条盒行的可见宽度**恰好** = width。改 UI 后它必须还是绿的。

**UI 全部是纯函数**:`renderPanel()`(panel.ts)与 `renderStatus()`(status-view.ts)
接一个描述当前视图的对象、返回行数组;`ctx.ui.custom` 的壳只负责持有状态和转发按键。
更细的积木在 `chrome.ts`(盒/高亮行/页签/进度条/提示条),内容行在 `dashboard.ts`、
`models-page.ts`。新增 UI 按这个形状写 —— 能单测,也能离线预览。

**视觉约定写在 `src/ui/chrome.ts` 头部**(外框 vs 盒内分隔的色阶、选中态、
强调色只用 accent、只用窄宽字形),改样式前先读它。其中两条是真金白银换来的:
**贴着盒子左边框的位置不要放竖线**(`▎│┃`)—— 它会被读成"边框裂了一道";
**字形只用等宽字体里稳定的那几个** —— `◌ ◍ ◑ ░ ▒` 在不少字体里会渲染成又大又糊的
圆盘或实心灰板(相位图标和进度条各踩过一次)。行光标 `▸`,页签用背景色药丸,
选中态靠整行 `selectedBg`,进度条是实心块 + `─` 轨道。两条都有测试卡着
(`test/render.test.ts` 查贴边竖线,`test/dashboard.test.ts` 查相位图标)。

**长文本一律折行,不截断。** 目标、AC 正文、任务标题、失败原因用 `chrome.wrap()`
折行 + 悬挂缩进 —— 截断等于把最该看的信息丢掉。次要的账目行(阶梯/成本/指纹)才允许
截断,而且要把最重要的部分排在最左边(所以成本行是「合计 → 分账」而不是反过来)。内容行构造器接一个可选的
`LineTheme`:传了就上色(TUI),不传出纯文本(非 TUI 的 entry 卡片走这条)。

`ctx.ui.custom` 用的是非 overlay 的圆角盒内联页(替换编辑器区域),需要 `hasUI` 守卫。

## 测试的分工

- `src/core/__tests__/` —— 纯函数单测,无外部依赖,快。判定逻辑的改动必须在这里有覆盖。
- `test/runtime.smoke.test.ts` —— mock pi/ctx 驱动**真实 Runtime + 真实 core**,在临时
  仓库里走完整循环(new → plan → fail → act → submit → check → pass → done)。
  验证粘合层,不重复 core 的判定用例。
- `test/*.test.ts` 的 UI 测试需要 peer 依赖(`@earendil-works/pi-tui`)装好才能加载。

## 提交约定

Conventional Commits + 中文正文,scope 用模块名:`fix(ui):` `feat(spike):` `feat(define):`
`docs(readme):`。标题写清楚**症状或收益**,不是"修改了 xx 文件"
(例:`fix(ui): 模型页用了不存在的主题色 "fg",选中模型后整个 TUI 崩掉`)。

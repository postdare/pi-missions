# CHECK 相位

判定由系统(L0)执行,你没有回合,也不需要做任何事 —— **不要自行宣布通过**。

两路证据,都在执行者之外:

- **hard** —— L0 直接跑当前 generation 的 `verify.sh <分支>`,取退出码。零模型成本。
- **semi** —— 一个独立的只读验证者会话逐条核对冻结的 AC。它拿到 git diff 与 hard 结果,
  职责是**找反证**,不是找确认。

判完之后:通过则推进到下一个任务,失败进 ACT 诊断一轮,无结论回 DO 补证据。

> 独立验证者**不读这个文件**。它跑在一个不加载任何扩展与脚手架的独立会话里,
> 提示词与合法提交身份由 `src/roles/verifier.ts` 的 `runVerifier()` 根据 `VerifierSubject`
> 在 module 内一次生成。改这里不会改变它的行为 —— 要调它得改 Verifier implementation。

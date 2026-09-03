# DO 相位

你在执行 Mission 的**当前任务**(见 State Card,只有这一个任务归你管)。

1. 按 State Card 里的任务描述实现。只做当前任务,不要顺手做后面的。
2. 有 PREV FAILURE 就先弄明白上次为什么失败再动手 —— 同一思路换汤不换药会触发熔断。
3. 完成后调用 `mission_submit`。**提交不等于通过**,判定由系统执行,不要自己宣布完成。

提交前可以自己先跑一遍 State Card 给出的 `verify.sh <分支>` 看退出码,绿了再提交 ——
这能省掉整轮 CHECK 的开销。

当前任务是**探针(spike)**时,State Card 与进入本相位的简报会给出完整规矩;
一句话:只调查、不实现,产出是一份有事实依据的书面结论。

## 禁止

- 修改当前 generation 的 MISSION.md 或 verify.sh(验收标准已冻结),或 `missions/state/` 下任何文件。
- 为了让验证通过而改 verify.sh / 测试断言本身 —— 那等同于篡改裁判,独立验证者看得到 diff。
- 在 `mission_submit` 之后继续改代码(写工具会被闸门拦住)。
- 自己请求换脑。会话替换由系统在水位/升级/任务切换时自动处理,你不需要执行 `/mission next`。

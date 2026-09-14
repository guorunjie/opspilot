# 浏览器恢复逻辑抽取

`src/rpa/browserRecoveryLadder.js` 从现有 OpsPilot 的同名通用恢复模块抽取，保留固定控件 → Playwright 语义定位 → 经校验的候选定位这一顺序及原导出名称。未复制平台地址、生产 Selector、账号配置或商业 Connector。

本轮审查来源为商业仓本地基线 `e4c38f98a8d83b8a0e7f46833af0b34a8d043812` 的 `src/lib/browserRecoveryLadder.js`；商业仓未改动，尚未改为依赖 Core。

## 修正的可靠性边界

- 未提供或非法 mutationState 按 possibly_started 处理，不再默认 not_started；只有可信执行层明确证明未开始，才进入下一恢复阶段。
- 操作成功后审计失败直接停止，不把审计异常当作定位失败重试。异步审计也必须完成。
- 无显式候选验证器默认拒绝；验证器必须返回 true。验证参数与待执行候选隔离，防止验证时改写目标。
- 完成控制操作只返回 completed，不表示经营目标 VERIFIED；成功操作的 mutationState 也不声称未开始。
- operationType 必须明确；真实写入关闭。write 分支只允许显式 simulation、确认和范围标识，仍须置于可信 Capability 审批入口之后。
- 最终提交不允许 AI 重定位兜底。未知写入必须先独立回读，不能再次提交。

这是可信应用的恢复算法，不是插件沙箱。`simulation: true` 不能把真实网页变成模拟环境，调用方仍负责浏览器隔离、范围验证和执行权限。该模块不读取配置、不自行启动浏览器、不导入其他 Agent 工具，所有执行/定位钩子由应用传入。

## 验收和下一步

单元测试覆盖恢复顺序、缺失/非法写入状态、审计同步/异步失败、默认拒绝候选、候选隔离、最终提交边界及禁止真实写入。没有把函数桩测试说成浏览器验收。

后续仍需浏览器生命周期、Playwright/CDP 适配、离线页面与异步 Task 的实际执行/回读、证据捕获、Recorder/Replay，并将商业仓改为依赖公开实现。本次抽取不代表这些要求完成。

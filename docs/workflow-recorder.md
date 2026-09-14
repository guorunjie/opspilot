# 离线 Recorder / Replay

`startWorkflowRecorder({ runtime, workflowId, controls })` 在隔离的合成页面捕获显式允许的 CSS 控件操作，输出既有 Browser Workflow 定义。它不是生产平台录制器，也不自动识别页面控件。仅支持 text/number input 的 fill 与 click；密码及其他输入类型拒绝记录。允许的普通文本框仍可能包含敏感内容，调用方必须只提供合成数据，不能把类型检查视为全面脱敏。

每页只能有一个活动录制器。选择器必须唯一匹配；连续填写同一个控件合并为最终值，最多 100 个步骤。未列出的控件事件忽略。`stop()` 移除监听器并校验结果；空录制、敏感输入、歧义目标及超限均失败，不返回可回放记录。`cancel()` 丢弃内容。页面导航丢失记录时明确失败，不推断录制成功。

录制期间的实际点击仍会触发合成页面行为：录制不是预览，也不能用来绕过真实写入授权。该 API 只接受 offline Runtime，不能接入真实用户浏览器、账号或平台。

`workflowFromRecording(record)` 校验版本、时间、定义及摘要，只导入动作定义。记录不能携带 approval、执行结果或 VERIFIED。摘要用于一致性检查，不证明来源可信；页面中的录制状态也不是安全边界。导入后必须重新检查业务范围、目标值、当前前置条件，并把准确的工作流摘要绑定到本次 Task 授权。

回放使用 `runBrowserWorkflow`，由持久 Task、所有权锁和 Gateway 调用。录制器不会自动执行、重试、授权或验证。工作流完成只能转为 SUBMITTED，随后独立读取目标状态才能判断 VERIFIED；未知结果不能直接重放写入。

## 本机验收

`node scripts/verify-offline-browser.mjs --headed --recorded` 使用真实隔离 Chromium：录制合成价格填写和点击，导入定义，复位本次新建的合成页面，再通过新建 Task 的明确授权回放。核对未授权拒绝、仅一次提交、独立回读、6 条 SQLite 步骤事件及 CDP 证据；同时验证重复录制拒绝、连续输入合并、停止后不可复用、密码拒绝、取消及未允许事件忽略。

输出位于 `output/playwright/offline-browser/`。测试不修改已安装 Demo 的用户数据库。当前是开发接口验收，尚未提供普通用户录制入口、跨页面录制、生产 Connector 或安装包集成。

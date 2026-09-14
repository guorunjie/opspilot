# 异步能力入口

`AsyncCapabilityRegistry` 为异步 Connector 提供注册、元数据查询和分阶段调用。同步 Demo 的 `CapabilityRegistry` 保持原有接口；此版本用于需要等待浏览器、Planner 或 Connector 的开发集成。

每个能力声明 id、riskLevel、preconditions、validateCurrent、run；写能力另需 authorize。元数据只能返回 id/riskLevel，调用方不能取出内部执行函数。重复 id 和缺少必需门槛均拒绝。

调用顺序为：复制请求与上下文 → 检查取消 → 等待前置条件 → 等待写授权 → 同步核对最新状态 → 调用执行函数。各门槛仅接受布尔 true，输入彼此隔离。AbortSignal 保留原对象，不通过结构化复制丢失取消能力。

`validateCurrent` 必须同步，负责检查当前 Task、Connector/门店、计划明细、幂等键、状态及审批。它与执行函数调用之间不插入 await，避免使用等待前的旧审批快照。执行函数内部若还要等待，应在实际写入点再次检查状态与授权；Browser Workflow 已提供逐写步骤检查。该入口不是跨进程事务，也不能阻止外部平台自行改变状态。

真实写入无论上下文参数如何设置均拒绝。运行函数只由可信应用装配，不接受用户或模型传入钩子；这不是插件沙箱。持久化、所有权、幂等和中断后的 UNKNOWN 由 Async Task Agent 管理。

取消后仍等待原执行 Promise 结束，不把取消请求当作执行已终止。原始执行异常保留，包括 `executionMayContinue` 标记，供 Agent 保留所有权并阻止不安全重试。没有自动重试或自动 VERIFIED。

## 验证范围

单元测试覆盖真实写入禁止、严格门槛、数据隔离、等待期间撤权、取消阻止执行及不确定终止异常传播。`scripts/verify-offline-browser.mjs` 的合成价格流程已使用此入口，并保持预览/审批后的执行与独立回读。尚未接入普通用户安装版，也不代表完整生产 Connector SDK 或真实门店验收。

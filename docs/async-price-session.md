# 异步价格会话（开发中）

`openAsyncPriceSession` 组合持久 Task、所有权、异步能力入口、规则规划器和独立保存的 Mock 价格目标。提供 check、preview、confirm、execute、readback、recover、whenIdle 与只读 snapshot。

只接受可信应用提供的合成 products、独立 store 和 sessionId，不接收生产 Connector、账户或网络配置。不会读取或迁移现有 `pharmacy-session` 旧版存档。目标记录使用 `async-price:<sessionId>`，任务与所有权使用既有模块的键；调用方必须提供隔离的数据库命名空间。

## 保存顺序

明确确认后先保存本次场景预留，再由 Agent 保存 EXECUTING 检查点，之后才修改并保存模拟价格目标，最后保存 SUBMITTED 或 UNKNOWN。目标提交记录最多一次。再次执行不会更改场景，也不会覆写已提交目标。

如果中断发生在场景预留之后、执行检查点之前，预留保持占用，不自动重试。这种未执行预留的用户恢复入口仍待实现。不得通过改场景、换运行 ID 或重新调用 execute 消除不确定性。

回读独立读取目标记录。正常、响应丢失、价格不一致、首次回读不可用四种场景分别保留原有语义。关闭重开不自动执行或验证；recover 需要调用方确认旧执行已停止，所有权记录仍受底层约束。此 API 不负责确认操作系统进程死亡，也不自动清除遗留所有权。

测试覆盖真实 SQLite 文件关闭重开、四种场景、两个句柄竞争，以及目标已提交但最终 Task 检查点失败。后者保留 EXECUTING，明确恢复为 UNKNOWN 后仅回读，提交次数仍为 1。

当前未接入桌面页面、安装包或浏览器 Connector；snapshot 是会话模型，页面投影与旧存档并行处理仍在开发中。不是生产执行完成，也不取代真实门店验收。

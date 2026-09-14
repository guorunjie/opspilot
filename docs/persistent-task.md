# 独立持久化 Task

`src/storage/persistentTask.js` 的 `openPersistentTask` 将规范 Task 接到现有 SQLite 条件写入存储。它供应用层组合使用，不自动运行任务，也不连接真实平台。

```js
const store = openStateStore(databaseFile, 'application-tasks');
const task = openPersistentTask({ store,
  scope: { id: 'task-1', namespace: 'offline_demo', connectorId: 'mock', storeId: 'demo-store' },
  create: true });
const agent = createLocalTaskAgent({ ...task, planner, gateway,
  writeCapabilityId: 'mock-write', readCapabilityId: 'mock-read' });
```

应用拥有连接生命周期、文件权限、路径隔离、固定能力入口和可信授权。省略 `create` 时，任务不存在即失败；显式创建也不会覆盖已有记录。该接口不提供删除或复位。内部使用 `task:<id>` 键，要求同一存储命名空间内任务 ID 唯一。

读取重放任务历史并核对完整身份范围。每次 checkpoint 只接受当前状态之后的一个合法事件；旧状态、替换历史、跳过事件或改变门店均拒绝。SQLite revision 条件写入防止读取与保存之间的竞争覆盖。保存异常或确认不一致后，该句柄停止使用；应用须重新打开并核对，不能自动重复写入。

与 Local Task Agent 组合时，START 检查点在调用写能力前单独保存，BEGIN_VERIFY 在只读回读前单独保存。若 START 保存成功但确认响应丢失，连接器尚未调用，重开时仍只能保守进入 UNKNOWN；不得把不确定当作重试授权。

这是同步持久化适配器，不是完整异步 Runtime。异步连接器、执行所有权/租约、超时与迟到响应、进程退出后的外部操作核对仍须继续实现。`recover()` 只能在确认旧执行者已停止后调用，不能由第二个活跃执行者任意接管。revision 防覆盖不等于平台幂等，也不保证跨系统 exactly-once。

存储内容是本地未签名记录：重放验证一致性，不验证授权来源真实性。自定义 store 必须可信、同步并正确实现原子条件写入；不要接入模型生成的存储/审批函数。

当前三条桌面 Demo 仍使用原有会话事务，未改成此独立任务存储。此适配器通过实际 SQLite 双连接与 Local Task Agent 的组合测试；不代表真实连接器或异步链路验收。

# 异步 Task Agent（开发中）

`createAsyncTaskAgent` 复用规范 Task 状态机与同步原子 checkpoint，允许 Planner、Memory 与模拟 Capability Gateway 返回 Promise。所有改变任务的接口返回 Promise；`snapshot()` 可在等待期间读取已保存状态。

应用可将 `openPersistentTask` 返回的 `getTask/checkpoint` 传入。存储钩子与 gateway.get 必须同步；其余钩子由应用提供并负责真实的输入范围、前置检查和授权校验。该组合器不把任意插件当可信代码，不替代 Capability Gateway 的授权机制。

异步入口还必须传入 `ownership: createTaskOwnership({ store, scope })`，不能省略。所有参与者必须使用同一数据库、存储命名空间及任务范围；不同数据库或绕过此入口的调用不受此锁约束。例：

```js
const task = openPersistentTask({ store, scope, create: true });
const ownership = createTaskOwnership({ store, scope });
const agent = createAsyncTaskAgent({ ...task, ownership, planner, gateway,
  writeCapabilityId: 'mock-write', readCapabilityId: 'mock-read' });
```

所有改变状态的命令先通过 SQLite 条件写入取得新随机所有权标识。检查点和能力调用前重新核对所有权；命令完成且异步调用结束后才释放。等待超时后旧调用尚未结束时，锁保留在 SQLite 中，其他合规实例也不能继续核对或恢复。释放确认异常会使实例停止使用，不静默报告完成。

执行顺序为 START 落盘 → 固定 simulated_write 能力 → SUBMITTED 或 UNKNOWN；单独调用 verify 后才会 BEGIN_VERIFY → readonly 回读 → 逐项目标核对。写接口即便返回 VERIFIED，也只按 UNKNOWN 处理。真实写能力在此入口不允许。

`timeoutMs` 默认 30 秒，范围 1–600000 毫秒，分别约束一次规划（含记忆读取）、执行或回读。超时会请求 AbortSignal 中止，但不宣称外部调用已终止。执行/回读超时保存 UNKNOWN；原 Promise 未结束前，同一实例拒绝新的改变状态操作。原调用结束后的迟到结果或拒绝不改变任务，必须显式重新核对，不能重新写入。

任意 await 后只允许接续原检查点，外部改变任务会导致拒绝提交并停止使用该实例。一次处理期间阻止同实例重入；同步 SQLite 条件写入仍是跨连接防覆盖边界。

## 恢复约束

`recover({ previousExecutorStopped: true })` 只把 EXECUTING/VERIFYING 改为 UNKNOWN，不执行写入。这个参数是可信应用对旧执行者确实终止的断言，不是终止证据。若旧进程退出时遗留所有权记录，应由宿主先核实该执行者及其外部操作已停止，再按 `ownership.inspect()` 中的准确 token 调用 `releaseAbandoned({ token, executorStopped: true })`，之后才能取得新所有权并恢复。错误 token 或未明确确认停止会拒绝。不可把等待超时、心跳过期或持有者进程消失直接当作浏览器/远端操作已停止。

此锁不设自动过期时间，也不自动抢占。所有权存储是应用协调机制，不是恶意代码隔离或授权凭证；能直接改数据库或调用释放接口的代码必须可信。宿主级进程身份、浏览器关闭确认和进程中断后的真实目标核对仍未接入。

计时器不是硬实时取消，也无法抢占阻塞 JavaScript 或停止不遵守 AbortSignal 的外部系统。一个永不结束的 Promise 会让实例保持不可操作；应由宿主终止执行环境、确认停止，再重新打开核对，不自动解除锁或盲目重试。

`await agent.whenIdle()` 等待当前命令、原异步调用及所有权释放收尾；它不会取消操作或自动恢复业务，也不是未来命令的锁。释放失败会拒绝。可信 Connector 若不能确认外部执行停止，应抛出带 `executionMayContinue: true` 的错误：Agent 保存 UNKNOWN、保留所有权、拒绝 whenIdle 和继续操作，直到宿主真正核验后按遗留所有权流程处理。没有该标记不构成远端已停止的独立证明，Connector 必须正确实现这一契约。

## 当前验收范围

针对性测试覆盖异步正常闭环、并发拒绝、写/读超时、迟到结果和拒绝、保存失败、过期规划、恢复门槛、真实写拒绝及生成内容不能授权。所有权测试覆盖独立 SQLite 连接、真实子进程争用、子进程退出后残留锁、条件写入竞争、第二 Agent 在原超时调用结束前不能接管和释放确认丢失。当前尚未接入桌面 UI、RPA 浏览器或真实平台；不应称为完整异步生产 Runtime。原同步 Demo 保持原实现。

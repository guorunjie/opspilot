# 异步 Task Agent（开发中）

`createAsyncTaskAgent` 复用规范 Task 状态机与同步原子 checkpoint，允许 Planner、Memory 与模拟 Capability Gateway 返回 Promise。所有改变任务的接口返回 Promise；`snapshot()` 可在等待期间读取已保存状态。

应用可将 `openPersistentTask` 返回的 `getTask/checkpoint` 传入。存储钩子与 gateway.get 必须同步；其余钩子由应用提供并负责真实的输入范围、前置检查和授权校验。该组合器不把任意插件当可信代码，不替代 Capability Gateway 的授权机制。

执行顺序为 START 落盘 → 固定 simulated_write 能力 → SUBMITTED 或 UNKNOWN；单独调用 verify 后才会 BEGIN_VERIFY → readonly 回读 → 逐项目标核对。写接口即便返回 VERIFIED，也只按 UNKNOWN 处理。真实写能力在此入口不允许。

`timeoutMs` 默认 30 秒，范围 1–600000 毫秒，分别约束一次规划（含记忆读取）、执行或回读。超时会请求 AbortSignal 中止，但不宣称外部调用已终止。执行/回读超时保存 UNKNOWN；原 Promise 未结束前，同一实例拒绝新的改变状态操作。原调用结束后的迟到结果或拒绝不改变任务，必须显式重新核对，不能重新写入。

任意 await 后只允许接续原检查点，外部改变任务会导致拒绝提交并停止使用该实例。一次处理期间阻止同实例重入；同步 SQLite 条件写入仍是跨连接防覆盖边界。

## 恢复约束

`recover({ previousExecutorStopped: true })` 只把 EXECUTING/VERIFYING 改为 UNKNOWN，不执行写入。这个参数是可信应用对旧执行者确实终止的断言，不是终止证据或租约系统。应用不得在旧实例或浏览器调用仍活跃时另开实例绕过等待锁。多进程执行所有权、浏览器关闭确认和进程中断后的目标核对尚须补齐。

计时器不是硬实时取消，也无法抢占阻塞 JavaScript 或停止不遵守 AbortSignal 的外部系统。一个永不结束的 Promise 会让实例保持不可操作；应由宿主终止执行环境、确认停止，再重新打开核对，不自动解除锁或盲目重试。

## 当前验收范围

针对性测试覆盖异步正常闭环、并发拒绝、写/读超时、迟到结果和拒绝、保存失败、过期规划、恢复门槛、真实写拒绝及生成内容不能授权。当前尚未接入桌面 UI、RPA 浏览器或真实平台；不应称为完整异步生产 Runtime。原同步 Demo 保持原实现。

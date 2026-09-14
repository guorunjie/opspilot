# 浏览器动作描述与工作流

`compileBrowserWorkflow` 校验并冻结版本 1 动作描述，生成确定性 SHA-256 digest。支持最多 100 个唯一步骤：`assertText`、`readText`、`fill`、`click`。每步必须提供 id/type/selector，断言和填写还需字符串 value。不接受额外字段、任意脚本、导航地址、循环或隐式步骤。

```js
const workflow = { version: 1, id: 'price-write', steps: [
  { id: 'before', type: 'assertText', selector: '#observed', value: '2000' },
  { id: 'target', type: 'fill', selector: '#price', value: '1800' },
  { id: 'submit', type: 'click', selector: '#submit' }
] };
```

这是一份可信 Connector 的固定演示定义，不是示例平台生产操作。业务范围、目标金额及 workflow digest 必须与当前 Task 授权绑定，不能直接执行模型输出或导入的工作流。

## 执行契约

`runBrowserWorkflow` 要求独立 offline Runtime、显式 preconditions；含 fill/click 时必须提供 authorize。条件仅接受布尔 true。传给门槛的定义和上下文各自复制；在每个写步骤和等待步骤日志之后都检查当前授权。固定定义摘要不是用户授权本身。

每步通过 onStep 记录 STARTED，再定位唯一目标、执行，最后记录 COMPLETED。可以使用 SQLite 保存日志；日志保存失败即停止。每个写入调用前保守设置 possibly_started；写入或后续日志失败不自动重试。缺失/多匹配均停止，不选择第一个目标。只读值保留字符串，空文本不是数值零，交由 Connector 显式解析。

步骤超时由 Playwright Runtime 控制；整条操作的超时和取消由 Async Task Agent 与 runtime.run 的 AbortSignal 联动。没有额外盲目重试循环，明确未开始的恢复可使用已有恢复算法另行设计。

返回 COMPLETED 仅代表步骤执行完成，不表示平台目标 VERIFIED。实际验证仍要在独立 read 工作流获取状态后交给目标验证器。该函数本身无持久化幂等记录，必须从持久 Task/所有权/审批 Gateway 调用；不得在未知结果后直接重新调用写工作流。

## 验收范围

本机 `node scripts/verify-offline-browser.mjs --headed` 使用该执行器替代原硬编码点击/读文本：核对原价、填写目标、点击、独立读取，保留 8 条 SQLite 步骤事件，最终仅提交一次，并继续进行 CDP 采证。单元测试覆盖非法动作、缺失授权、歧义目标、授权撤销、日志失败与禁止重试。

仍未接入普通用户安装版、生产 Connector 或 Recorder/Replay；不包含图形化 Workflow Builder（首版不做）。

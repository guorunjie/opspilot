# 页面 CDP 与证据采集

`openPageCDP({ context, page, scope, simulated })` 在可信应用传入的页面上创建 Playwright CDP session。确认 page 属于该 context，不接收任意远程调试 URL，也不暴露通用 send、Runtime.evaluate、导航或输入指令。

- `readDOM(selector)` 只读取 DOM：零匹配返回 MISSING、多匹配返回 AMBIGUOUS，两者均无证据对象；唯一匹配才返回 outerHTML 证据。
- `screenshot()` 采集当前视口 PNG，不等同于全页截图；校验 PNG 标记与大小上限。
- `detach()` 只断开本适配器会话，不关闭应用浏览器。操作进行中不允许 detach；成功断开后不能再读取。

该接口不识别“页面是否真实门店”，`simulated` 是可信应用声明。本轮仅接入独立离线浏览器，未接入用户浏览器或生产平台。拥有上下文的应用必须维持安全与隐私边界，不得向模型开放底层 page/session。

## PageEvidence

每份产物包含单独的 bytes 和元数据：随机 ID、版本、内容类型、采集时间、字节数、SHA-256、模拟标志，以及 namespace/taskId/planId/runId/connectorId/storeId。调用方负责保存文件或存储，核心模型不会写任意文件路径。

摘要用于检测内容变化，不是签名、来源认证或审批证明。范围和采集时间由可信应用提供；DOM 和截图分别采集，不是原子快照。页面内容会变化，不能把一张截图或声明的计划编号当作业务 VERIFIED。Connector 仍须校验身份、解析目标值，并交给逐项目标验证器。

原始 DOM/截图可能包含敏感数据；本轮只使用合成内容，验收输出不提交到 Git。未来生产连接器须补充脱敏、保留期限和访问控制。

## 验收

`node scripts/verify-offline-browser.mjs --headed` 已在本机真实 Chromium 上完成正常异步模拟闭环，随后使用 CDP 获取唯一价格 DOM、验证缺失目标、生成 PNG/元数据，并断开会话。输出 `output/playwright/offline-browser/cdp-evidence.*`；元数据摘要与实际字节匹配。单元测试另覆盖多匹配、范围复制、断开后拒绝读取及非法输入。

这是只读 CDP 适配与证据基础，不代表完整写动作 DSL、Recorder/Replay、企业审计或生产连接器已完成。

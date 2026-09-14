# 隔离浏览器 Runtime（开发链路）

`openOfflineBrowser({ browserType: chromium })` 使用应用提供的 Playwright Chromium launcher 启动新浏览器和非持久上下文。它不连接用户 Chrome、不读取浏览器资料或 Cookie 文件，也不连接已有 CDP 会话。当前供可信合成页面使用；生产平台连接适配仍未完成。

默认 headless；`headless: false` 可观察窗口。启动和页面操作默认 10 秒超时，允许 1–60000 毫秒。没有开放任意启动参数、用户资料路径、下载目录或 URL。上下文 offline，禁用服务工作线程、下载和权限；HTTP 路由中止，WebSocket 路由关闭。`load(html)` 添加限制性 CSP，禁止页面脚本、外部资源、网络连接和表单提交。所有页面行为应由可信测试/Connector 程序安装，不执行用户提供的脚本。

这是应用隔离措施而非 OS 沙箱。page 句柄只交给可信应用；拿到句柄的任意代码能够改变上下文或调用其他网络 API，不能把这里当成恶意插件的权限边界。浏览器进程级系统流量未做操作系统防火墙验收。

`close()` 必须等待 Playwright 的 browser.close 完成并检查连接/页面关闭；失败保持 UNKNOWN，不能报告关闭成功或解除需要终止证明的遗留任务。重复成功关闭幂等。启动中失败也尝试关闭新建浏览器；清理失败保留两项错误。关闭操作本身不通过 Promise.race 提前伪装完成；宿主进程级截止与遗留执行者核验仍待接入。

## 实际浏览器验收

安装项目依赖及对应 Playwright Chromium 后运行：

```sh
node scripts/verify-offline-browser.mjs --headed
```

脚本仅使用临时 SQLite、空白独立浏览器和内存合成页面。固定样例通过现有异步 Task、持久化检查点和所有权入口，验证：未确认不点击 → 已确认后单次点击 → SUBMITTED 不等于 VERIFIED → 单独读取页面价格 → VERIFIED → 禁止重复执行 → 确认关闭。还检查空 Cookie、页面脚本及 fetch 被阻止。

输出位于 `output/playwright/offline-browser/`，不会发布模拟截图和数据库。单元测试覆盖配置边界及启动/关闭失败；实际 Chromium 脚本独立运行，不把函数桩检查冒充浏览器验收。

该脚本是开发验收，不是面向普通用户的新版安装程序。目前尚未接入桌面三条 Demo、CDP、Recorder/Replay 或生产 Connector；异常执行中断与真实浏览器关闭的完整联动仍待验收。

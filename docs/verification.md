# 早期 Demo 验证记录

## 已发布预览版：0.1.0-dev.2

[发行页](https://github.com/guorunjie/opspilot/releases/tag/v0.1.0-dev.2)对应标签提交 `47e495f9494a9ec1047984c02b6b309b30cc2e6e`，不是完整 Foundation 完成声明。

[标签发行流程](https://github.com/guorunjie/opspilot/actions/runs/34879370967)已通过：44 项单元测试、Windows x64 和 macOS arm64 构建、实际安装/应用复制、安装后 app.asar 核对、四种 UI 场景、重启恢复、复位和卸载/应用移除。草稿产物校验通过后，人工审核并发布为 prerelease，未标为稳定最新版。

Windows 在临时 CI 中静默安装 NSIS；macOS 只读挂载 DMG 并复制应用到临时目录。测试驱动不修改打包应用、不使用源码启动器。此证据不能替代普通用户交互向导、下载隔离/Gatekeeper、可信发行者签名、公证或真实平台验收。

发布的安装包 SHA-256：

- Windows：`d9b59a91b325b43fb6c49ee6518240291d7d8e68c9752299b38ae1ef7f79b588`
- macOS arm64：`b874ad9718003ee656af4d0b5bb0925dd550572dd1b677466dbc5b859656b1b2`

本机另有自行构建的同版本 Windows 候选，已检查升级、桌面快捷方式启动、四种场景、卸载重装和保留数据；它的二进制哈希与 CI 发布包不同，不能混用两者的校验值。旧 OpsPilot 安装保持独立。

## 早期源码检查（历史记录）

验证对象：源码提交 `afdab9a9141b3b33c9546274e1be5fab6910db06`，版本 `0.1.0-dev.2`。这是部分 Foundation 的验证，不是整个项目完成声明。

## 已验证

- GitHub Windows、macOS、Linux 的 Node.js 24 单元测试均通过，每个平台 32 项。[CI 运行记录](https://github.com/guorunjie/opspilot/actions/runs/34875458672)。CI 使用 `npm ci --ignore-scripts`，不启动桌面或验证安装包。
- Windows 本机从公开仓库重新克隆后，默认 `npm ci`、`npm test` 和 Electron 运行时准备完成，运行时版本 42.7.0；不是从旧商业项目复制依赖目录。
- 使用该公开副本自己的 Electron，实际桌面操作验证了正常提交、提交响应丢失、回读不一致、首次回读不可用四种场景。
- 每种场景均检查提交后退出、同一 SQLite 会话重开、禁止重复提交、回读结果保留，以及取消复位、确认复位、再运行一次正常操作。
- UNKNOWN 场景重开后仅读取目标，不重新执行，保留未知尝试历史；恢复的模拟确认显示为只读记录。

桌面验证由工作区外的 Playwright 驱动完成，测试启动器仅为应用指定临时 appData；该驱动和启动器不属于发行程序。上述独立副本验证仍在同一 Windows 主机上进行，可能使用下载缓存，不等于全新机器验收。退出发生在已保存提交之后，不是写入过程中的断电测试。

## 尚未验证或未完成

- 普通用户交互安装向导、全新终端下载后的系统安全提示及非开发用户独立体验；CI 运行不能代替这些检查。
- 可信发行者代码签名、公证，Intel macOS 安装发行与真实终端体验。
- 通用 Agent、Capability、RPA、三类经营机会的完整实现及商业仓依赖集成。
- 真实平台、真实经营效果和生产级恢复：**WAITING_FOR_REAL_VALIDATION**。

首次启动可能下载 Electron。安装完成或单元测试通过都不能替代桌面启动检查；模拟回读通过也不能替代真实平台验证。

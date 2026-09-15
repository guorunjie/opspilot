# OpsPilot

**一个开源、本地优先的 AI 经营运营 Agent，专注安全、可审批、可验证的业务自动化。**

OpsPilot 的目标，是把经营数据中的问题、机会和建议，真正转化为可以被安全执行并核实结果的经营动作。

它不只关注“有没有触发操作”，而是强调完整的经营执行闭环：

**发现问题 → 给出建议 → 预览操作 → 明确确认 → 执行 → 平台回读 → 核实结果 → 经营复盘**

OpsPilot 包含 Agent Runtime、Capability 能力框架、浏览器 / RPA 自动化能力、审批与验证机制、离线演示环境，以及可扩展的 Connector 连接器体系。

目前，**医药即时零售 O2O** 是 OpsPilot 的第一个真实生产落地方向，但底层架构尽量保持通用，可继续扩展到零售、电商、本地生活和其他经营自动化场景。

> 发布状态：本仓库处于 OpsPilot 2.0 Foundation 建设阶段。`dev.6` 预览版支持合成价格调整、库存同步、固定活动报名三条独立模拟闭环，各自需要预览、确认、执行与回读；提供单实例保护和明确确认后的本机模拟任务恢复（不重新提交）。新增明确确认后保留旧记录并开始独立新版演示，旧授权不会继承。新建演示使用持久异步价格任务；旧记录不会自动迁移。完整恢复验收、桌面浏览器 Connector、商业仓接入和真实平台验收仍未完成；以下介绍包含计划范围。Open Core 采用 Apache-2.0。

## 快速体验

早期预览版 `0.1.0-dev.6`：

- [Windows x64 安装包](https://github.com/guorunjie/opspilot/releases/download/v0.1.0-dev.6/OpsPilot-Core-Demo-0.1.0-dev.6-win-x64.exe)
- [macOS Apple Silicon 安装包](https://github.com/guorunjie/opspilot/releases/download/v0.1.0-dev.6/OpsPilot-Core-Demo-0.1.0-dev.6-mac-arm64.dmg)
- [发行说明、校验值与已知限制](https://github.com/guorunjie/opspilot/releases/tag/v0.1.0-dev.6)

Windows 未签名，macOS 未做 Developer ID 签名或公证。如果系统阻止运行，不要关闭安全检查。当前版本用于离线 Demo 评估，不是生产可用版本，也未完成所有普通用户安装验收。

安装包用户无需 Node.js 或命令行。Windows 安装后从桌面或开始菜单打开“OpsPilot Open Core Demo”；不要误开旧商业版“OpsPilot”。已有演示记录会保留，升级程序不会自动执行、复位或迁移它们。

开发者从源码运行：安装 Node.js 24 或更高版本后：

```sh
git clone https://github.com/guorunjie/opspilot.git
cd opspilot
npm ci
npm test
npm start
```

依赖下载需要网络。启动后使用合成药房数据，按“诊断 → 预览 → 明确确认 → 模拟执行 → 回读 → 复盘”体验，不需要真实平台账号。支持正常提交、响应丢失、回读不一致、首次回读不可用四种场景，以及会话恢复和确认复位。

详见[使用指南](docs/getting-started.md)。本机 Windows 测试不代表 macOS、全新机器或真实平台验收；安装包以 Releases 的实际资产和说明为准。

## 许可证

OpsPilot Open Core 采用 [Apache License 2.0](LICENSE)。完整条款以许可证正文为准。

此许可适用于本仓库发布的 Open Core 内容，不代表现有商业仓、未公开的生产 Connector、行业策略或客户数据一并开源。第三方依赖及其附带声明继续遵循各自许可证；不要删除原有版权和归属声明。

## 为什么做 OpsPilot

很多自动化工具在“提交操作”之后就结束了。

但在真实经营场景里：

**提交成功，不代表平台真的执行成功。**

所以 OpsPilot 遵循四个核心原则：

- **缺少数据 ≠ 数值为零**
- **尚未检查 ≠ 状态正常**
- **已经提交 ≠ 已经执行成功**
- **系统建议 ≠ 用户已经授权**

对于重要经营动作，OpsPilot 希望明确记录：

- 当前状态；
- 数据依据；
- 操作内容；
- 用户授权；
- 执行结果；
- 平台回读；
- 验证证据；
- 异常与恢复过程。

无法确认的结果，应明确表示为“待验证”或“未知”，而不是直接报告成功。

## 开源核心

OpsPilot 的开源版本不是一个只有接口的精简 SDK，而是希望成为一个真正可以运行、体验和扩展的本地经营助手。

开源部分计划包含：

- Agent Runtime
- 任务状态机
- Capability Registry / Gateway
- 审批机制
- Verification 验证框架
- Rollback 回滚协议
- Evidence 证据模型
- 浏览器 / RPA Runtime
- Playwright / CDP 适配
- Workflow 工作流能力
- Connector SDK
- Recorder / Replay
- 离线 Demo
- 本地存储
- 基础 Opportunity 机会模型
- 基础价格、库存和活动机会识别
- Mock Connector
- Community Connector

RPA 基础能力属于 Open Core 的一部分。

OpsPilot 不希望依靠隐藏浏览器自动化能力建立商业壁垒，而是希望通过开放底层执行框架，让社区可以开发新的 Connector、工作流和应用场景。

## 商业能力边界

部分与真实生产运营、行业经验和企业级管理相关的能力可能由商业版本持续维护，例如：

- 官方生产级平台 Connector
- 长期维护的平台适配与异常处理
- 医药行业高级经营策略
- 高级 Opportunity Scoring
- 经营影响评估
- 跨门店优化
- ROI 与效果归因
- 多门店 Control Plane
- 企业级 RBAC / SSO
- 高级审批与审计
- Benchmark
- 企业级监控、SLA 和托管能力

开源 Core 负责通用的“执行骨架”，商业版本重点提供行业经营智能、生产连接能力和企业级管理能力。

## 当前重点

当前阶段是 **OpsPilot 2.0 Foundation**。

这一阶段不追求增加更多平台和功能，而是优先把 OpsPilot 做成一个普通用户可以独立理解和使用的产品。

当前重点包括：

- 更清晰的安装和启动入口；
- 与真实环境完全隔离的离线 Demo；
- 可重复、一键复位的演示流程；
- 普通用户无需开发者讲解即可完成核心任务；
- 渐进式真实门店接入；
- 首次可信经营诊断；
- “今日重点”经营机会；
- 建议 → 预览 → 确认 → 执行 → 平台回读 → 复盘的完整流程；
- 持久化任务状态；
- 防止重复执行；
- 执行中断后的安全恢复；
- 平台结果逐项核实；
- 明确区分成功、失败、待验证和未知状态。

## 第一个真实应用方向

OpsPilot 当前首先聚焦：

**医药即时零售 O2O 经营自动化。**

重点关注 **美团、淘宝闪购、京东医药 O2O** 等经营场景与平台接入方向。具体 Connector 的公开范围、支持状态和验证结果将单独说明；列出平台名称不代表当前开源版本已完成接入，也不代表获得平台官方认证或合作授权。

包括但不限于：

- 商品价格竞争力；
- 高价值缺货；
- 活动机会；
- 成本与利润保护；
- 经营任务执行；
- 平台结果验证；
- 日常经营复盘。

后续仍会保持底层 Core 的通用性，让 OpsPilot 可以扩展到更多行业与平台。

## 安全原则

OpsPilot 不用于绕过平台的安全、授权或风控机制。

项目不鼓励，也不应支持：

- 绕过验证码；
- 绕过人机验证；
- 绕过账号授权；
- 绕过平台风控；
- 使用未经授权的内部接口；
- 在用户未明确确认的情况下执行高风险经营操作。

真实写入能力默认应保持关闭。

任何可能影响真实店铺、商品、价格、活动或其他经营状态的动作，都应经过明确授权和安全校验。

## 社区与交流

项目资料：[架构与阶段边界](docs/architecture.md) · [贡献指南](CONTRIBUTING.md) · [安全反馈](SECURITY.md) · [社区行为准则](CODE_OF_CONDUCT.md)。

OpsPilot 仍在持续演进。

非常欢迎：

- 使用反馈
- Issue
- Pull Request
- Connector
- RPA 工作流
- 新的经营场景
- 架构建议
- 产品建议
- AI Agent 实践经验

如果你正在关注或实践：

- AI Agent
- RPA / 浏览器自动化
- 零售与电商运营
- 即时零售 O2O
- Connector 开发
- 安全执行系统
- 医药零售数字化
- 真实业务自动化

都非常欢迎交流。

**邮箱：guorunjier@163.com**

欢迎交流 OpsPilot、AI Agent、RPA、零售 O2O、连接器开发，以及真实业务自动化实践。

也欢迎通过 Issue 和 Pull Request 参与项目建设。

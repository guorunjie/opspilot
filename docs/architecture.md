# Open Core 架构与阶段边界

本文描述目标架构，不代表所有模块已经公开实现。

## 单向依赖

Enterprise → Open Core。Core 不导入商业仓库；商业产品通过固定版本的 Core 包复用能力，不长期手工复制实现。

Core 提供本地桌面与控制台、Agent/Planner 接口、任务状态、Capability Gateway、审批、证据、执行与验证、SQLite、通用 RPA Runtime 和 Connector SDK。生产平台 Recipe、长期维护的 Selector、行业高级策略和企业管理能力可由商业产品提供。

## 第一条纵向链路

Opportunity → Recommendation → Preview → Approval → Execute → Connector Readback → Verify → Review。

优先在 Demo Pharmacy 的价格建议上完成这条链路，再补库存与活动的基础机会。先让用户理解依据、范围和风险，再确认执行；提交响应不能代替目标状态的逐项验证。

## 可靠性约束

- 缺少数据不是零，未检查不是正常，建议不是授权，提交不是成功。
- 目标状态包括 NOT_CHECKED、MISSING_DATA、READY、AWAITING_APPROVAL、EXECUTING、SUBMITTED、VERIFYING、VERIFIED、PARTIALLY_VERIFIED、FAILED、ROLLED_BACK、UNKNOWN。
- UNKNOWN 必须保留，不自动转为成功或无条件重试。
- 真实 Connector 需执行前 checkpoint、幂等标识、提交后回读和恢复契约。事务内保存 Mock 目标与任务不能证明真实平台具备原子性。
- 回滚是一项需要验证的操作；不能只因发出回滚请求就报告 ROLLED_BACK。

## Demo 隔离

Demo 使用独立数据、合成 fixtures、任务/调度命名空间、历史及 Mock Connector，不读取真实配置、凭证或浏览器会话，不调用生产 Connector，不启动生产调度。复位仅影响 Demo，不能清除真实执行的未决状态。

## 当前公开状态与验收

公开仓库提供 Apache-2.0 授权的离线 Demo 源码、SQLite 会话存储、桌面入口、单元测试和三平台 CI 配置。操作说明见[使用指南](getting-started.md)。当前开发源码支持价格调整、库存同步及固定活动报名三条独立模拟闭环；每条使用固定合成样本，不代表通用行业策略或真实经营效果。

当前开发源码的 117 项测试及 Windows 源码桌面三类机会各四种场景、提交后退出/重启、回读恢复、复位重复检查通过。已发布的 `v0.1.0-dev.3` 预览安装包还通过 Windows/macOS 临时 CI 的实际安装、三类机会共 12 组界面场景、重启/复位与卸载验收，见[验证记录](verification.md)。这不等于无需讲解的真实用户测试，也不代表所有本机安装已自动升级。真实店铺验证标记为 **WAITING_FOR_REAL_VALIDATION**。

新 Demo 已接入[规范任务状态](task-state.md)、[本地能力入口](local-capabilities.md)、[逐项目标验证](target-verification.md)、[规则价格规划](rule-price-planner.md)和[本地 Task Agent 编排](local-task-agent.md)。规划与只读历史记忆不提供授权；执行和回读由固定能力入口分开处理。任务及模拟目标在同一 SQLite 事务保存。

现有 platformActionProtocol 保留为过渡兼容协议，其证据标志不能单独证明目标成功。新 Task 在 Demo 中是规范状态，旧 v1 存档仍走经过校验的兼容路径，直到用户明确复位。[库存与活动](supplemental-opportunities.md)使用独立 Task，首次使用后存档为 v3，不兼容旧程序降级读取。尚未完成：持久化异步 Agent、复合意图规划、完整经营模型、通用 RPA/Connector SDK、完整回滚执行及商业仓依赖集成。同步 Mock 的原子保存不能替代真实平台的执行前持久化与中断后核对。

阶段顺序：P0 仓库基础 → P1 离线体验 → P2 可靠性 → P3 通用模块抽取 → P4 商业仓依赖集成 → P5 真实验证。每阶段重新核实基线、拆分任务并估算。

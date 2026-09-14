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

已发布的 `v0.1.0-dev.5` 预览版通过 Windows/macOS 临时 CI 安装、12 组普通界面场景、5 个进程退出恢复点、重启/复位与卸载验收，见[恢复证据与限制](process-exit-recovery.md)。后续源码的[旧存档保留与显式切换](legacy-demo-upgrade.md)也通过双平台候选验收，正在准备独立的 dev.6 版本；不能把候选结果当作该版本发行验收。当前本地单元测试为 234 项通过。这不等于无需讲解的真实用户测试，也不代表所有本机安装已自动升级。真实店铺验证标记为 **WAITING_FOR_REAL_VALIDATION**。

新建 Demo 经 `createDesktopDemo` 接入[异步价格会话](async-price-session.md)、[持久化 Task](persistent-task.md)、[异步 Agent](async-task-agent.md)、[规范任务状态](task-state.md)、[逐项目标验证](target-verification.md)和[规则价格规划](rule-price-planner.md)。规划与只读历史记忆不提供授权。价格 Task 检查点、模拟目标和回读分别持久化；库存/活动仍使用同步 Mock，把单项 Task 与合成目标原子保存，不能据此声称所有 Connector 已异步化。

现有 platformActionProtocol 保留为过渡兼容协议，其证据标志不能单独证明目标成功。旧 v1/v2/v3 存档默认保留原执行方式，普通复位不迁移引擎。源码可通过默认取消的主进程确认框，把完整旧行嵌入 v4 标记并初始化独立新会话；旧确认不授权新任务，历史只读。v4 不能由旧程序静默降级读取。

阶段顺序：P0 仓库基础 → P1 离线体验 → P2 可靠性 → P3 通用模块抽取 → P4 商业仓依赖集成 → P5 真实验证。每阶段重新核实基线、拆分任务并估算。

## 已接入的可靠性边界

持久 Task 使用 SQLite 条件写入、逐事件校验和保存不确定后停用句柄。异步调用超时保持 UNKNOWN，原调用未结束前保留所有权，迟到响应不安装成功状态。桌面单实例锁减少重复启动；同安装 PID 存在性核验只有明确不存在才允许显式恢复。恢复不重新提交，回读独立进行；活进程、外来或未绑定的旧所有权仍阻止操作。这不是子进程/远程操作终止证明，也不是断电耐久性完整验收。

## RPA 开发接口与尚未接入部分

[隔离浏览器 Runtime](offline-browser.md)、[页面 CDP 证据](page-evidence.md)、[动作工作流](browser-workflow.md)、[录制/回放](workflow-recorder.md)和[浏览器恢复阶梯](browser-recovery.md)已有独立开发接口与合成场景验证。录制只导入定义，不导入授权；不明确的写入结果不能自动重放。它们尚未形成普通用户可用的桌面 BrowserConnector 纵向链路，不能把开发脚本运行当作安装版功能。

仍未完成：普通用户无讲解独立验收、桌面 RPA/Connector SDK 完整链路、复合意图规划、完整经营模型、完整回滚执行及商业仓依赖集成。依赖方向 Enterprise → Core 是目标约束，不能据此宣称商业仓已经完成改造。生产连接与真实门店验收另行进行，不以 Mock 替代。

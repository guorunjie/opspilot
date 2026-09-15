# Open Core 架构与阶段边界

本文描述目标架构，不代表所有模块已经公开实现。

## 单向依赖

Enterprise → Open Core。Core 不导入商业仓库；商业产品通过固定版本的 Core 包复用能力，不长期手工复制实现。

Core 的目标范围包括本地桌面与控制台、Agent/Planner 接口、任务状态、Capability Gateway、审批、证据、执行与验证、SQLite、通用 RPA Runtime 和 Connector SDK。生产平台 Recipe、长期维护的 Selector、行业高级策略和企业管理能力可由商业产品提供。

## 第一条纵向链路

Opportunity → Recommendation → Preview → Approval → Execute → Connector Readback → Verify → Review。

当前 Demo Pharmacy 已有价格、库存和固定活动三条合成链路。先让用户理解依据、范围和风险，再确认执行；提交响应不能代替目标状态的逐项验证。

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

当前发布为 `v0.1.0`，源码、双平台安装包及同提交验收回执已关联，包含 12 组界面场景、5 个进程退出恢复点、旧存档保留切换、复位与卸载。具体提交与证据见[版本验收记录](verification.md)，不混用早期候选的测试数量或哈希。这不代表本机安装自动升级，也不把离线结果作为真实店铺验收。

新建 Demo 经 `createDesktopDemo` 接入[异步价格会话](async-price-session.md)、[持久化 Task](persistent-task.md)、[异步 Agent](async-task-agent.md)、[规范任务状态](task-state.md)、[逐项目标验证](target-verification.md)和[规则价格规划](rule-price-planner.md)。规划与只读历史记忆不提供授权。价格 Task 检查点、模拟目标和回读分别持久化；库存/活动仍使用同步 Mock，把单项 Task 与合成目标原子保存，不能据此声称所有 Connector 已异步化。

现有 platformActionProtocol 保留为过渡兼容协议，其证据标志不能单独证明目标成功。旧 v1/v2/v3 存档默认保留原执行方式，普通复位不迁移引擎。源码可通过默认取消的主进程确认框，把完整旧行嵌入 v4 标记并初始化独立新会话；旧确认不授权新任务，历史只读。v4 不能由旧程序静默降级读取。

后续路线不要求重做已有成果：继承充分的验收证据，仅按具体代码、依赖、接口或安装变化补测，再冻结候选集中发布。

## 已接入的可靠性边界

持久 Task 使用 SQLite 条件写入、逐事件校验和保存不确定后停用句柄。异步调用超时保持 UNKNOWN，原调用未结束前保留所有权，迟到响应不安装成功状态。桌面单实例锁减少重复启动；同安装 PID 存在性核验只有明确不存在才允许显式恢复。恢复不重新提交，回读独立进行；活进程、外来或未绑定的旧所有权仍阻止操作。这不是子进程/远程操作终止证明，也不是断电耐久性完整验收。

## RPA 开发接口与尚未接入部分

[隔离浏览器 Runtime](offline-browser.md)、[页面 CDP 证据](page-evidence.md)、[动作工作流](browser-workflow.md)、[录制/回放](workflow-recorder.md)和[浏览器恢复阶梯](browser-recovery.md)已有独立开发接口与合成场景验证。录制只导入定义，不导入授权；不明确的写入结果不能自动重放。它们尚未形成普通用户可用的桌面 BrowserConnector 纵向链路，不能把开发脚本运行当作安装版功能。

私有宿主已完成最小 `host-execution-binding` 集成，保留本地 `platformActionProtocol` 安全状态机；详见[宿主接入](consumer-integration.md)。这不等于全部商业模块迁移，也不公开生产 Connector。原 V1.0 三平台验收按既有证据继承，历史证据绑定缺口保留，不以 Mock 替代或重复实盘。

后续范围包括桌面 RPA/Connector SDK 完整链路、复合意图规划、完整经营模型和完整回滚执行，不作为本次文档收尾的阻断。

普通用户独立使用尚未验证。本轮跳过，不列入验收清单、不作为发布阻断，也不标记通过。

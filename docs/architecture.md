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

公开仓库当前提供项目和协作说明；可运行 Demo 尚未发布，不能直接按本仓库安装使用。Open Core 许可证已确定为 Apache-2.0；代码发布审查、独立安装、CI、发行流程及跨平台验收仍需各自验证。

本地候选已进行模型和桌面恢复验证，但这些检查不等于公开版本验收，也不等于真实门店完成。真实店铺验证标记为 **WAITING_FOR_REAL_VALIDATION**。

阶段顺序：P0 仓库基础 → P1 离线体验 → P2 可靠性 → P3 通用模块抽取 → P4 商业仓依赖集成 → P5 真实验证。每阶段重新核实基线、拆分任务并估算。

# Connector 描述与就绪状态契约

Foundation 后续开发接口，不包含在冻结的 v0.1.0 安装包或标签中。它只处理元数据，不加载插件、不连平台、不接收配置值或凭证、不执行任务。首次消费须固定包含该接口的经审核 Git 提交，不能依据包内仍保留的 0.1.0 版本字段推断旧标签包含它。

```js
import { createConnectorManifest, assessConnectorReadiness } from 'opspilot/connector-manifest';

const manifest = createConnectorManifest({
  schemaVersion: 1,
  id: 'community.sample',
  label: 'Community sample',
  version: '1.0.0',
  platformIds: ['sample'],
  capabilities: [{
    id: 'sample.read', label: 'Read sample', operation: 'read',
    execution: 'local', simulated: true,
  }],
  requiredConfigKeys: ['sample.location'],
});
const status = assessConnectorReadiness(manifest, {
  configuredKeys: [],
  now: '2026-09-15T00:00:00.000Z',
  maxAgeMs: 60000,
});
// NOT_CONFIGURED; the caller has supplied key names, not configuration values.
```

声明包含平台标识、能力标识、读/写/补偿类型、本地/宿主执行位置、是否模拟以及必填配置键。未知字段、重复标识、稀疏数组和 getter 等非 JSON 元数据拒绝；输出为独立深冻结副本。只面向可信应用内的 JSON 数据，不是恶意 JavaScript/Proxy 沙箱。

本地 write/compensate 只能声明 simulated=true。非模拟写入只能声明由 host 执行；此声明不提供实现、不代表授权或允许调用生产接口。compensate 不表示所有平台支持回滚。

| 就绪结果 | 含义 |
| --- | --- |
| NOT_CONFIGURED | 调用方提供的配置键不齐全 |
| UNKNOWN | 未提供探测、探测未知、缺时间、时间在未来或已过期 |
| UNAVAILABLE | 有效期内的探测报告不可用 |
| READY | 有效期内的探测报告可用，不代表账号/门店鉴权或业务 VERIFIED |

now/checkedAt 使用带毫秒的标准 UTC ISO 时间，maxAgeMs 为 1–86400000。所有输入先校验，再判断缺配置；无效探测不能因配置不足而悄悄被接受。探测结果和时钟由可信宿主提供，本模块不证明其真实性。

接下来才是注册、配置管理、实际探测、能力调度及桌面展示。生产宿主仍保留原鉴权、确认/拒绝、锁、幂等及逐项证据；Core 不依赖 Enterprise。本接口不改变现有 real_write 禁令或 host-execution-binding 的关联语义。

本批由 DeepSeek 起草并修订（DS-029/030），GPT 审核数组访问器与输入验证顺序、修正测试夹具并接入导出。已做纯契约和导出定向检查，不作为真实平台或桌面接入验收。

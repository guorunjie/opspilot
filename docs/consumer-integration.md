# 私有宿主接入 Open Core

生产集成采用 **保留宿主本地 `platformActionProtocol` 安全状态机，Core 仅提供宿主执行绑定接口** 的方案。不要通过 re-export Core 协议替换宿主安全状态机。

## 接口与依赖

```js
import {
  createHostExecutionBinding,
  matchesHostExecutionBinding,
} from 'opspilot/host-execution-binding';
```

绑定必须包含 `version: 1`、`hostId`、`executionId`、`platformId`、`storeId`、`actionId` 和 `confirmationBindingSha256`。身份字段是非空、无首尾空白和控制字符的字符串，最长 512 字符；确认指纹为 64 位小写十六进制 SHA-256。构造器拒绝无效输入；匹配函数对缺失、无效或不一致的绑定返回 false。

这些函数只校验和关联身份元数据，不负责授权、持久化或逐项结果验证。`confirmationBindingSha256` 不是用户确认凭证，匹配成功也不代表 VERIFIED。

包保留 `private: true`，未发布到 npm registry。使用 Node.js 24 或更高版本，依赖须固定经审核的 Git 提交并提交 lockfile，不能使用浮动 main。`v0.1.0` 的提交为 `9080c10cf4e7142b4be0015eb143916e16e9d088`；现有私有宿主仍固定已验收的 `0638431ef2353a4df136544189f355723a7bc42b`，本次文档修正不要求升级或重复测试。

`opspilot/platform-action-protocol` 仍是公开兼容导出，但不作为当前私有生产宿主状态机的替换入口。根导入和未导出的私有子路径不受支持。库消费不启动 Electron、不加载凭证、不启用真实写入；桌面源码启动入口仍为 `desktop/demo.cjs`。

## 宿主必须保留的执行边界

- 复用既有 `/api/opspilot/action-run` 的角色鉴权、确认卡、拒绝卡、幂等及执行锁；真实写入默认关闭。
- 执行前固定用户确认对应的目标项目集合；按可信平台和门店身份建立绑定，不能用显示名称猜测门店身份。
- 持久化执行记录及其绑定，关联实际执行报告和逐项回读。不能只凭 HTTP 成功、命令完成或已提交报告成功。
- 缺少 executionId、平台身份、门店身份、动作 ID、确认指纹或逐项回读证据时保持 UNKNOWN；绑定不匹配、项目缺漏或重复也不能推断 VERIFIED。
- 中断后保留未决状态及重复执行保护；恢复不产生新授权，不盲目重写。

## 已完成与外部依赖

私有宿主最小绑定映射、证据关联和持久化已完成，相关必要 CI 通过后已审核合并。原 V1.0 三平台真实验收按既有证据继承；历史原始 JSON / 安装回执绑定仍有缺口，不能称为公开版生产验收。当前发行证据见[版本验收记录](verification.md)。

这不表示全部 Enterprise 模块已迁移到 Core。美团、淘宝闪购、京东秒送 / 京东医药 O2O 的生产 Connector、Recipe、Selector、凭证、客户数据和内部接口保持私有，由用户另行获得并授权接入。依赖方向只能是 Enterprise → Core。

公开包仅按源码、桌面和许可证白名单分发；不包含工作区证据、数据库、凭证或私有生产实现。安装包独立提供离线合成业务闭环，不能直接操作真实店铺。

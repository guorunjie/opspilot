# 候选安装包与发行流程

`.github/workflows/release.yml` 用于生成未签名的早期离线 Demo 候选包，不自动发布正式版本。

## 构建与草稿

- 手动运行工作流：构建 Windows x64 和 macOS 当前 runner 架构的安装包，仅保存 Actions artifacts，不创建 Release。
- 推送 `v*` 标签：标签必须等于 `v` 加 package.json 版本，manifest 与 lockfile 版本也必须一致。两个构建和产物核对均成功后，创建草稿预发行版。
- 构建工作只获得仓库读取权限。仅草稿创建步骤所在的独立 job 获得写权限；该 job 不检出或执行项目代码。
- 失败或缺少产物时不进入草稿创建。已有 Release 不覆盖、不追加、不自动修改。草稿创建本身失败时应检查 GitHub 实际状态，不盲目重试。

每个平台保存安装包、`SHA256SUMS-windows.txt` / `SHA256SUMS-macos.txt` 与对应 provenance JSON，Actions 保留七天。核对脚本检查同次构建的未封装目录内 app.asar：文件清单、源码字节、版本和 Apache-2.0 许可证，并记录安装包 SHA-256。脚本不会解开或执行安装包，不能证明安装包已通过安装验收，也不是签名或供应链证明。

“未签名候选”表示未配置可信发行者签名：Windows 包没有数字签名；macOS builder 可能使用 ad-hoc 签名，这不等于 Developer ID 签名或 Apple 公证。macOS 应用目录遵循 executableName，为 `OpsPilot-Core-Demo.app`，不是显示名称。

## 发布草稿前

1. 确认两平台产物、标签、提交和版本对应；检查校验值与许可证。
2. 分别在目标系统验收安装、入口、实际启动、诊断、预览、确认、执行、回读、重启、复位和卸载；保留证据。
3. 记录签名、公证、架构和未验证项目。当前未签名、未公证，不建议关闭系统安全措施。
4. 审核实际状态后，再显式发布草稿。工作流不自动执行此步骤，也不发布自动更新源。

发布前检查失败时，保留草稿及失败记录，不把“构建成功”写成“适配完成”。当前只有单商品合成价格闭环，不代表完整 Foundation、实际经营收益或真实平台验收。真实验证状态为 **WAITING_FOR_REAL_VALIDATION**。

Enterprise 的代码、配置、生产 Connector 和数据保持独立，不参与本工作流。本文描述流程；实际完成情况以工作流运行、产物和验收记录为准。

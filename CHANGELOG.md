# Changelog

## [0.3.0] - 2026-08-11

首个统一版本：Browser Bridge、Computer Use、身份隔离、桌面控制台全部指向同一版本。

### Added
- Windows Computer Use 运行时核心（#13）：.NET 8 UIA 驱动、`computer_*` MCP 工具、Codex 安装/doctor/status、RC 完整性打包
- 有界动作序列与白名单应用启动（#14）：`computer_execute_sequence`、`computer_list_apps`、`launch_app`/`process_started` 契约
- 真实桌面验收脚本：`scripts/desktop-acceptance.mjs`（notepad 启动 → UIA 语义 ref 输入 → postcondition 校验闭环）
- Computer Use 战略定位文档：`docs/computer-use-strategy.md`（与 Open Computer Use / lean-computer-use-mcp 的差异化与协同路径）

### Fixed
- 网络隔离验收缺陷（#15）：mDNS-only WebRTC 不再误判为泄漏；Observe 模式下 leak-check 不再绕过 enforcement 直接停止会话
- `native-app-launcher`：环境变量大小写兼容（`{ ...process.env }` 展开后 `ProgramFiles` 键丢失导致 Chrome 等内置应用不可用）
- `windows-uia-client`：优先使用自包含 publish 产物（framework-dependent 驱动在 MCP stdio 环境因 DOTNET_ROOT 被白名单剥离而无法解析运行时）

### Changed
- 全组件版本统一为 0.3.0（此前桌面 0.1.0 与 workspace 0.2.10 错位）
- CI：windows-2025 全量 release-check（含 Computer Use RC 打包与产物上传）

### 本机验收（2026-08-11）
- 真实 Chrome E2E：8 个 `browser_*` 真实调用通过（连接/列表/URL/文本/新建/切换）
- 真实桌面任务：`scripts/desktop-acceptance.mjs` 7/7 通过
- 网络隔离 Observe 验收：PASS（公网 IP 会话绑定、mDNS 接受、DNS-unverified 不停止、隔离清理）
- 桌面安装器闭环：安装 → 卸载 → 重装全验证（升级路径：安装器覆盖同版本/跨版本安装）

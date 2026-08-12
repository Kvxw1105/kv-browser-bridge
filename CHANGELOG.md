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

## [0.3.1] - 2026-08-11（桌面控制中心接线）

### Fixed
- 桌面身份控制台与 CLI 身份运行时统一（同一世界）：manifest 存储改到
  `%LOCALAPPDATA%\KvBrowserBridge\identity-console`、运行时根对齐 CLI 默认
  （`identities`），CLI/验收建的身份桌面直接可见、桌面启停状态 CLI 互通；
  旧 userData 目录 manifest 自动迁移；`KV_BROWSER_IDENTITY_HOME` 仍可覆盖
- 桌面 start 身份注入 CDP-pipe adapter（修复 CDP_PIPE_UNAVAILABLE）并在
  provision 前幂等注册匹配扩展 ID 的 Native Host（修复扩展握手前置条件）
- 桌面应用完整构建产物可运行（renderer index.html 输出完整）

### Added
- Computer Use / Bridge 只读状态面板：KvDashboard 侧栏新增"运行状态"
  （doctor 7 项检查、扩展就绪、bridge 管道、回执路径、运行时目录、
  一键"运行诊断"）；bridge.json 只读且脱敏（token 不进入 UI/日志）
- `scripts/identity-console-dir.mjs` + 4 个单测（目录解析与迁移）
  （`test/desktop-identity-dir.test.mjs`，已接入根测试脚本）

### 验证
- 全量回归：202 tests / 201 pass / 0 fail / 1 skip
- 数据层互操作实证：桌面 service 列出 CLI 身份 t4-obs-a（stopped 状态一致）
- 应用启动正常（electron 加载构建产物，renderer 无 JS 错误）

### 已知遗留（下一轮）
- 身份 Chrome 的扩展 native messaging 握手（BRIDGE_NOT_READY）：v0.3.0
  扩展在身份 profile 未发起连接（CLI 与桌面两条路径同受影响；用户 Chrome
  旧扩展 v0.2.12 可连）。排查轨迹：CDP pipe adapter ✓ → Native Host 注册 ✓
  → 扩展 loadUnpacked ✓ → 扩展未 connectNative（根因待查，疑似动态加载
  扩展的 native messaging 限制或 v0.3.0 扩展初始化问题）
- 面板视觉自动化验证受 UIA/vision 工具链限制（Chromium DOM 不暴露
  可访问性树），以构建产物 + 无 JS 错误作为交付证据

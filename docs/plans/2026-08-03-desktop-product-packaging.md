# Desktop Product Packaging 实现计划

**目标：** 交付 Windows 桌面端可分发安装包（electron-builder NSIS）与一键打包入口，让 KV Browser Bridge 桌面端（Identity Console）可以从安装包启动，而不是只能 `npm run dev:desktop`。

**架构：** 在 `apps/desktop` 增加 electron-builder 配置与 `pack`/`dist` 脚本，根 workspace 暴露 `pack:desktop`/`dist:desktop`；打包产物写入 `apps/desktop/release`（Git 忽略）。不修改 Extension 打包链路与 Native Host 安装器。

**技术栈：** Electron 33、electron-vite 3、electron-builder。

**任务粒度（每个任务都有失败→修复→验证闭环）：**

### 任务 1：添加打包依赖与配置

- 文件：
  - 创建：`apps/desktop/electron-builder.yml`
  - 修改：`apps/desktop/package.json`（devDependencies + scripts）
  - 修改：根 `package.json`（`pack:desktop` / `dist:desktop` / test 接线）
- 预期：`electron-builder.yml` 包含 `appId: io.kv.browser-bridge.desktop`、`productName: KV Browser Bridge`、`win.target: nsis`；desktop 出现 `pack`（`--dir`）与 `dist`（`--win nsis`）脚本。

### 任务 2：打包配置测试（TDD）

- 文件：
  - 创建：`test/desktop-packaging.test.mjs`
- 预期：`node --test test/desktop-packaging.test.mjs` 通过；断言 desktop 配置、脚本、根脚本与 yml 关键字段。

### 任务 3：本地构建与打包验证

- 命令：
  - `npm run typecheck -w apps/desktop`
  - `npm run build -w apps/desktop`
  - `npm run pack:desktop`（`electron-builder --dir`）
- 预期：typecheck/build 退出码 0；`apps/desktop/release/win-unpacked/KV Browser Bridge.exe` 存在且可解析。

### 任务 4：使用文档

- 文件：
  - 创建：`docs/release/desktop-quickstart-zh.md`
- 预期：包含「安装 Native Host → 加载扩展 → 安装包运行 → 创建身份」的 ≤10 步中文路径。

### 任务 5：提交与 PR

- 分支：`codex/product-packaging-v01`（基于 `feature/managed-multi-identity-session-alpha-v02`）
- 提交：`feat: package desktop app for windows distribution`
- 推送并创建 Draft PR（base：`feature/managed-multi-identity-session-alpha-v02`），不合并。

**明确不做：** 不修改堆叠 PR #2/#4/#5/#10 分支；不合并任何 PR；不处理 CI 签名/发布；不新增产品功能。

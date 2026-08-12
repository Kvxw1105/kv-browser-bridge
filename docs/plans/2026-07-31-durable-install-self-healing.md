# 持久安装与自愈连接实施计划

**目标：** 让 Kv Browser Bridge 在 Chrome/Windows 重启后仍能自动连接，并让 Native Messaging 注册不会因解压目录、测试安装或扩展 ID 变化而漂移。

**架构：** Chrome 扩展使用固定 manifest public key 生成稳定 ID；Native Host 由唯一的持久安装目录提供；安装器增加可验证的 repair/doctor 路径；扩展继续通过 `connectNative`、心跳和指数退避重连。修复只处理 Host 注册和进程生命周期，不读取或迁移 Cookie、Profile、Storage。

**技术栈：** Chrome MV3、Node/TypeScript、Windows HKCU Native Messaging、现有 Named Pipe 与 JSONL 日志。

---

## 任务 1：固定扩展身份

**文件：**

- 修改：`apps/extension/manifest.json`
- 修改：`apps/chrome-bridge/src/install-helpers.ts`
- 测试：`apps/chrome-bridge/test/install-helpers.test.mjs`

步骤：

1. 生成一次稳定的 Chrome manifest public key，只提交公开 key，不提交私钥。
2. 将 key 写入 manifest，使同一构建在不同解压路径下保持同一扩展 ID。
3. 安装器校验 manifest key 与允许的扩展 ID 格式。
4. 增加测试证明重复生成 manifest 不改变 key、origin 格式仍正确。

验证：

```powershell
npm run build -w apps/extension
node --test apps/chrome-bridge/test/install-helpers.test.mjs
```

## 任务 2：安装器 repair 与漂移诊断

**文件：**

- 修改：`apps/chrome-bridge/src/install-helpers.ts`
- 修改：`apps/chrome-bridge/src/install.ts`
- 测试：`apps/chrome-bridge/test/install-helpers.test.mjs`

步骤：

1. 增加 `repair <extension-id>` 命令，先创建时间戳备份，再原子写 wrapper、manifest 和 HKCU registry。
2. repair 仅接受 Kv 自有 manifest 或明确的缺失 wrapper 状态；遇到未知 Host 名称保持原文件不动。
3. doctor 增加 `extension-origin`、`wrapper-exists`、`registry-target`、`path-consistent` 检查。
4. test-install 与正式 install 使用不同的备份槽位，避免测试状态阻塞正式修复。

验证：

```powershell
npm run build -w packages/browser-protocol -w apps/chrome-bridge
node --test apps/chrome-bridge/test/install-helpers.test.mjs apps/chrome-bridge/test/installer-runtime.test.mjs
```

## 任务 3：启动状态与自愈日志

**文件：**

- 修改：`apps/extension/src/background/service-worker.ts`
- 修改：`apps/chrome-bridge/src/bridge.ts`
- 测试：`apps/chrome-bridge/test/bridge-reliability.test.mjs`

步骤：

1. 扩展启动、断线、重连分别记录原因、重试次数和 Host 错误分类。
2. Bridge 在 Native stdin 关闭后清理状态并保留可重连的 Named Pipe 服务。
3. 对 `ACCESS_FORBIDDEN`、Host missing、wrapper missing、Native stdin closed 给出不同 doctor/面板状态。
4. 不把 token、Cookie、Profile、URL、页面内容写入日志。

验证：

```powershell
npm run build:local-chrome
npm run test:local-chrome
```

## 任务 4：重启回归与交付

步骤：

1. 在独立测试安装中验证 Chrome 重启后扩展自动连接，且无需先启动 MCP Agent。
2. 验证 `browser_connection_status`、`browser_get_tabs` 和日志状态。
3. 验证 repair 前后不触碰 Cookie、Profile、LocalStorage、IndexedDB 或缓存。
4. 恢复稳定安装，保存结构化证据。
5. 更新 `docs/status/CURRENT_STATE.md` 与 `docs/status/HANDOFF.md`。

完成等级必须分别记录：`CODED`、`LOCALLY_TESTED`、`REAL_BROWSER_VERIFIED`、`COMMITTED`、`PUSHED`、`RELEASED`。

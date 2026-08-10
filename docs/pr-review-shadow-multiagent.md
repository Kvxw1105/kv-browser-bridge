# PR #1 / #8 重审：Runtime Shadow、Flow Recorder 与 Multi-Agent / KvGo

> 状态：书面策略（2026-08-11，T8）｜ 范围：价值重审与整合方向，不含代码改动
> 关联：`docs/computer-use-strategy.md`（T0，决策记录 D2）

---

## 1. 结论摘要

| PR | 能力 | 价值判断 | 建议 |
|---|---|---|---|
| #1 | Runtime Shadow / Flow Recorder / Run Package | Runtime Shadow：**保留**（审计链互补）；Flow Recorder：**弃自研**（与 lean Record & Replay 重叠）；Run Package：**保留**（导出/协作载体） | 拆分重建，弃 recorder 模块 |
| #8 | Multi-Agent Coordinator / KvGo / Go 工具链 | Coordinator 路由与租约：**保留**（多 Agent 协作基础）；KvGo popup：**与用户 Popup 工作合并推进**；Go 工具链：**瘦身** | 以 KvGo 最小闭环重建，构建修复先行 |

---

## 2. PR #1（Runtime Shadow / Flow Recorder / Run Package）

### 2.1 现状（来自分支审查）
- 21 commits / 31 文件 / +1357 −78；包含 `apps/chrome-bridge/src/runtime.ts`（运行记录）、`apps/extension/src/background/flow-recorder.ts`（流程录制）、`test/run-package-guide.test.mjs`（Run Package 导出）
- 与 main 冲突较大（chrome-bridge、MCP、Extension、协议、安装脚本、lock 全部触及）

### 2.2 价值分析
- **Runtime Shadow（影子运行记录）**：记录会话运行轨迹——与已合入的**回执审计链**（ReceiptStore、action/sequence receipts）天然互补，是"可复现 + 可审计"产品叙事的延伸。**保留价值**。
- **Flow Recorder（录制 → 导出 SKILL）**：与 lean-computer-use-mcp 的 **Record & Replay**（已实现并剪映实测、含原子组件记忆库）**高度重叠**。lean 的方案更成熟（intent 型 SKILL、组件复用、成本指标）。自研 recorder 是重复劳动。**弃自研**（T0 D2 定案）。
- **Run Package（流程导出包）**：作为"验收/复现载体"有价值，但依赖 recorder 的录制产物——若 recorder 弃用，Run Package 应改为消费**回执日志**（已存在）而非录制产物。

### 2.3 建议路径
1. 从 PR #1 提取 **runtime-shadow 最小核心**（运行记录 + 回执关联），以当前 main 为基线重建
2. **不移植** flow-recorder 模块；桌面/Chrome 侧录制需求由 lean Record & Replay 承接
3. Run Package 语义调整为"回执日志导出包"，复用现有 ReceiptStore 数据
4. 验收标准：run 记录可按 runtimeSessionId 回放、与 receipts 时间线对齐

---

## 3. PR #8（Multi-Agent Coordinator / KvGo）

### 3.1 现状
- 43 commits / 84 文件 / +7571 −176；含 `apps/go-agent`（config/core/decision/ledger）、`apps/go-api`、`apps/go-cli`、`apps/extension/src/background/go-agent.ts`、coordinator 路由与租约
- **构建修复已就绪**：`d8e2251`（Go Agent 先构建 + 版本一致），已验证（16/16 go-agent 测试、多 agent 协调测试 1/1、全量 test exit 0）
- 用户主仓库**未提交的 Popup 改动**（popup.html、src/popup/、service-worker.ts、vite.config.ts）与 PR #8 的 `740da49 "add KvGo agent and popup bridge status"` 属同一方向——**用户在继续 KvGo popup 工作**

### 3.2 价值分析
- **Multi-Agent Coordinator**（多客户端协调、租约、全局路由）：面向"多 Agent 协作操作同一浏览器"的产品能力，有真实价值，但**依赖面大**（协议、扩展、MCP 全链路）
- **KvGo**（浏览器内 Go Agent）：用户正在投入的方向（Popup 工作），**以用户工作为准**——不应在用户未定型前强行合入
- **Go 工具链**（go-agent/go-api/go-cli 三件套）：体量大，需瘦身评估

### 3.3 建议路径
1. **`d8e2251` 构建修复先行**：推送到 PR #8 分支（修复其 CI），低风险、独立可验证——**可立即执行**
2. **KvGo popup 协调**：等用户主仓库 Popup 工作提交定型后，以"KvGo 最小闭环"（popup ↔ go-agent ↔ MCP 单链路）为单位重建 PR #8，不做 84 文件的大合并
3. Coordinator 路由/租约：在 KvGo 闭环验证后，作为第二阶段独立评估
4. 明确不做：本期不把 PR #8 作为整体合入 main

---

## 4. 行动项（下一轮执行清单）

| # | 行动 | 依赖 | 优先级 |
|---|---|---|---|
| 1 | 推送 `d8e2251` 到 PR #8 分支修复 CI | 无 | 高 |
| 2 | 提取 runtime-shadow 最小核心（回执关联）重建 | T6 Release 后 | 中 |
| 3 | 用户 Popup 定型后重建 KvGo 最小闭环 | 用户工作 | 中 |
| 4 | Run Package 改为回执日志导出 | 行动 2 后 | 低 |
| 5 | electron/music-metadata 大版本升级治理（T7 遗留） | 桌面板块决策 | 低 |

## 5. 决策记录

| 日期 | 决策 | 状态 |
|---|---|---|
| 2026-08-11 | Flow Recorder 弃自研，由 lean Record & Replay 承接（与 T0 D2 一致） | 已定 |
| 2026-08-11 | PR #8 不整体合入；d8e2251 先行、KvGo 最小闭环后行 | 已定 |
| 2026-08-11 | Runtime Shadow 保留并重建为回执关联核心 | 已定（待执行） |

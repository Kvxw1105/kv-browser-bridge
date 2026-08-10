# Computer Use 战略定位与协同路径

> 状态：决策记录（2026-08-11，T0）
> 范围：kv-browser-bridge Computer Use 与 Open Computer Use（OCU）/ lean-computer-use-mcp 的差异化定位、重叠处置与融合决策框架。

---

## 1. 背景

项目在三条线上都出现了"计算机控制"能力：

1. **kv-browser-bridge Computer Use**（本仓库，main，ccfdb44）
   - Chrome 真实会话控制：Native Messaging + Named Pipe + bearer token，操作当前用户正在使用的 Chrome。
   - Windows UIA 受控边界：自研 .NET 8 自包含驱动（`apps/windows-uia-driver`），语义引用（`uia:` ref），风险分级、postcondition 验证、回执审计、白名单应用启动（禁 shell）、有界动作序列。
   - 多身份网络隔离：独立 Profile / 代理 / 语言 / 时区，MCP 路由。
   - 成熟度：核心代码已合入 main 并通过全量测试（193 tests / 192 pass / 1 skip，UIA E2E 5/5），但本机安装、真实 Chrome 验收、正式 Release 尚未闭环。

2. **Open Computer Use（iFurySt/open-codex-computer-use）**，上游第三方
   - Codex Computer Use 的开源替代，Swift 实现，MCP 包装，通过 Accessibility（无障碍）API 控制 macOS / Linux / Windows 桌面。
   - `npm i -g open-computer-use` + `ocu` CLI，`install-codex-mcp` 写入 `~/.codex/config.toml`。
   - 已知局限（lean-computer-use-mcp 实测数据，2026-08-05）：默认快照约 437,779 个模型可见字符（55,543 文本 + 382,236 图片 Base64）、460 节点；每次动作返回全量刷新状态。

3. **lean-computer-use-mcp（Kvxw1105/lean-computer-use-mcp）**，自有仓库
   - OCU 之上的"低上下文、状态安全"MCP 门面，面向廉价模型（如 GPT-5.6 Luna）。
   - 核心机制：紧凑查询相关输出（99.8% 上下文削减）、`state_id` 新鲜度与 stale 拒绝、delta 摘要、按需截图裁剪、每调用成本指标。
   - 扩展能力：Record & Replay（录制 → 编译 SKILL.md → 重放）、原子组件记忆库（compile/recall/refine）、中文 config-ui 面板 + 视觉端点多路 failover。
   - 成熟度：M1 已对真实 Windows 上游验证（含剪映字幕缩放动作），V2 vision fallback 已上线，自评 not for production。

---

## 2. 三方案定位对比

| 维度 | kv-browser-bridge CU | Open Computer Use | lean-computer-use-mcp |
|---|---|---|---|
| 核心问题 | 受控边界内操作**真实会话**，且可审计 | 通用桌面控制的开源替代 | 让廉价模型低成本、可靠地用桌面 |
| 驱动 | 自研 .NET 8 UIA 驱动（语义 ref + postcondition 闭环） | 通用 Accessibility + 截图（Swift） | OCU 上游 + 上下文裁剪代理 |
| 浏览器 | 当前用户真实 Chrome（DOM 级、Popup、扩展）——独有 | 仅窗口级 | 仅窗口级 |
| 身份/网络隔离 | 多身份独立 Profile/代理/语言/时区——独有 | 无 | 无 |
| 策略护栏 | 风险分级 + 白名单 + 禁 shell + 回执审计 + 有界序列（内建于协议） | 无内建审计链 | 有界动作 / fail-fast batch（无审计链、无风险契约） |
| 记忆/录制 | Flow Recorder 雏形（PR #1，未收敛） | 无 | Record & Replay + 原子组件记忆库（已实现） |
| 视觉兜底 | 无 | 截图可作视觉输入 | V2 vision fallback + 端点 failover |
| 上下文成本 | 紧凑 JSON 协议（无截图） | 高（全量树 + 截图） | 极低（99.8% 削减实测） |
| 平台 | Windows（Chrome + UIA） | macOS / Linux / Windows | 随上游（当前实测 Windows） |
| 集成 | Codex 专用（install/doctor/status/RC 打包） | 通用 MCP（Codex/Gemini/Claude 等） | 通用 MCP + Codex skill |

---

## 3. 独有能力与重叠

### 3.1 kv-browser-bridge 独有（其它两者没有）
- 当前用户真实 Chrome 的 DOM 级控制（Native Messaging 管道、扩展、Popup 状态、`browser_*` 全工具集）。
- 可审计执行链：风险分级 → 白名单 → postcondition 验证 → 回执持久化（`receipt-store`，含序列回执）。
- 多身份与网络隔离（独立 Profile/代理/语言/时区 + MCP 路由 + fail-closed 身份绑定）。
- 完整发布管线：doctor / install / uninstall / RC 完整性打包 / CI 全量 release-check。

### 3.2 lean-computer-use-mcp 独有（其它两者没有）
- 上下文成本工程：99.8% 削减、state_id 新鲜度、delta 摘要、按需裁剪。
- Record & Replay：演示一次工作流，编译成 intent 型 SKILL.md，廉价重放。
- 原子组件记忆库：跨任务复用（`jianying::click::button::font-size` 式组件），成功提升流行度、失败提升陈旧度。
- 视觉端点管理：config-ui 中文面板、多路 failover、密钥本机存储。
- 每调用成本/错误指标（cu_metrics）。

### 3.3 重叠与冲突
- **Flow Recorder（PR #1）vs Record & Replay（lean）**：定位高度重叠——都是"录制工作流 → 导出 → 重放"。本项目 Flow Recorder 仅雏形且未收敛；lean 已实现并实测。**倾向：放弃自研 recorder，复用 lean 的录制/重放，本项目只保留"回执审计"作为差异点。** 需要重审 PR #1 时定案（见 T8）。
- **Windows UIA 驱动 vs OCU UIA 驱动**：功能重叠但实现独立。本项目驱动带 postcondition 闭环与回执，OCU 驱动通用。**不合并底层，保留双驱动；通过 MCP 契约层隔离。**
- **有界动作序列 vs lean batch**：理念一致（有界、fail-fast）。本项目序列是协议级（风险分级/禁止嵌套/审计），lean batch 是代理级。**保留各自实现，不做合并。**

---

## 4. 协同路径（决策框架）

### 4.1 短期（本轮目标 T1–T6）：本项目先闭环，不与 OCU 混合
- 原因：本项目价值在"受控 + 审计 + 真实会话"，必须先把安装、真实验收、Release 闭环，否则任何融合都建立在未验证的地基上。
- 决策：T1–T6 期间不引入 OCU/lean 依赖。

### 4.2 中期：视觉兜底的引入评估（决策点 D1）
- 本项目无视觉驱动，UIA 无法覆盖自绘控件（如剪映）。lean 已有 V2 vision fallback + 端点 failover 基建。
- **评估方向**：在本项目 `computer-observe` 之外新增可选 vision 观察通道（复用 lean 的视觉端点配置与成本指标），保持现有语义路径为默认。
- **触发条件**：T3 真实桌面验收暴露 UIA 盲区（自绘/游戏/非标准控件）且用户工作流依赖这些应用时，优先评估该方向。
- 备选：完全以 lean 作为 vision 通道，本项目只做策略与审计外壳（架构风险低，但引入跨仓库依赖）。

### 4.3 中期：录制能力（决策点 D2）
- 随 T8 重审 PR #1 时定案。默认倾向：弃自研、接 lean Record & Replay；若 lean 不满足 Chrome DOM 级录制，则本项目只保留 Chrome 侧录制，桌面侧交给 lean。

### 4.4 长期：统一身份/审计层（决策点 D3）
- 若 lean/OCU 进入用户主力工作流，把本项目"身份隔离 + 回执审计 + 白名单"下沉为跨方案服务（桥接层），使任意 Computer Use 前端都能获得审计与隔离。

---

## 5. 证据索引

| 断言 | 证据 |
|---|---|
| 本项目核心验证 | main=ccfdb44；193 tests / 192 pass / 1 skip；UIA E2E 5/5；RC 完整性 236 files |
| OCU 定位 | iFurySt/open-codex-computer-use README（Swift、Accessibility、三平台 MCP） |
| OCU 上下文成本 | lean-computer-use-mcp docs/BENCHMARKS.md（437,779 字符 / 99.8% 削减 / E12） |
| lean 能力与成熟度 | Kvxw1105/lean-computer-use-mcp README（M1 剪映验证、V2 vision、config-ui、not for production） |

## 6. 决策记录

| 日期 | 决策 | 状态 |
|---|---|---|
| 2026-08-11 | T1–T6 期间不与 OCU/lean 混合，本项目先闭环 | 已定 |
| 2026-08-11 | 底层 UIA 驱动不合并，保留双驱动 + 契约层隔离 | 已定 |
| 2026-08-11 | D1 vision 兜底 / D2 录制处置 / D3 统一审计层 | 待触发（分别随 T3 验收、T8 重审、lean 引入决策） |

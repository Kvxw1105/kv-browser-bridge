---
name: kv-go-agent
description: Drive unattended ChatGPT/DeepSeek web progress with KvGo. Use when an agent needs to push a web-chat task forward to a checkpoint, schedule unattended advancement, or hand off progress between a human and an agent. Prefer go_* MCP tools, the kvg CLI, or the KvGo HTTP API.
---

# KvGo

GO Agent 在 ChatGPT / DeepSeek 网页上自动推进长任务：注入工作协议（每轮末尾输出 `【进度摘要】`）、检测回复结束、按节点判定（关键词 / `【任务完成】` / 轮数）、拟人化节奏发送推进指令、风控自检。人的 GUI 面板与 Agent 共用同一状态机与账本。

## 什么时候用

- 用户留了长任务在网页对话里，需要无人值守推进到检查点。
- Agent 编排定时任务：恢复会话 → 推进 → 读账本 → 验收。
- 人/Agent 交替接管同一会话。

## 驱动方式

优先 MCP 工具（`go_resolve_conversation` / `go_start` / `go_status` / `go_stop` / `go_continue` / `go_configure_decision`），或 `kvg` CLI。详细契约见 `apps/go-agent/AGENT-INTEGRATION.md`。

## 编排步骤

1. **解析会话**：`go_resolve_conversation { tabId }` → `conversationKey`（`gpt-*` / `ds-*`），不要依赖 tabId 长期有效。
2. **读状态**：`go_status` 检查是否已在运行、上次轮次与摘要，决定接管还是新开。
3. **配置决策**（可选）：`go_configure_decision`，预设厂商（openai/deepseek/moonshot/qwen/zhipu/siliconflow/ollama/custom）只需 API key；本地 Ollama 免 key。
4. **启动**：`go_start { goal, keyword?, maxRounds?, injectProtocol? }`。工作协议默认注入；关键词命中或 `【任务完成】` 即停。
5. **观察**：轮询 `go_status`（phase: generating/waiting/cooldown/stopped；`nextActionAt` 是下次动作时间戳；`lastSummary` 是最近进度摘要）。不要频繁催发。
6. **检查点**：`running=false` 且 reason 含"节点"→ 读页面/账本验收；含"风控"→ 立即停止并告知用户，不要重试。
7. **续跑**：验收后 `go_continue`（保留轮次）或 `go_stop` 结束。

## 规则

- 不绕过节点验收：默认检查点必须有人（或 Agent 明示接管）确认。
- 不硬闯风控：出现验证码/风控提示立即停。
- 不重复启动同一会话：先 `go_status`。
- 决策引擎只连用户配置的安全通道；密钥在本地配置文件中，不要写进对话或代码。
- 推进语池与节奏可按任务调整（`go_start` 传 `nudgePool`，或面板编辑）。

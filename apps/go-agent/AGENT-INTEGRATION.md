# KvGo · Agent 集成契约

GO Agent 面向两种使用者：人类（GUI）和 Agent（MCP / CLI / API / Skill）。两者读写**同一份持久会话账本**，互不干扰、可交接。

## 接口矩阵

| 接口 | 形态 | 状态 |
| --- | --- | --- |
| GUI | KV Bridge 扩展面板（v0.3.x） | ✅ |
| MCP | `go_resolve_conversation` / `go_start` / `go_stop` / `go_status` / `go_continue` / `go_configure_decision` / `go_wait`（阻塞等待检查点/状态变化） | ✅ |
| CLI | `kvg <command>`（apps/go-cli） | ✅ |
| Skill | `skills/kv-go-agent/SKILL.md` | ✅ |
| API（HTTP） | `apps/go-api`：`/health /status/:tabId /ledger/:key /resolve /start /stop /continue /configure /wait` | ✅ |
| 事件推送 | 扩展→桥→MCP 事件缓冲：`go_events`（排空）+ `go_wait`（阻塞等待）；SDK 不支持服务端自定义推送，采用排空工具语义 | ✅ |

## 会话句柄（Agent 不要记 tabId）

tabId 每次浏览器会话都会变。Agent 应使用**会话键**：

- ChatGPT 对话：`gpt-<conversationId>`（URL `/c/<id>`）
- DeepSeek 对话：`ds-<sessionId>`（URL `/a/chat/s/<id>`）

用 `go_resolve_conversation { tabId }` 获取当前标签页的 `conversationKey` 与 `ledgerPath`。

## 会话账本（Ledger）

- 目录：`%LOCALAPPDATA%\KvBrowserBridge\go-runs\{conversationKey}\`
  - `engine/state.json`：引擎持久化状态
  - `{conversationKey}.jsonl`：事件流（started / status / stop / continue，含状态快照）
- 环境变量 `GO_RUNS_DIR` 可覆盖根目录。
- `go_status` 返回 `lastLedgerEvents`（最近 6 条），`kvg ledger --key <key>` 读取最近 20 条。

## Agent 编排顺序（推荐）

```text
1. go_resolve_conversation  -> 拿到 conversationKey + ledgerPath
2. go_status                -> 读取上次状态（恢复或接管）
3. go_configure_decision    -> 配置决策引擎（可选；预设厂商只填 key）
4. go_start                 -> goal + keyword + maxRounds + decision
5. 轮询/订阅 go_status      -> 观察 phase / nextActionAt / lastSummary
6. 检查点到达（running=false 或节点事件）
7. 读 ledger/页面回复 -> 验收
8. go_continue 或 go_stop
```

## CLI 示例

```bash
kvg resolve --tab 123
kvg start --tab 123 --goal "写一个 300 行 Python CLI" --max-rounds 12 --preset deepseek --api-key sk-...
kvg status --tab 123
kvg ledger --key ds-b430b35c-96a5-495c-8a1c-f45622076f4d
kvg continue --tab 123
kvg stop --tab 123
```

## 安全边界

- 决策引擎只连接用户显式配置的地址（预设厂商或自定义 baseUrl），禁止反爬代理。
- 节点检查点默认交给 owner 验收；风控/验证码出现自动停止。
- 所有密钥存于本地配置（`%LOCALAPPDATA%\KvBrowserBridge\go-agent-decision.json`），不进仓库。

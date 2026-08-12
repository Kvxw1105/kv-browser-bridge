# @kv-browser-bridge/go-agent（KvGo）

GO Agent：把 ChatGPT / DeepSeek 网页对话"推进到用户定义的节点"。

## 职责

- 检测网页模型回复结束（停止按钮消失 + 最新消息长度稳定）。
- 判断是否到达节点（关键词 / 最大轮数 / `【任务完成】`标记）。
- 未到节点时，按拟人化节奏（随机间隔、逐字输入、冷却、消息轮换）发送推进指令。
- 启动时向会话注入一次性"工作协议"，要求模型每轮末尾输出 `【进度摘要】`（已完成/未完成/下一步），并提取保存。
- 风控自检：发现验证码/风控提示立即停止。
- 决策引擎可插拔：规则 →（未来）LLM 决策器。

## 状态

单一引擎架构（v0.2 收敛）：**引擎只运行在 MCP server 进程**（`apps/codex-mcp-server/src/go.ts`），
通过桥的 `browser_get_url/browser_evaluate/browser_type/browser_click` 操作页面。扩展端
不再包含任何引擎代码（原先的 `go-agent.ts` 双实现已删除——MV3 扩展 SW 空闲 30s 即终止，
无人值守推进无法依赖它）。控制与状态展示统一走 `go_*` MCP 工具与 Ledger。

| 能力 | 状态 |
| --- | --- |
| 核心循环（内容变化检测驱动） | ✅ 引擎在 MCP server 进程（常驻） |
| 工作协议 + 摘要提取 | ✅ |
| 风控自检 | ✅ |
| 决策引擎接口 + 模板回退 | ✅ |
| LLM 决策引擎（主流厂商预置 + 自定义入口 + 工具调用） | ✅（需用户填 API key；`GO_AGENT_DECISION_CONFIG` 可指定配置文件） |
| 桥驱动输入 | ✅ BridgePageAdapter：typeText（browser_type）+ send（browser_click 发送按钮，allowChatSend 显式许可；Enter 仅作回退） |
| 平台选择器适配层 | ✅ `defaultPlatformSelectors()` 集中管理，可按平台覆盖 |
| 断连自停 | ✅ 连续读取失败达 `bridgeFailureStopCount` 自动停止 |
| MCP 工具（go_start/go_stop/go_status/go_continue/go_configure_decision/go_resolve_conversation/go_wait/go_events） | ✅ 已注册 |
| 面板 UI | 已移除（v0.2）：原 content-script GO 圆点与侧栏 KvGoPanel 依赖扩展端引擎，随双实现删除。控制统一走 CLI（`kvg`）或 Agent 经 MCP 工具 |

## MCP 工具

- `go_start`：启动推进（goal / keyword / maxRounds / nudgePool / injectProtocol / decision 配置）。
- `go_stop`：停止并等待用户验收。
- `go_status`：读取状态（轮次、进度摘要、运行中、决策引擎配置）。
- `go_continue`：从节点继续（保留轮次与摘要，不重复注入协议）。
- `go_configure_decision`：配置 LLM 决策引擎。

决策引擎配置示例（用户只需填 API key，base URL 已预置）：

```json
{ "tabId": 123, "preset": "deepseek", "apiKey": "sk-...", "model": "deepseek-chat" }
```

自定义通道：`{ "tabId": 123, "baseUrl": "https://your-endpoint/v1", "apiKey": "...", "model": "..." }`；
本地 Ollama 可留空 apiKey：`{ "preset": "ollama" }`。

LLM 决策模型可调用 `go_status` / `go_stop` / `go_continue` 工具；任何失败/未配置自动回退模板推进池。

当前状态存储为进程内 MemoryStorage（MCP server 重启后需重新 go_start）。

## 使用

```bash
npm run build -w apps/go-agent
npm run test -w apps/go-agent
```

示例（核心循环，无 DOM 依赖的宿主可注入自己的 PageAdapter）：

```ts
import { GoEngine, createAdapter, detectPlatform, MemoryStorage } from '@kv-browser-bridge/go-agent';

const engine = new GoEngine(
  createAdapter(detectPlatform(location.hostname)),
  { status: console.log, notify: console.log },
  new MemoryStorage(),
);
await engine.start({ keyword: '验收点', maxRounds: 10 });
```

## 安全边界

- 不调用任何外部 API；LLM 决策器只允许用户显式配置的安全通道（本地 Ollama / 官方 API），**禁止接入 ds-free-api 等反爬代理**。
- 页面内合成事件 `isTrusted=false` 为已知限制；正式集成时输入层切换为 browser-protocol 的 CDP 真事件。

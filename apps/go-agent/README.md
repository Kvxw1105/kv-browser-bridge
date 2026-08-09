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

| 能力 | 状态 |
| --- | --- |
| 核心循环（页面驱动，合成事件） | ✅ 已从独立扩展 v0.1.1 移植 |
| 工作协议 + 摘要提取 | ✅ |
| 风控自检 | ✅ |
| 决策引擎接口 + 模板回退 | ✅ |
| LLM 决策引擎（主流厂商预置 + 自定义入口 + 工具调用） | ✅（需用户填 API key） |
| CDP 真事件输入 | ✅ 经 BridgePageAdapter（apps/codex-mcp-server/src/go.ts）走桥的 CDP Input 实现 |
| MCP 工具（go_start/go_stop/go_status/go_continue/go_configure_decision） | ✅ 已注册 |
| 面板 UI（content script 内） | ✅ 已融入 apps/extension：chatgpt/deepseek 页面右下角 GO 圆点 |
| CDP 输入（扩展内） | ✅ apps/extension 后台 go-agent.ts：DOM.focus + Input.insertText + Input.dispatchKeyEvent（isTrusted=true） |

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

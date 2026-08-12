import type { GoConfig, GoState } from './types.js';

export type DecisionAction = 'continue' | 'stop' | 'retry';

export interface DecisionInput {
  goal: string;
  summary: string;
  previousQuestion: string;
  round: number;
}

export interface DecisionResult {
  action: DecisionAction;
  hint?: string;
}

export interface DecisionEngine {
  readonly name: string;
  decide(input: DecisionInput, ctx: { config: GoConfig; state: GoState }): Promise<DecisionResult | null>;
}

/**
 * 规则引擎：返回 null 表示"规则拿不准，交给模板池/上层决定"。
 * v0.1 阶段 GO 的主决策就是它 + 模板推进池。
 */
export class TemplateDecisionEngine implements DecisionEngine {
  readonly name = 'template';

  async decide(): Promise<DecisionResult | null> {
    return null;
  }
}

export interface DecisionProviderPreset {
  baseUrl: string;
  defaultModel: string;
  apiKeyRequired: boolean;
}

/**
 * 主流 OpenAI 兼容厂商预置：用户只需填 API key（Ollama 可留空）。
 * 自定义入口始终保留：preset='custom' 或直接传 baseUrl。
 * 安全边界：只连接用户显式配置的地址，绝不内置反爬代理（如 ds-free-api）。
 */
export const DECISION_PROVIDER_PRESETS: Record<string, DecisionProviderPreset> = {
  openai: { baseUrl: 'https://api.openai.com/v1', defaultModel: 'gpt-4o-mini', apiKeyRequired: true },
  deepseek: { baseUrl: 'https://api.deepseek.com/v1', defaultModel: 'deepseek-chat', apiKeyRequired: true },
  moonshot: { baseUrl: 'https://api.moonshot.cn/v1', defaultModel: 'moonshot-v1-8k', apiKeyRequired: true },
  qwen: { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', defaultModel: 'qwen-plus', apiKeyRequired: true },
  zhipu: { baseUrl: 'https://open.bigmodel.cn/api/paas/v4', defaultModel: 'glm-4-flash', apiKeyRequired: true },
  siliconflow: { baseUrl: 'https://api.siliconflow.cn/v1', defaultModel: 'Qwen/Qwen2.5-7B-Instruct', apiKeyRequired: true },
  ollama: { baseUrl: 'http://localhost:11434/v1', defaultModel: 'qwen2.5:7b', apiKeyRequired: false },
  custom: { baseUrl: '', defaultModel: '', apiKeyRequired: false },
};

export interface LlmDecisionEngineOptions {
  preset?: string;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
}

export interface NormalizedLlmOptions {
  preset: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  timeoutMs: number;
}

export function normalizeLlmOptions(options: LlmDecisionEngineOptions): NormalizedLlmOptions | null {
  const preset = DECISION_PROVIDER_PRESETS[options.preset ?? 'custom'] ?? DECISION_PROVIDER_PRESETS.custom;
  const baseUrl = (options.baseUrl ?? preset.baseUrl).replace(/\/+$/, '');
  if (!baseUrl) return null;
  const model = options.model ?? preset.defaultModel;
  if (!model) return null;
  const apiKey = options.apiKey ?? '';
  if (preset.apiKeyRequired && !apiKey) return null;
  return { preset: options.preset ?? 'custom', baseUrl, model, apiKey, timeoutMs: options.timeoutMs ?? 20000 };
}

export type DecisionToolExecutor = (name: string, args: Record<string, unknown>) => Promise<unknown>;

const DECISION_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'go_status',
      description: '查询当前 GO 推进状态（轮次、进度摘要、是否运行）。',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'go_stop',
      description: '停止推进，等待用户验收。',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'go_continue',
      description: '继续推进（保留轮次与摘要）。',
      parameters: { type: 'object', properties: {} },
    },
  },
];

/**
 * LLM 决策引擎（OpenAI 兼容 chat/completions，支持工具调用）。
 *
 * - 预置厂商 base URL，用户只填 API key；custom 保留自定义入口。
 * - 决策模型可调用 go_status / go_stop / go_continue 等工具。
 * - 任何失败/超时/未配置一律返回 null，由调用方回退模板池。
 */
export class LlmDecisionEngine implements DecisionEngine {
  readonly name = 'llm';
  private readonly opts: NormalizedLlmOptions | null;

  constructor(
    private readonly options: LlmDecisionEngineOptions,
    private readonly toolsExecutor?: DecisionToolExecutor,
  ) {
    this.opts = normalizeLlmOptions(options);
  }

  get configured(): boolean {
    return this.opts !== null;
  }

  get configSummary(): { preset: string; baseUrl: string; model: string; apiKeySet: boolean } | null {
    return this.opts
      ? { preset: this.opts.preset, baseUrl: this.opts.baseUrl, model: this.opts.model, apiKeySet: !!this.opts.apiKey }
      : null;
  }

  async decide(input: DecisionInput, _ctx: { config: GoConfig; state: GoState }): Promise<DecisionResult | null> {
    if (!this.opts) return null;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs);
      try {
        const messages: Array<Record<string, unknown>> = [
          {
            role: 'system',
            content:
              '你是 GO Agent 的决策引擎。目标是把网页模型的工作推进到用户定义的节点。可以调用工具查询/控制状态。最终只输出一行 JSON：{"action":"continue|stop|retry","hint":"给网页模型的下一句推进指令（可选）"}。不要输出其他内容。',
          },
          {
            role: 'user',
            content:
              `用户目标：${input.goal || '（未填写）'}\n` +
              `当前轮次：${input.round}\n` +
              `上一问：${input.previousQuestion || '（无）'}\n` +
              `本轮进度摘要：${input.summary || '（模型尚未输出摘要）'}\n\n请决策下一步。`,
          },
        ];

        let toolRound = 0;
        while (toolRound < 4) {
          const response = await fetch(`${this.opts.baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(this.opts.apiKey ? { Authorization: `Bearer ${this.opts.apiKey}` } : {}),
            },
            body: JSON.stringify({
              model: this.opts.model,
              messages,
              tools: DECISION_TOOLS,
              tool_choice: 'auto',
              temperature: 0.2,
            }),
            signal: controller.signal,
          });
          if (!response.ok) return null;
          const data = (await response.json()) as {
            choices?: Array<{
              message?: {
                content?: string | null;
                tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
              };
            }>;
          };
          const message = data.choices?.[0]?.message;
          if (!message) return null;

          if (message.tool_calls && message.tool_calls.length > 0 && this.toolsExecutor) {
            messages.push({
              role: 'assistant',
              content: message.content ?? null,
              tool_calls: message.tool_calls,
            });
            for (const call of message.tool_calls) {
              const name = call.function?.name ?? '';
              let args: Record<string, unknown> = {};
              try {
                args = JSON.parse(call.function?.arguments ?? '{}') as Record<string, unknown>;
              } catch {
                /* ignore */
              }
              let result: unknown;
              try {
                result = await this.toolsExecutor(name, args);
              } catch (error) {
                result = { error: error instanceof Error ? error.message : String(error) };
              }
              messages.push({ role: 'tool', tool_call_id: call.id ?? '', content: JSON.stringify(result) });
            }
            toolRound++;
            continue;
          }

          const content = (message.content ?? '').trim();
          if (!content) return null;
          const jsonStart = content.indexOf('{');
          const jsonEnd = content.lastIndexOf('}');
          if (jsonStart < 0 || jsonEnd <= jsonStart) return null;
          const parsed = JSON.parse(content.slice(jsonStart, jsonEnd + 1)) as Partial<DecisionResult>;
          if (!parsed.action || !['continue', 'stop', 'retry'].includes(parsed.action)) return null;
          return { action: parsed.action as DecisionAction, hint: typeof parsed.hint === 'string' ? parsed.hint : undefined };
        }
        return null;
      } finally {
        clearTimeout(timer);
      }
    } catch {
      return null;
    }
  }
}

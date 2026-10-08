import type { LlmPort, LlmRequest, LlmResponse } from './llm';

/**
 * Google Gemini and OpenAI, through the OpenAI-style "chat completions" request both accept
 * (Gemini at its OpenAI-compatible address). Chosen with OPENNJOB_LLM_PROVIDER (owner's request,
 * 8 October 2026: Claude costs too much). The request and answer shapes are as remembered from
 * the providers' documentation and have NOT been checked against the live services here;
 * deploy/check-ai.sh makes one real call on the server.
 *
 * Errors carry the provider's status code only, never the prompt or the answer (rule 6).
 */

export type OpenAiCompatibleProvider = 'gemini' | 'openai';

export const PROVIDER_BASE_URL: Record<OpenAiCompatibleProvider, string> = {
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai',
  openai: 'https://api.openai.com/v1',
};

/** Models used when OPENNJOB_LLM_MODEL is not set: each provider's low-cost general model, as remembered. */
export const PROVIDER_DEFAULT_MODEL: Record<OpenAiCompatibleProvider, string> = {
  gemini: 'gemini-2.5-flash',
  openai: 'gpt-4.1-mini',
};

/** Room on top of the answer for models that reason before answering (that reasoning counts as output). */
export const REASONING_HEADROOM_TOKENS = 4_000;

export type ChatFetch = (url: string, init: { method: 'POST'; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface OpenAiCompatibleLlmOptions {
  provider: OpenAiCompatibleProvider;
  apiKey: string;
  model?: string;
  fetch?: ChatFetch;
}

export class OpenAiCompatibleLlm implements LlmPort {
  readonly provider: OpenAiCompatibleProvider;
  readonly model: string;
  private readonly apiKey: string;
  private readonly fetchFn: ChatFetch;

  constructor(options: OpenAiCompatibleLlmOptions) {
    this.provider = options.provider;
    this.apiKey = options.apiKey.trim();
    this.model = options.model?.trim() || PROVIDER_DEFAULT_MODEL[options.provider];
    this.fetchFn = options.fetch ?? ((url, init) => fetch(url, init) as unknown as ReturnType<ChatFetch>);
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    if (!this.apiKey) throw new Error(`${this.provider} API key is not set`);
    const limit = request.maxTokens + REASONING_HEADROOM_TOKENS;
    const body = {
      model: this.model,
      messages: [
        { role: 'system', content: request.system },
        { role: 'user', content: request.prompt },
      ],
      // OpenAI's newer models take max_completion_tokens; Gemini's OpenAI-compatible address takes max_tokens.
      ...(this.provider === 'openai' ? { max_completion_tokens: limit } : { max_tokens: limit }),
    };
    let res;
    try {
      res = await this.fetchFn(`${PROVIDER_BASE_URL[this.provider]}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch {
      throw new Error(`${this.provider}: the request failed`);
    }
    if (!res.ok) throw Object.assign(new Error(`${this.provider}: HTTP ${res.status}`), { status: res.status });
    const reply = (await res.json()) as { choices?: { message?: { content?: unknown; refusal?: unknown }; finish_reason?: string }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
    const choice = reply.choices?.[0];
    const text = typeof choice?.message?.content === 'string' ? choice.message.content : '';
    if (!text.trim()) throw new Error(`${this.provider}: the model gave no answer${choice?.finish_reason ? ` (${choice.finish_reason})` : ''}`);
    return { text, inputTokens: reply.usage?.prompt_tokens ?? 0, outputTokens: reply.usage?.completion_tokens ?? 0 };
  }
}

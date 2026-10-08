import type { LlmPort, LlmRequest, LlmResponse } from './llm';

/**
 * Google Gemini: OpennJob's only AI (owner's decision, 8 October 2026: Claude removed as too
 * expensive). Called through Gemini's OpenAI-compatible "chat completions" address. The request and
 * answer shapes are as remembered from Google's documentation and are NOT checked against the live
 * service by the tests; deploy/check-ai.sh makes one real call on the server.
 *
 * Errors carry the status code only, never the prompt or the answer (rule 6).
 */

export const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai';

/** The model used when OPENNJOB_LLM_MODEL is not set: Gemini's low-cost general model, as remembered. */
export const GEMINI_DEFAULT_MODEL = 'gemini-2.5-flash';

/** Room on top of the answer for the model's thinking, which counts as output. */
export const REASONING_HEADROOM_TOKENS = 4_000;

export type ChatFetch = (url: string, init: { method: 'POST'; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface GeminiLlmOptions {
  apiKey: string;
  model?: string;
  fetch?: ChatFetch;
}

export class GeminiLlm implements LlmPort {
  readonly model: string;
  private readonly apiKey: string;
  private readonly fetchFn: ChatFetch;

  constructor(options: GeminiLlmOptions) {
    this.apiKey = options.apiKey.trim();
    this.model = options.model?.trim() || GEMINI_DEFAULT_MODEL;
    this.fetchFn = options.fetch ?? ((url, init) => fetch(url, init) as unknown as ReturnType<ChatFetch>);
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    if (!this.apiKey) throw new Error('GEMINI_API_KEY is not set');
    const body = {
      model: this.model,
      messages: [
        { role: 'system', content: request.system },
        { role: 'user', content: request.prompt },
      ],
      max_tokens: request.maxTokens + REASONING_HEADROOM_TOKENS,
    };
    let res;
    try {
      res = await this.fetchFn(`${GEMINI_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch {
      throw new Error('gemini: the request failed');
    }
    if (!res.ok) throw Object.assign(new Error(`gemini: HTTP ${res.status}`), { status: res.status });
    const reply = (await res.json()) as { choices?: { message?: { content?: unknown }; finish_reason?: string }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
    const choice = reply.choices?.[0];
    const text = typeof choice?.message?.content === 'string' ? choice.message.content : '';
    if (!text.trim()) throw new Error(`gemini: the model gave no answer${choice?.finish_reason ? ` (${choice.finish_reason})` : ''}`);
    return { text, inputTokens: reply.usage?.prompt_tokens ?? 0, outputTokens: reply.usage?.completion_tokens ?? 0 };
  }
}

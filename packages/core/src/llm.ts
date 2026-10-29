import Anthropic from '@anthropic-ai/sdk';

export interface LlmRequest {
  system: string;
  prompt: string;
  maxTokens: number;
}

export interface LlmResponse {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

/** The only door through which OpennJob talks to a language model. */
export interface LlmPort {
  complete(request: LlmRequest): Promise<LlmResponse>;
}

/**
 * The model used when OPENNJOB_MODEL is not set: Claude Opus 5.5, the current default Claude
 * model (checked against Anthropic's model list on 6 October 2026). Set OPENNJOB_MODEL to choose
 * another one.
 */
export const DEFAULT_MODEL = 'claude-opus-5-5';

export type LlmEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
const EFFORTS: readonly LlmEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/**
 * Models that accept the server-side refusal fallback (`fallbacks: "default"`). A request one of
 * them declines is re-run on another model inside the same call instead of failing.
 */
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-opus-5', 'claude-fable-5-1', 'claude-sonnet-5-5']);
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

/**
 * Current models always think before they answer, and the thinking counts towards max_tokens.
 * OpennJob's prompts ask for short answers (600-1,200 tokens), so the request leaves this much room
 * on top for the thinking. Only the tokens actually used are billed and metered.
 */
export const THINKING_HEADROOM_TOKENS = 15_000;

/** The request body we send. The slice of the SDK we use, so tests can substitute a stub. */
export interface AnthropicRequestBody {
  model: string;
  max_tokens: number;
  system: string;
  messages: { role: 'user'; content: string }[];
  output_config: { effort: LlmEffort };
  betas?: string[];
  fallbacks?: 'default';
}

export interface AnthropicMessagesClient {
  beta: {
    messages: {
      create(body: AnthropicRequestBody): Promise<{
        content: ReadonlyArray<{ type: string; text?: string }>;
        stop_reason?: string | null;
        usage: { input_tokens: number; output_tokens: number };
      }>;
    };
  };
}

export interface AnthropicLlmOptions {
  apiKey?: string;
  model?: string;
  /** How hard the model works on each answer. Default: OPENNJOB_LLM_EFFORT, else "medium". */
  effort?: LlmEffort;
  client?: AnthropicMessagesClient;
  warn?: (message: string) => void;
}

/** Thrown when the model declines a request. Callers fall back to the no-AI path. Holds no content. */
export class LlmRefusalError extends Error {
  constructor() {
    super('The AI model declined this request');
    this.name = 'LlmRefusalError';
  }
}

/**
 * LlmPort backed by the official @anthropic-ai/sdk.
 * Reads ANTHROPIC_API_KEY, OPENNJOB_MODEL and OPENNJOB_LLM_EFFORT from the environment unless passed in.
 * Its request and response mapping is unit-tested with a stub client; no live call is made by the tests.
 */
export class AnthropicLlm implements LlmPort {
  readonly model: string;
  readonly effort: LlmEffort;
  private readonly client: AnthropicMessagesClient;

  constructor(options: AnthropicLlmOptions = {}) {
    const envModel = process.env.OPENNJOB_MODEL?.trim();
    this.model = options.model?.trim() || envModel || DEFAULT_MODEL;
    const envEffort = process.env.OPENNJOB_LLM_EFFORT?.trim() as LlmEffort | undefined;
    if (envEffort && !EFFORTS.includes(envEffort)) {
      (options.warn ?? console.warn)(`[opennjob] OPENNJOB_LLM_EFFORT must be one of ${EFFORTS.join(', ')}; using "medium".`);
    }
    this.effort = options.effort ?? (envEffort && EFFORTS.includes(envEffort) ? envEffort : 'medium');
    if (options.client) {
      this.client = options.client;
    } else {
      const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY;
      if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set');
      this.client = new Anthropic({ apiKey }) as unknown as AnthropicMessagesClient;
    }
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    const body: AnthropicRequestBody = {
      model: this.model,
      max_tokens: request.maxTokens + THINKING_HEADROOM_TOKENS,
      system: request.system,
      messages: [{ role: 'user', content: request.prompt }],
      output_config: { effort: this.effort },
      ...(FALLBACK_MODELS.has(this.model) ? { betas: [FALLBACK_BETA], fallbacks: 'default' as const } : {}),
    };
    const res = await this.client.beta.messages.create(body);
    if (res.stop_reason === 'refusal') throw new LlmRefusalError();
    const text = res.content
      .filter((block) => block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text as string)
      .join('');
    return { text, inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens };
  }
}

/**
 * Deterministic LLM for tests and offline demos. Records every call.
 * Token counts are a fixed function of text length (4 characters per token, rounded up).
 */
export class FakeLlm implements LlmPort {
  readonly calls: LlmRequest[] = [];

  constructor(private readonly responder: (request: LlmRequest) => string = FakeLlm.echo) {}

  static echo(request: LlmRequest): string {
    return `FAKE-LLM-REPLY(${request.prompt.length})`;
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    this.calls.push(request);
    const text = this.responder(request);
    return {
      text,
      inputTokens: Math.ceil((request.system.length + request.prompt.length) / 4),
      outputTokens: Math.ceil(text.length / 4),
    };
  }
}

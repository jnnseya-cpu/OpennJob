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
 * !!! PLACEHOLDER - DEVELOPER MUST CONFIRM !!!
 * This is only used when the OPENNJOB_MODEL environment variable is not set.
 * Model names change. Check Anthropic's current model list
 * (https://docs.anthropic.com/en/docs/about-claude/models) and set OPENNJOB_MODEL explicitly.
 * Do not ship relying on this value.
 */
export const PLACEHOLDER_MODEL_CONFIRM_BEFORE_USE = 'claude-sonnet-4-5';

/** The slice of the Anthropic SDK client we use. Lets tests substitute a stub without network. */
export interface AnthropicMessagesClient {
  messages: {
    create(body: {
      model: string;
      max_tokens: number;
      system: string;
      messages: { role: 'user'; content: string }[];
    }): Promise<{
      content: ReadonlyArray<{ type: string; text?: string }>;
      usage: { input_tokens: number; output_tokens: number };
    }>;
  };
}

export interface AnthropicLlmOptions {
  apiKey?: string;
  model?: string;
  client?: AnthropicMessagesClient;
  warn?: (message: string) => void;
}

/**
 * LlmPort backed by the official @anthropic-ai/sdk.
 * Reads ANTHROPIC_API_KEY and OPENNJOB_MODEL from the environment unless passed in.
 * NOT exercised against the live API in this repository's tests (the sandbox has no network
 * access and no key); the request/response mapping is unit-tested with a stub client.
 */
export class AnthropicLlm implements LlmPort {
  readonly model: string;
  private readonly client: AnthropicMessagesClient;

  constructor(options: AnthropicLlmOptions = {}) {
    const envModel = process.env.OPENNJOB_MODEL?.trim();
    const model = options.model?.trim() || envModel;
    if (!model) {
      (options.warn ?? console.warn)(
        `[opennjob] OPENNJOB_MODEL is not set; falling back to placeholder "${PLACEHOLDER_MODEL_CONFIRM_BEFORE_USE}". ` +
          'Confirm the model name against Anthropic\'s current model list and set OPENNJOB_MODEL.',
      );
    }
    this.model = model || PLACEHOLDER_MODEL_CONFIRM_BEFORE_USE;
    if (options.client) {
      this.client = options.client;
    } else {
      const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY;
      if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set');
      this.client = new Anthropic({ apiKey }) as unknown as AnthropicMessagesClient;
    }
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    const res = await this.client.messages.create({
      model: this.model,
      max_tokens: request.maxTokens,
      system: request.system,
      messages: [{ role: 'user', content: request.prompt }],
    });
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

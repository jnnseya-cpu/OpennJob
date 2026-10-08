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

import { describe, expect, it } from 'vitest';
import { OpenAiCompatibleLlm } from '../src/llm-openai';
import type { ChatFetch } from '../src/llm-openai';

/** Gemini and OpenAI through the OpenAI-style request, with a stub fetch. No live calls, no real keys. */
function stub(reply: unknown, status = 200) {
  const calls: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
  const fetch: ChatFetch = async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) as Record<string, unknown> });
    return { ok: status < 300, status, json: async () => reply };
  };
  return { fetch, calls };
}
const ANSWER = { choices: [{ message: { content: 'A fictional answer.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 120, completion_tokens: 30 } };

describe('Gemini and OpenAI', () => {
  it('Gemini: its OpenAI-compatible address, the key as a bearer token, system and user messages, max_tokens', async () => {
    const { fetch, calls } = stub(ANSWER);
    const llm = new OpenAiCompatibleLlm({ provider: 'gemini', apiKey: 'gemini-key-not-a-secret', fetch });
    expect(await llm.complete({ system: 'Be brief.', prompt: 'Say hello.', maxTokens: 100 })).toEqual({ text: 'A fictional answer.', inputTokens: 120, outputTokens: 30 });
    expect(calls[0]?.url).toBe('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions');
    expect(calls[0]?.headers.Authorization).toBe('Bearer gemini-key-not-a-secret');
    expect(calls[0]?.body).toMatchObject({ model: 'gemini-2.5-flash', messages: [{ role: 'system', content: 'Be brief.' }, { role: 'user', content: 'Say hello.' }], max_tokens: 4_100 });
  });

  it('OpenAI: api.openai.com, max_completion_tokens, the model chosen', async () => {
    const { fetch, calls } = stub(ANSWER);
    await new OpenAiCompatibleLlm({ provider: 'openai', apiKey: 'k', model: 'example-model', fetch }).complete({ system: 's', prompt: 'p', maxTokens: 50 });
    expect(calls[0]?.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(calls[0]?.body).toMatchObject({ model: 'example-model', max_completion_tokens: 4_050 });
    expect(calls[0]?.body).not.toHaveProperty('max_tokens');
  });

  it('an error carries the status only, never the prompt; an empty answer is an error', async () => {
    const failing = stub({ error: { message: 'details' } }, 429);
    const err = await new OpenAiCompatibleLlm({ provider: 'gemini', apiKey: 'k', fetch: failing.fetch }).complete({ system: 's', prompt: 'A private CV line (fictional)', maxTokens: 10 }).catch((e: Error) => e);
    expect(String(err)).toContain('HTTP 429');
    expect(String(err)).not.toContain('private CV line');
    const empty = stub({ choices: [{ message: { content: '' }, finish_reason: 'length' }] });
    await expect(new OpenAiCompatibleLlm({ provider: 'openai', apiKey: 'k', fetch: empty.fetch }).complete({ system: 's', prompt: 'p', maxTokens: 10 })).rejects.toThrow(/no answer \(length\)/);
    await expect(new OpenAiCompatibleLlm({ provider: 'openai', apiKey: ' ', fetch: empty.fetch }).complete({ system: 's', prompt: 'p', maxTokens: 10 })).rejects.toThrow(/key is not set/);
  });
});

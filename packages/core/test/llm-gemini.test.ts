import { describe, expect, it } from 'vitest';
import { GeminiLlm } from '../src/llm-gemini';
import type { ChatFetch } from '../src/llm-gemini';

/** Gemini through its OpenAI-compatible address, with a stub fetch. No live calls, no real keys. */
function stub(reply: unknown, status = 200) {
  const calls: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
  const fetch: ChatFetch = async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) as Record<string, unknown> });
    return { ok: status < 300, status, json: async () => reply };
  };
  return { fetch, calls };
}
const ANSWER = { choices: [{ message: { content: 'A fictional answer.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 120, completion_tokens: 30 } };

describe('Gemini', () => {
  it('its OpenAI-compatible address, the key as a bearer token, system and user messages, room to think', async () => {
    const { fetch, calls } = stub(ANSWER);
    const llm = new GeminiLlm({ apiKey: 'gemini-key-not-a-secret', fetch });
    expect(await llm.complete({ system: 'Be brief.', prompt: 'Say hello.', maxTokens: 100 })).toEqual({ text: 'A fictional answer.', inputTokens: 120, outputTokens: 30 });
    expect(calls[0]?.url).toBe('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions');
    expect(calls[0]?.headers.Authorization).toBe('Bearer gemini-key-not-a-secret');
    expect(calls[0]?.body).toMatchObject({ model: 'gemini-2.5-flash', messages: [{ role: 'system', content: 'Be brief.' }, { role: 'user', content: 'Say hello.' }], max_tokens: 4_100 });
    expect(new GeminiLlm({ apiKey: 'k', model: 'example-model', fetch }).model).toBe('example-model');
  });

  it('an error carries the status only, never the prompt; an empty answer or no key is an error', async () => {
    const failing = stub({ error: { message: 'details' } }, 429);
    const err = await new GeminiLlm({ apiKey: 'k', fetch: failing.fetch }).complete({ system: 's', prompt: 'A private CV line (fictional)', maxTokens: 10 }).catch((e: Error) => e);
    expect(String(err)).toContain('HTTP 429');
    expect(String(err)).not.toContain('private CV line');
    const empty = stub({ choices: [{ message: { content: '' }, finish_reason: 'length' }] });
    await expect(new GeminiLlm({ apiKey: 'k', fetch: empty.fetch }).complete({ system: 's', prompt: 'p', maxTokens: 10 })).rejects.toThrow(/no answer \(length\)/);
    await expect(new GeminiLlm({ apiKey: ' ', fetch: empty.fetch }).complete({ system: 's', prompt: 'p', maxTokens: 10 })).rejects.toThrow(/GEMINI_API_KEY is not set/);
  });
});

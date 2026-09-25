/**
 * `LayaClient` and `compactMessages` are exported public API with, until now,
 * no test at all.
 *
 * There are deliberately two HTTP paths in this package and they cannot be
 * merged: this one uses the global `fetch` with an `AbortSignal`, and the hook
 * uses `$.http.fetch`, where neither `fetch`, `AbortController` nor `setTimeout`
 * exists. So both are tested instead.
 */
import { describe, expect, it } from 'vitest';
import { LayaClient } from '../src/client.js';
import { compactMessages } from '../src/messages.js';
import type { Message } from '../src/index.js';

const answered = (body: unknown, status = 200): typeof fetch =>
  (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe('LayaClient', () => {
  it('sends the state and questions and reads the answers back', async () => {
    const seen: { url?: string; body?: unknown; auth?: string | null } = {};
    const client = new LayaClient({
      apiKey: 'k', model: 'typed-decisions', baseUrl: 'http://127.0.0.1:9/v1/systemone',
      fetch: (async (url: string, init: RequestInit) => {
        seen.url = url;
        seen.body = JSON.parse(String(init.body));
        seen.auth = new Headers(init.headers).get('authorization');
        return new Response(JSON.stringify({ answers: { result_t1: { noul: 0.7 } } }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    const response = await client.ask('a state', { result_t1: { type: 'noul', instructions: 'x' } });
    expect((response.answers['result_t1'] as { noul: number }).noul).toBe(0.7);
    expect(seen.url).toBe('http://127.0.0.1:9/v1/systemone');
    expect(seen.auth).toBe('Bearer k');
    expect(seen.body).toMatchObject({ model: 'typed-decisions', state: 'a state' });
  });

  it('rejects on an HTTP error rather than returning an empty answer set', async () => {
    const client = new LayaClient({ fetch: answered({ detail: 'state too long' }, 413) });
    await expect(client.ask('x', { result_t1: { type: 'noul', instructions: 'x' } })).rejects.toThrow();
  });

  it('aborts a request that outlives its timeout', async () => {
    const client = new LayaClient({
      timeoutMs: 10,
      fetch: ((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      })) as unknown as typeof fetch,
    });
    await expect(client.ask('x', { result_t1: { type: 'noul', instructions: 'x' } })).rejects.toThrow('aborted');
  });
});

describe('compactMessages', () => {
  const transcript: Message[] = [
    { role: 'user', text: 'fix the test', toolUses: [] },
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'c1', tool: 'Read', input: { file_path: 'a.ts' } }] },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'c1', text: 'x'.repeat(8000) }] },
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'c2', tool: 'Edit', input: { file_path: 'a.ts' } }] },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'c2', text: 'done' }] },
    { role: 'assistant', text: 'fixed', toolUses: [] },
  ];

  it('scores through the sidecar and drops what it scores low', async () => {
    const result = await compactMessages(transcript, {
      preserveRecentMessages: 1,
      fetch: (async (_url: string, init: RequestInit) => {
        const questions = Object.keys(JSON.parse(String(init.body)).questions);
        const answers = Object.fromEntries(questions.map((name) => [name, { noul: 0.01 }]));
        return new Response(JSON.stringify({ answers }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    expect(result.stats.requests).toBeGreaterThan(0);
    expect(result.stats.failedRequests).toBe(0);
    expect(result.stats.charsAfter).toBeLessThan(result.stats.charsBefore);
  });

  // Every request failing has to *reject*, not return an untouched transcript:
  // the caller's fallback is what preserves the session, and a silent no-op
  // would look like a successful compaction that freed nothing.
  it('rejects when every request to the sidecar fails', async () => {
    await expect(compactMessages(transcript, {
      preserveRecentMessages: 1,
      fetch: (async () => { throw new Error('econnrefused'); }) as unknown as typeof fetch,
    })).rejects.toThrow(/scored no calls/);
  });

  it('keeps the calls whose own request failed, and drops the rest', async () => {
    let calls = 0;
    const result = await compactMessages(transcript, {
      preserveRecentMessages: 1,
      concurrency: 1,
      fetch: (async (_url: string, init: RequestInit) => {
        calls += 1;
        if (calls === 1) throw new Error('econnrefused');
        const questions = Object.keys(JSON.parse(String(init.body)).questions);
        return new Response(JSON.stringify({
          answers: Object.fromEntries(questions.map((name) => [name, { noul: 0.01 }])),
        }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    expect(result.stats.failedRequests).toBe(1);
    // A wrong keep costs context; a wrong drop destroys something.
    expect(result.decisions.find((d) => d.keepResult === 1)?.action).toBe('keep');
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { serve } from '../src/server.js';
import { parseSystemOneResponse } from '../src/request.js';

let server: Server;
let base = '';

beforeAll(async () => {
  server = await serve({ port: 0 });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  base = `http://127.0.0.1:${port}`;
});
afterAll(() => { server.close(); });

const body = {
  state: 'Task: fix it\n\nThe assistant ran the Read tool on the file a.ts. That happened long ago in the session. The output was long.',
  questions: {
    call_t1: { type: 'noul', instructions: 'x' },
    result_t1: { type: 'noul', instructions: 'x' },
  },
};

async function post(payload: unknown, headers: Record<string, string> = {}) {
  return fetch(`${base}/v1/systemone`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(payload),
  });
}

describe('scorer server', () => {
  it('answers on the System One wire protocol, parseable by the unmodified client', async () => {
    const response = await post(body);
    const parsed = parseSystemOneResponse(response.status, response.ok, await response.text());
    expect(Object.keys(parsed.answers).sort()).toEqual(['call_t1', 'result_t1']);
    const noul = (parsed.answers.result_t1 as { noul: number }).noul;
    expect(noul).toBeGreaterThan(0);
    expect(noul).toBeLessThan(1);
  });

  it('reports health', async () => {
    const response = await fetch(`${base}/health`);
    expect(await response.json()).toMatchObject({ status: 'ok', scorer: 'features' });
  });

  it('rejects a body that is not JSON', async () => {
    const response = await fetch(`${base}/v1/systemone`, { method: 'POST', body: 'not json' });
    expect(response.status).toBe(400);
  });

  it('rejects questions that are not an object', async () => {
    expect((await post({ state: 'x', questions: 'nope' })).status).toBe(400);
  });

  it('404s an unknown path', async () => {
    expect((await fetch(`${base}/nope`)).status).toBe(404);
  });

  it('accepts a structured state, like Jev clients send', async () => {
    const response = await post({ state: { context: 'c', history: [] }, questions: body.questions });
    expect(response.ok).toBe(true);
  });
});

describe('scorer server with a key', () => {
  let keyed: Server;
  let keyedBase = '';
  beforeAll(async () => {
    keyed = await serve({ port: 0, apiKey: 'secret' });
    const address = keyed.address();
    keyedBase = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  });
  afterAll(() => { keyed.close(); });

  it('401s without the bearer token and passes with it', async () => {
    const send = (headers: Record<string, string>) =>
      fetch(`${keyedBase}/v1/systemone`, {
        method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
      });
    expect((await send({})).status).toBe(401);
    expect((await send({ authorization: 'Bearer secret' })).ok).toBe(true);
  });
});

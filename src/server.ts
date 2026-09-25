/**
 * The built-in scorer on the System One wire protocol.
 *
 * `POST /v1/systemone` with `{state, questions}` returns `{answers}`, the same
 * shape TypeSafe's Jev and `laya-serve` return. That makes any existing client
 * of either work against it by repointing one URL — `jev-compact` for Codex CLI
 * has a `baseUrl` config, so the Codex host needs no new plugin code at all.
 *
 * No model, no GPU, no weights to download: the answers come from the logistic
 * model in `features.ts`, which measured better than the encoder it replaces.
 */
import { createServer, type Server } from 'node:http';
import { FeatureAsker } from './features.js';
import type { SystemOneQuestions } from './types.js';

export const DEFAULT_PORT = 8770;

/** 413 above this, matching `laya-serve`'s own `MAX_STATE_CHARS`. */
export const MAX_BODY_BYTES = 1_000_000;

export interface ServeOptions {
  port?: number;
  host?: string;
  /** Required in `Authorization: Bearer <key>` when set. */
  apiKey?: string;
}

function send(response: import('node:http').ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(text);
}

export function createScorerServer(options: ServeOptions = {}): Server {
  const asker = new FeatureAsker();
  return createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/health') {
      return send(response, 200, { status: 'ok', scorer: 'features', model: 'kompact-logistic' });
    }
    if (request.method !== 'POST' || !request.url?.startsWith('/v1/systemone')) {
      return send(response, 404, { error: 'not found' });
    }
    if (options.apiKey && request.headers.authorization !== `Bearer ${options.apiKey}`) {
      return send(response, 401, { error: 'unauthorized' });
    }
    let body = '';
    let tooLarge = false;
    request.on('data', (chunk: Buffer) => {
      if (tooLarge) return;
      body += chunk.toString('utf8');
      if (body.length > MAX_BODY_BYTES) {
        tooLarge = true;
        send(response, 413, { error: 'state too large' });
        request.destroy();
      }
    });
    request.on('end', () => {
      if (tooLarge) return;
      let parsed: { state?: unknown; questions?: unknown };
      try {
        parsed = JSON.parse(body);
      } catch {
        return send(response, 400, { error: 'body is not JSON' });
      }
      const questions = parsed.questions;
      if (questions === null || typeof questions !== 'object') {
        return send(response, 400, { error: 'questions must be an object' });
      }
      const state = typeof parsed.state === 'string' ? parsed.state : JSON.stringify(parsed.state ?? '');
      asker
        .ask(state, questions as SystemOneQuestions)
        .then((result) => send(response, 200, { model: 'kompact-logistic', ...result }))
        .catch((error: unknown) => send(response, 500, { error: String(error) }));
    });
  });
}

export function serve(options: ServeOptions = {}): Promise<Server> {
  const server = createScorerServer(options);
  const port = options.port ?? DEFAULT_PORT;
  const host = options.host ?? '127.0.0.1';
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(server));
  });
}

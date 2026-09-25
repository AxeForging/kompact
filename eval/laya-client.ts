import { buildSystemOneRequest, parseSystemOneResponse } from '../src/request.js';
import type { Asker, SystemOneQuestions, SystemOneResponse, SystemOneState } from '../src/types.js';

export interface LayaClientOptions {
  /** Only needed when the sidecar runs with `LAYA_API_KEY`; `LAYA_API_KEY` env by default. */
  apiKey?: string;
  /** Defaults to `multilingual`. */
  model?: string;
  /** Defaults to the local sidecar, `http://127.0.0.1:8000/v1/systemone`. */
  baseUrl?: string;
  /** Defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** Per-request timeout, ms. Default 30s — a local call is milliseconds. */
  timeoutMs?: number;
}

/** Asks the local Laya sidecar over HTTP with the global `fetch` (or an injected one). */
export class LayaClient implements Asker {
  private readonly apiKey: string;
  private readonly model: string | undefined;
  private readonly baseUrl: string | undefined;
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: LayaClientOptions = {}) {
    // No throw when unset: a localhost sidecar normally runs without a key.
    this.apiKey = options.apiKey ?? process.env.LAYA_API_KEY ?? '';
    this.model = options.model;
    this.baseUrl = options.baseUrl ?? process.env.LAYA_URL;
    this.fetcher = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  async ask(state: SystemOneState, questions: SystemOneQuestions): Promise<SystemOneResponse> {
    const request = buildSystemOneRequest(
      { apiKey: this.apiKey, model: this.model, baseUrl: this.baseUrl },
      state,
      questions,
    );
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetcher(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
        signal: controller.signal,
      });
      return parseSystemOneResponse(response.status, response.ok, await response.text());
    } finally {
      clearTimeout(timer);
    }
  }
}

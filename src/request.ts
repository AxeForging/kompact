import type { SystemOneAnswer, SystemOneQuestions, SystemOneResponse, SystemOneState } from './types.js';

/**
 * Local `laya-serve` (`pip install "laya[serve]"`), not a hosted API.
 *
 * `SystemOne*` names the wire protocol — `POST /v1/systemone`, typed questions
 * in and probabilities out — which TypeSafe's hosted Jev defined and
 * `laya-serve` reimplements. Nothing in this package talks to Jev.
 */
export const LAYA_URL = 'http://127.0.0.1:8000/v1/systemone';

/**
 * `multilingual`, not `english`, despite Laya's general advice for English text.
 *
 * The English checkpoint reads 512 tokens in total, about 320 of them state, and
 * discards the rest with HTTP 200 and no warning — `eval/truncation.ts` measures
 * the cut, and its published figures are the ones to quote. `multilingual` has
 * 768 tokens of state budget, is smaller (322M) and is faster.
 *
 * An earlier version of this comment also claimed the English checkpoint answered
 * 0.41 for a fact its state stated verbatim. That pair of figures was retracted
 * from every public text in `fd7b747` as unreproducible — with the decisive
 * sentence at the front of the filler the answer does not degrade at all, because
 * the sentence is inside the cut — and it should not have survived here.
 */
export const DEFAULT_MODEL = 'multilingual';

/** Usable state tokens per checkpoint: context length minus the option head. */
export const STATE_BUDGET: Record<string, number> = {
  english: 512 - 192,
  multilingual: 1024 - 256,
  'typed-decisions': 1024 - 256,
};

/**
 * Full context length per checkpoint. A response reporting exactly this many
 * input tokens was truncated: the server caps silently and still answers 200.
 */
export const CONTEXT_LENGTH: Record<string, number> = {
  english: 512,
  multilingual: 1024,
  'typed-decisions': 1024,
};

/**
 * The size at which `laya-serve` itself answers 413. Documentation, not a check:
 * nothing here compares a state against it, because the per-call states this
 * package builds are two orders of magnitude smaller. `src/server.ts` enforces
 * its own, larger, body limit.
 */
export const MAX_STATE_CHARS = 50_000;

export interface SystemOneRequest {
  url: string;
  method: 'POST';
  headers: Record<string, string>;
  body: string;
}

/** The HTTP request for one Laya call, for any fetch-like transport. */
export function buildSystemOneRequest(
  params: {
    /** Only needed when the sidecar runs with `LAYA_API_KEY` set. */
    apiKey?: string;
    model?: string;
    baseUrl?: string;
  },
  state: SystemOneState,
  questions: SystemOneQuestions,
): SystemOneRequest {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  // A local sidecar needs no key. The upstream client threw outright when the
  // key was missing, which is the one hard blocker to pointing it at Laya.
  if (params.apiKey) headers.authorization = `Bearer ${params.apiKey}`;
  return {
    url: params.baseUrl ?? LAYA_URL,
    method: 'POST',
    headers,
    body: JSON.stringify({ model: params.model ?? DEFAULT_MODEL, state, questions }),
  };
}

/** Validates a response body; throws on anything but an `answers` object. */
export function parseSystemOneResponse(status: number, ok: boolean, text: string): SystemOneResponse {
  if (!ok) throw new Error(`Laya request failed (${status}): ${text.slice(0, 200)}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Laya returned malformed JSON');
  }
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    !('answers' in parsed) ||
    parsed.answers === null ||
    typeof parsed.answers !== 'object'
  ) {
    throw new Error('Laya response is missing answers');
  }
  return parsed as SystemOneResponse;
}

/** The `noul` probability of one answer; throws when it is not there. */
export function noulAnswer(answers: Record<string, SystemOneAnswer>, name: string): number {
  const answer = answers[name];
  if (
    !answer ||
    !('noul' in answer) ||
    typeof answer.noul !== 'number' ||
    !Number.isFinite(answer.noul)
  ) {
    throw new Error(`Invalid Laya answer for ${name}`);
  }
  return answer.noul;
}

/**
 * Tokens the sidecar actually read, from `usage.input_tokens`. The only honest
 * way to detect truncation: the server caps at the checkpoint's context length
 * silently and still answers 200.
 */
export function inputTokens(response: SystemOneResponse): number | undefined {
  const value = response.usage?.input_tokens;
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Which checkpoint the router actually used, from `routing.model`. */
export function routedModel(response: SystemOneResponse): string | undefined {
  const routing = (response as { routing?: unknown }).routing;
  if (routing === null || typeof routing !== 'object') return undefined;
  const model = (routing as { model?: unknown }).model;
  return typeof model === 'string' ? model : undefined;
}

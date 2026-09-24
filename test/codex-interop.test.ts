/**
 * Proves the Codex path without a Codex.
 *
 * `fatelei/jev-compact` is the Codex CLI plugin; it has a `baseUrl` config, so
 * pointing it at our server is the whole integration. Rather than assert that
 * from the README, this drives *its own* code — its rollout parser, its call
 * pairing, its scorer and its HTTP client — against our server, using its own
 * recorded Codex rollout fixture. If the wire protocol were wrong in any
 * detail, this fails.
 *
 * Skips when `vendor/` is absent (it is gitignored).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { serve } from '../src/server.js';

const vendor = join(import.meta.dirname, '..', 'vendor', 'jev-compact', 'plugins', 'jev-compact');
const fixture = join(vendor, 'test', 'fixtures', 'rollout-compacted-sample.jsonl');
const present = existsSync(fixture);

describe.skipIf(!present)('codex plugin interop', () => {
  let server: Server;
  let baseUrl = '';

  beforeAll(async () => {
    server = await serve({ port: 0 });
    const address = server.address();
    baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/v1/systemone`;
  });
  afterAll(() => { server.close(); });

  it('scores a real Codex rollout through jev-compact’s own pipeline', async () => {
    const { parseTranscriptFile, liveItems } = await import(`${vendor}/src/rollout/index.ts`);
    const { scoreCalls } = await import(`${vendor}/src/score.ts`);
    const { JevClient } = await import(`${vendor}/src/jev/client.ts`);

    const { transcript } = await parseTranscriptFile(fixture);
    const items = liveItems(transcript);
    expect(items.length).toBeGreaterThan(0);

    // Its client demands a key; ours ignores it unless started with one.
    const client = new JevClient({ apiKey: 'unused', baseUrl, retries: 0 });
    const scored = await scoreCalls(items, client, { preserveRecentItems: 2 });

    expect(scored.asked).toBe(true);
    expect(scored.failedBatches).toBe(0);
    expect(scored.decisions.length).toBeGreaterThan(0);
    // Every decision carries two real probabilities, not the keep-everything default.
    for (const decision of scored.decisions) {
      expect(decision.keepCall).toBeGreaterThanOrEqual(0);
      expect(decision.keepCall).toBeLessThanOrEqual(1);
      expect(decision.keepResult).toBeGreaterThanOrEqual(0);
      expect(decision.keepResult).toBeLessThanOrEqual(1);
    }
    const scoredOnes = scored.decisions.filter((d: { reason: string }) => d.reason === 'scored');
    expect(scoredOnes.length).toBeGreaterThan(0);
  });

  it('discriminates on that rollout rather than answering one constant', async () => {
    const { parseTranscriptFile, liveItems } = await import(`${vendor}/src/rollout/index.ts`);
    const { scoreCalls } = await import(`${vendor}/src/score.ts`);
    const { JevClient } = await import(`${vendor}/src/jev/client.ts`);
    const { transcript } = await parseTranscriptFile(fixture);
    const client = new JevClient({ apiKey: 'unused', baseUrl, retries: 0 });
    const scored = await scoreCalls(liveItems(transcript), client, { preserveRecentItems: 2 });
    const values = new Set(
      scored.decisions
        .filter((d: { reason: string }) => d.reason === 'scored')
        .map((d: { keepResult: number }) => d.keepResult.toFixed(4)),
    );
    expect(values.size).toBeGreaterThan(1);
  });
});

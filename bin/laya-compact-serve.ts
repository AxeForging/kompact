#!/usr/bin/env node
/**
 * Serves the built-in scorer on Jev's wire protocol, for hosts that speak it.
 *
 *   bun bin/laya-compact-serve.ts --port 8770
 *
 * Then point any Jev client at it. For Codex CLI, in
 * `~/.codex/fast-jev-compaction.json`:
 *   { "baseUrl": "http://127.0.0.1:8770/v1/systemone", "apiKey": "unused" }
 */
import { DEFAULT_PORT, serve } from '../src/server.js';

const args = process.argv.slice(2);
const value = (flag: string): string | undefined => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};

if (args.includes('--help') || args.includes('-h')) {
  console.log(`laya-compact-serve — the built-in scorer on Jev's System One wire protocol.

  --port <n>       default ${DEFAULT_PORT}, or LAYA_COMPACT_PORT
  --host <addr>    default 127.0.0.1, or LAYA_COMPACT_HOST
  --api-key <key>  require this bearer token, or LAYA_COMPACT_API_KEY
  --help           this

POST /v1/systemone with {state, questions}; answers come back as nouls. No
model is loaded and no GPU is touched — it is thirteen coefficients over facts
already present in the state. For Codex CLI, put this in
~/.codex/fast-jev-compaction.json:

  { "baseUrl": "http://127.0.0.1:${DEFAULT_PORT}/v1/systemone", "apiKey": "unused" }`);
  process.exit(0);
}

const port = Number(value('--port') ?? process.env.LAYA_COMPACT_PORT ?? DEFAULT_PORT);
const host = value('--host') ?? process.env.LAYA_COMPACT_HOST ?? '127.0.0.1';
const apiKey = value('--api-key') ?? process.env.LAYA_COMPACT_API_KEY;

serve({ port, host, apiKey })
  .then(() => {
    console.log(`laya-compact scorer on http://${host}:${port}/v1/systemone (no model, no GPU)`);
    if (!apiKey && host !== '127.0.0.1') console.warn('warning: bound beyond localhost with no --api-key');
  })
  .catch((error: unknown) => {
    console.error(`failed to bind ${host}:${port}: ${String(error)}`);
    process.exitCode = 1;
  });

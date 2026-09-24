/**
 * Live inversion check against the local sidecar. Not a unit test — it needs
 * `laya-serve` on 127.0.0.1:8000. Run: bun test/live-smoke.ts
 *
 * The question that matters: does a one-off observation (a failing test run)
 * score higher on "keep the result" than a stale file read that was edited
 * immediately afterwards? If those two come out the same, or inverted, the
 * question wording is wrong and no amount of calibration saves it.
 */
import { LayaClient } from '../src/client.js';
import { compact } from '../src/compact.js';
import { buildCallState, callContexts, collectToolCalls } from '../src/state.js';
import type { Message, Phrasing } from '../src/index.js';

function call(id: string, tool: string, input: Record<string, unknown>, out: string, isError = false) {
  return {
    assistant: { role: 'assistant' as const, text: '', toolUses: [{ tool_use_id: id, tool, input }] },
    user: {
      role: 'user' as const,
      text: '',
      toolUses: [],
      toolResults: [{ tool_use_id: id, text: out, isError }],
    },
  };
}

const staleRead = call('c1', 'Read', { file_path: 'src/auth.ts' },
  'export function verifyToken(token: string) {\n  return jwt.verify(token, SECRET);\n}\n'.repeat(20));
const edit = call('c2', 'Edit', { file_path: 'src/auth.ts' }, 'The file src/auth.ts has been updated.');
const listing = call('c3', 'Bash', { command: 'ls -la src' },
  'total 48\ndrwxr-xr-x 2 oa oa 4096 Sep 24 10:00 .\n-rw-r--r-- 1 oa oa 2451 Sep 24 10:00 auth.ts\n'.repeat(10));
const failure = call('c4', 'Bash', { command: 'npm test' },
  'FAIL test/auth.spec.ts\n  ● verifyToken › rejects an expired token\n\n    expected 401, received 200\n\n      at Object.<anonymous> (test/auth.spec.ts:42:18)\n\n  1 failed, 12 passed\n', true);

const messages: Message[] = [
  { role: 'user', text: 'The expired-token test is failing. Fix it.', toolUses: [] },
  staleRead.assistant, staleRead.user,
  edit.assistant, edit.user,
  listing.assistant, listing.user,
  failure.assistant, failure.user,
  { role: 'assistant', text: 'Looking into it.', toolUses: [] },
  { role: 'user', text: 'any luck?', toolUses: [] },
];

const client = new LayaClient();
const calls = collectToolCalls(messages, 2);
const contexts = callContexts(calls, messages.length);

console.log('=== states built (budget 700) ===');
for (const c of calls) {
  const built = buildCallState(c, contexts.get(c.id)!, 'Fix the failing expired-token test.', 700);
  console.log(`${c.id} ${c.tool.padEnd(5)} tokens=${String(built.tokens).padStart(4)} rung=${built.rung} pinned=${c.pinned}`);
}

console.log('\n=== inversion check: P(keep result) per phrasing ===');
console.log('expect: the failing test run (t4) HIGH, the stale read (t1) and listing (t3) LOW\n');
for (const phrasing of ['reproducible', 'direct', 'entailment'] as Phrasing[]) {
  const result = await compact(messages, client, { preserveRecentMessages: 2, phrasing, concurrency: 4 });
  const row = result.decisions
    .map((d) => `${d.id}/${d.tool}=${d.keepResult.toFixed(3)}${d.reason === 'pinned' ? '(pin)' : ''}`)
    .join('  ');
  const t = result.decisions.find((d) => d.tool === 'Bash' && d.id === 't4');
  const r = result.decisions.find((d) => d.id === 't1');
  const verdict = t && r && t.reason !== 'pinned' && r.reason !== 'pinned'
    ? (t.keepResult > r.keepResult ? 'ORDER OK' : 'INVERTED')
    : 'n/a (pinned)';
  console.log(`${phrasing.padEnd(13)} ${row}`);
  console.log(`${''.padEnd(13)} ${verdict}  maxRowTokens=${result.stats.maxRowTokens.toFixed(0)} truncated=${result.stats.truncatedRequests} ckpt=${result.stats.checkpoint} failed=${result.stats.failedRequests}\n`);
}

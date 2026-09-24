/** Which checkpoint discriminates best now that states are small? */
import { LayaClient } from '../src/client.js';
import { compact } from '../src/compact.js';
import type { Message, Phrasing } from '../src/index.js';

function pair(id: string, tool: string, input: Record<string, unknown>, out: string, isError = false) {
  return [
    { role: 'assistant' as const, text: '', toolUses: [{ tool_use_id: id, tool, input }] },
    { role: 'user' as const, text: '', toolUses: [], toolResults: [{ tool_use_id: id, text: out, isError }] },
  ];
}
const messages: Message[] = [
  { role: 'user', text: 'The expired-token test is failing. Fix it.', toolUses: [] },
  ...pair('c1', 'Read', { file_path: 'src/auth.ts' },
    'export function verifyToken(token: string) {\n  return jwt.verify(token, SECRET);\n}\n'.repeat(20)),
  ...pair('c2', 'Edit', { file_path: 'src/auth.ts' }, 'The file src/auth.ts has been updated.'),
  ...pair('c3', 'Bash', { command: 'ls -la src' },
    'total 48\ndrwxr-xr-x 2 oa oa 4096 Sep 24 10:00 .\n-rw-r--r-- 1 oa oa 2451 Sep 24 10:00 auth.ts\n'.repeat(10)),
  ...pair('c4', 'Bash', { command: 'npm test' },
    'FAIL test/auth.spec.ts\n  ● verifyToken › rejects an expired token\n\n    expected 401, received 200\n\n      at Object.<anonymous> (test/auth.spec.ts:42:18)\n\n  1 failed, 12 passed\n', true),
  { role: 'assistant', text: 'Looking into it.', toolUses: [] },
  { role: 'user', text: 'any luck?', toolUses: [] },
];

console.log(`${'checkpoint'.padEnd(16)}${'phrasing'.padEnd(14)} t1Read  t2Edit  t3ls    t4FAIL  spread  order`);
for (const model of ['english', 'multilingual', 'typed-decisions']) {
  for (const phrasing of ['reproducible', 'direct', 'entailment'] as Phrasing[]) {
    try {
      const client = new LayaClient({ model });
      const r = await compact(messages, client, { preserveRecentMessages: 2, phrasing, concurrency: 4 });
      const v = (id: string) => r.decisions.find((d) => d.id === id)!.keepResult;
      const all = ['t1', 't2', 't3', 't4'].map(v);
      const spread = Math.max(...all) - Math.min(...all);
      const order = v('t4') > v('t1') && v('t4') > v('t3') ? 'OK' : 'INVERTED';
      console.log(
        `${model.padEnd(16)}${phrasing.padEnd(14)} ${all.map((x) => x.toFixed(3)).join('   ')}   ${spread.toFixed(3)}   ${order}` +
        `  rows=${r.stats.maxRowTokens.toFixed(0)} trunc=${r.stats.truncatedRequests}`);
    } catch (e) {
      console.log(`${model.padEnd(16)}${phrasing.padEnd(14)} ERROR ${String(e).slice(0, 60)}`);
    }
  }
}

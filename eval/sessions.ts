/**
 * What compaction frees on this machine's own Claude Code sessions.
 *
 * Unlike `repeat.ts` and `policy.ts`, this is not reproducible off the machine
 * that runs it: it reads whatever transcripts `~/.claude/projects` happens to
 * hold, and those grow as you work. The figure it prints is therefore a
 * snapshot of one corpus, not a constant — which is the honest way to quote it.
 */
import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { compact } from '../src/compact.js';
import { FeatureAsker } from '../src/features.js';
import { collectToolCalls, estimateTokens } from '../src/state.js';
import { readTranscript } from './transcript.js';
import type { Message } from '../src/index.js';

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    try {
      if (statSync(path).isDirectory()) out.push(...walk(path));
      else if (entry.endsWith('.jsonl')) out.push(path);
    } catch { /* a session being written can vanish mid-walk */ }
  }
  return out;
}

const tokensOf = (messages: readonly Message[]): number => {
  let total = 0;
  for (const message of messages) {
    total += estimateTokens(message.text);
    for (const tool of message.toolUses) {
      total += estimateTokens(JSON.stringify(tool.input)) + estimateTokens(tool.text ?? '');
    }
    for (const result of message.toolResults ?? []) total += estimateTokens(result.text);
  }
  return total;
};

const paths = walk(join(homedir(), '.claude', 'projects'))
  .map((path) => ({ path, size: statSync(path).size }))
  .sort((a, b) => b.size - a.size)
  .slice(0, 4);

console.log(
  `${'session'.padEnd(20)}${'calls'.padStart(6)}${'tok before'.padStart(12)}` +
  `${'tok after'.padStart(11)}${'freed'.padStart(9)}${'scoring'.padStart(9)}`,
);
console.log('-'.repeat(67));
let totalBefore = 0;
let totalAfter = 0;
let totalMs = 0;
let totalCalls = 0;
for (const { path } of paths) {
  const messages = readTranscript(path);
  if (collectToolCalls(messages, 6).length < 5) continue;
  const before = tokensOf(messages);
  const started = performance.now();
  const result = await compact(messages, new FeatureAsker());
  const ms = performance.now() - started;
  const after = tokensOf(result.messages);
  totalBefore += before;
  totalAfter += after;
  totalMs += ms;
  totalCalls += result.stats.calls;
  console.log(
    `${path.split('/').pop()!.slice(0, 18).padEnd(20)}${String(result.stats.calls).padStart(6)}` +
    `${before.toLocaleString().padStart(12)}${after.toLocaleString().padStart(11)}` +
    `${((100 * (before - after)) / before).toFixed(1).padStart(8)}%${`${ms.toFixed(0)}ms`.padStart(9)}`,
  );
}
console.log('-'.repeat(67));
console.log(
  `${'total'.padEnd(20)}${String(totalCalls).padStart(6)}${totalBefore.toLocaleString().padStart(12)}` +
  `${totalAfter.toLocaleString().padStart(11)}` +
  `${((100 * (totalBefore - totalAfter)) / totalBefore).toFixed(1).padStart(8)}%${`${totalMs.toFixed(0)}ms`.padStart(9)}`,
);

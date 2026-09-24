/**
 * Runs the registered `session.compact` hook over a real Claude Code session
 * from disk, not a fixture.
 *
 * The property that matters most is structural: every `tool_result` left behind
 * must still have its `tool_use`, and vice versa. An orphan on either side is
 * rejected by the API, which would break the session the compaction was
 * supposed to save — and no synthetic fixture exercises the shapes real
 * sessions contain (parallel calls, errors, images, sidechains).
 *
 * Skips when there is no local transcript with enough tool calls.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { register } from '../hooks/laya-compact.js';
import { readTranscript } from '../eval/transcript.js';
import { collectToolCalls } from '../src/state.js';
import type { Message } from '../src/index.js';

function walk(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const path = join(dir, entry);
    try {
      if (statSync(path).isDirectory()) out.push(...walk(path));
      else if (entry.endsWith('.jsonl')) out.push(path);
    } catch {
      /* a session being written to can vanish mid-walk */
    }
  }
  return out;
}

/** The largest local transcript that has a decent number of paired calls. */
function findTranscript(): Message[] | undefined {
  const paths = walk(join(homedir(), '.claude', 'projects'))
    .map((path) => ({ path, size: statSync(path).size }))
    .sort((a, b) => b.size - a.size);
  for (const { path } of paths.slice(0, 5)) {
    const messages = readTranscript(path);
    if (collectToolCalls(messages, 6).length >= 20) return messages;
  }
  return undefined;
}

const messages = findTranscript();

function handlers(options: Record<string, unknown>) {
  const map = new Map<string, Function>();
  register(((event: string, handler: Function) => map.set(event, handler)) as never, options as never);
  return map;
}

const engine = () => {
  const logs: string[] = [];
  return {
    logs,
    $: {
      ui: { log: (t: string) => logs.push(t), toast: () => {} },
      http: { fetch: async () => { throw new Error('offline'); } },
      session: { usage: async () => ({ context: { percent: 0 } }), compact: async () => {} },
    },
  };
};

/** Every tool_use has its result and every result its call — or the API rejects it. */
function pairingIsIntact(out: readonly Message[]): { orphanUses: string[]; orphanResults: string[] } {
  const uses = new Set<string>();
  const results = new Set<string>();
  for (const message of out) {
    for (const tool of message.toolUses) uses.add(tool.tool_use_id);
    for (const result of message.toolResults ?? []) results.add(result.tool_use_id);
  }
  return {
    orphanUses: [...uses].filter((id) => !results.has(id)),
    orphanResults: [...results].filter((id) => !uses.has(id)),
  };
}

describe.skipIf(messages === undefined)('a real session', () => {
  it('reads back with paired tool calls', () => {
    const calls = collectToolCalls(messages!, 6);
    expect(calls.length).toBeGreaterThanOrEqual(20);
    expect(pairingIsIntact(messages!).orphanResults).toEqual([]);
  });

  it('compacts offline and leaves no orphaned tool call or result', async () => {
    const result = await handlers({ minReductionRatio: 0 }).get('session.compact')!(
      engine().$, { messages: messages! }, () => 'FELL_BACK');
    expect(result).not.toBe('FELL_BACK');
    const { orphanUses, orphanResults } = pairingIsIntact(result.messages);
    expect(orphanResults).toEqual([]);
    expect(orphanUses).toEqual([]);
  });

  it('never touches user or assistant prose', async () => {
    const result = await handlers({ minReductionRatio: 0 }).get('session.compact')!(
      engine().$, { messages: messages! }, () => 'FELL_BACK');
    const before = messages!.filter((m) => m.text.trim() !== '').map((m) => m.text);
    const after = new Set((result.messages as Message[]).map((m) => m.text));
    for (const text of before) expect(after.has(text)).toBe(true);
  });

  it('actually frees characters, and reports how many', async () => {
    const eng = engine();
    const result = await handlers({ minReductionRatio: 0 }).get('session.compact')!(
      eng.$, { messages: messages! }, () => 'FELL_BACK');
    expect(result.messages.length).toBeLessThanOrEqual(messages!.length);
    expect(eng.logs.join(' ')).toMatch(/decisions/);
  });

  it('falls back rather than half-compacting when the scorer is a sidecar that is down', async () => {
    const result = await handlers({ scorer: 'laya' }).get('session.compact')!(
      engine().$, { messages: messages! }, () => 'FELL_BACK');
    expect(result).toBe('FELL_BACK');
  });
});

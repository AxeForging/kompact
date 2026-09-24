import { describe, expect, it } from 'vitest';
import {
  buildCallState, callContexts, collectToolCalls, describeAge, describeSize, targetOf,
} from '../src/state.js';
import { applyDecisions, compact, decideCall, pool, resolveOptions, rowTokens } from '../src/compact.js';
import { CONTEXT_LENGTH, STATE_BUDGET, buildSystemOneRequest } from '../src/request.js';
import { questionsFor } from '../src/questions.js';
import { FeatureAsker, toolFromState } from '../src/features.js';
import type { Asker, Message, ToolCall } from '../src/index.js';

function pair(id: string, tool: string, input: Record<string, unknown>, out: string, isError = false): Message[] {
  return [
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: id, tool, input }] },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: id, text: out, isError }] },
  ];
}
const transcript = (extra: Message[] = []): Message[] => [
  { role: 'user', text: 'fix the failing test', toolUses: [] },
  ...pair('c1', 'Read', { file_path: 'src/auth.ts' }, 'x'.repeat(4000)),
  ...pair('c2', 'Edit', { file_path: 'src/auth.ts' }, 'updated'),
  ...pair('c3', 'Bash', { command: 'npm test' }, 'FAIL auth.spec.ts\nexpected 401 got 200', true),
  ...extra,
  { role: 'assistant', text: 'done', toolUses: [] },
  { role: 'user', text: 'thanks', toolUses: [] },
];

const answering = (noul: number): Asker => ({
  async ask(_state, questions) {
    return { answers: Object.fromEntries(Object.keys(questions).map((k) => [k, { noul }])) };
  },
});

describe('state budget', () => {
  // The failure this guards against is silent: the server truncates an
  // over-long state and still answers 200, so a decision gets made on a
  // fragment. Nothing else in the system would notice.
  it('keeps every state inside the budget, however large the output', () => {
    const budget = 700;
    const sizes = [0, 10, 500, 5_000, 200_000, 2_000_000];
    for (const size of sizes) {
      const messages = transcript(pair('big', 'Bash', { command: 'cat huge.log' }, 'y'.repeat(size)));
      const calls = collectToolCalls(messages, 2);
      const contexts = callContexts(calls, messages.length);
      for (const call of calls) {
        const built = buildCallState(call, contexts.get(call.id)!, 'a goal', budget);
        expect(built.tokens, `call ${call.tool} with ${size} chars of output`).toBeLessThanOrEqual(budget);
      }
    }
  });

  it('stays under the multilingual state budget at the default', () => {
    expect(resolveOptions().maxCallStateTokens).toBeLessThanOrEqual(STATE_BUDGET.multilingual!);
  });

  it('never exceeds the char limit the server rejects with 413', () => {
    const messages = transcript(pair('big', 'Bash', { command: 'x' }, 'y'.repeat(500_000)));
    const calls = collectToolCalls(messages, 2);
    const contexts = callContexts(calls, messages.length);
    for (const call of calls) {
      const built = buildCallState(call, contexts.get(call.id)!, 'a goal', 700);
      expect(built.state.length).toBeLessThan(50_000);
    }
  });
});

describe('facts are words, never numbers', () => {
  it('buckets sizes and ages', () => {
    expect(describeSize(10)).toBe('very short');
    expect(describeSize(50_000)).toBe('very long');
    expect(describeAge(0, 100)).toBe('long ago in the session');
    expect(describeAge(99, 100)).toBe('just now');
  });

  it('puts no raw output-size digits in the state', () => {
    const messages = transcript();
    const calls = collectToolCalls(messages, 2);
    const contexts = callContexts(calls, messages.length);
    const call = calls.find((c) => c.tool === 'Read')!;
    const { state } = buildCallState(call, contexts.get(call.id)!, 'goal', 700);
    expect(state).toContain('The output was long.');
    expect(state).not.toContain(String(call.resultChars));
  });

  it('notices that a later Edit made an earlier Read stale', () => {
    const messages = transcript();
    const calls = collectToolCalls(messages, 2);
    const contexts = callContexts(calls, messages.length);
    const read = calls.find((c) => c.tool === 'Read')!;
    expect(contexts.get(read.id)!.targetTouchedAfter).toBe(true);
    const { state } = buildCallState(read, contexts.get(read.id)!, 'goal', 700);
    expect(state).toContain('changed afterwards');
  });

  it('keys targets so the same file matches and a different one does not', () => {
    expect(targetOf({ input: { file_path: 'a.ts' } })).toBe(targetOf({ input: { file_path: 'a.ts' } }));
    expect(targetOf({ input: { file_path: 'a.ts' } })).not.toBe(targetOf({ input: { file_path: 'b.ts' } }));
  });
});

describe('token accounting', () => {
  // usage.input_tokens is the sum over question rows; measured 323/646/1292/2584
  // for 1/2/4/8 questions on one fixed state.
  it('divides reported input tokens by the question count', () => {
    expect(rowTokens(646, 2)).toBe(323);
    expect(rowTokens(2584, 8)).toBe(323);
    expect(rowTokens(323, 0)).toBe(323);
  });

  it('asks exactly two questions per call', () => {
    const call = { id: 't1', tool: 'Read', input: { file_path: 'a.ts' } } as unknown as ToolCall;
    expect(Object.keys(questionsFor(call))).toEqual(['call_t1', 'result_t1']);
  });

  it('knows each checkpoint context length', () => {
    expect(CONTEXT_LENGTH.english).toBe(512);
    expect(CONTEXT_LENGTH.multilingual).toBe(1024);
  });
});

describe('request', () => {
  it('omits the auth header when the sidecar needs no key', () => {
    expect(buildSystemOneRequest({}, 'state', {}).headers.authorization).toBeUndefined();
    expect(buildSystemOneRequest({ apiKey: 'k' }, 'state', {}).headers.authorization).toBe('Bearer k');
  });

  it('defaults to the local sidecar', () => {
    expect(buildSystemOneRequest({}, 'state', {}).url).toContain('127.0.0.1:8000');
  });
});

describe('decisions', () => {
  const call = { id: 't1', tool: 'Read', pinned: false };
  it('keeps, drops the result, or drops the call', () => {
    expect(decideCall(call, { keepCall: 0.9, keepResult: 0.9 }, { keepThreshold: 0.5 }).action).toBe('keep');
    expect(decideCall(call, { keepCall: 0.9, keepResult: 0.1 }, { keepThreshold: 0.5 }).action).toBe('drop_result');
    expect(decideCall(call, { keepCall: 0.1, keepResult: 0.1 }, { keepThreshold: 0.5 }).action).toBe('drop_call');
  });

  it('never touches a pinned call', () => {
    const decision = decideCall({ ...call, pinned: true }, { keepCall: 0, keepResult: 0 }, { keepThreshold: 0.5 });
    expect(decision.action).toBe('keep');
    expect(decision.reason).toBe('pinned');
  });
});

describe('compact', () => {
  it('drops results when the model says they are reproducible', async () => {
    const messages = transcript();
    const result = await compact(messages, answering(0.01), { preserveRecentMessages: 2 });
    expect(result.stats.callsDropped).toBeGreaterThan(0);
    expect(result.stats.charsAfter).toBeLessThan(result.stats.charsBefore);
  });

  it('keeps everything when the model says so', async () => {
    const messages = transcript();
    const result = await compact(messages, answering(0.99), { preserveRecentMessages: 2 });
    expect(result.stats.callsDropped).toBe(0);
    expect(result.stats.resultsDropped).toBe(0);
  });

  // A wrong keep costs context; a wrong drop destroys work that cannot be
  // recovered. One flaky request must therefore never delete anything.
  it('keeps a call whose request failed', async () => {
    let n = 0;
    const flaky: Asker = {
      async ask(_s, questions) {
        n += 1;
        if (n === 1) throw new Error('connection reset');
        return { answers: Object.fromEntries(Object.keys(questions).map((k) => [k, { noul: 0.01 }])) };
      },
    };
    const result = await compact(transcript(), flaky, { preserveRecentMessages: 2, concurrency: 1 });
    expect(result.stats.failedRequests).toBe(1);
    const failedDecision = result.decisions.find((d) => d.keepCall === 1 && d.keepResult === 1);
    expect(failedDecision?.action).toBe('keep');
  });

  it('throws when the sidecar is down, so the host falls back to built-in compaction', async () => {
    const dead: Asker = { async ask() { throw new Error('ECONNREFUSED'); } };
    await expect(compact(transcript(), dead, { preserveRecentMessages: 2 })).rejects.toThrow(/ECONNREFUSED/);
  });

  it('reports no truncation for states inside the budget', async () => {
    const asker: Asker = {
      async ask(_s, questions) {
        const keys = Object.keys(questions);
        return {
          answers: Object.fromEntries(keys.map((k) => [k, { noul: 0.9 }])),
          usage: { input_tokens: 700 * keys.length },
          routing: { model: 'multilingual' },
        };
      },
    };
    const result = await compact(transcript(), asker, { preserveRecentMessages: 2 });
    expect(result.stats.truncatedRequests).toBe(0);
    expect(result.stats.maxRowTokens).toBe(700);
    expect(result.stats.checkpoint).toBe('multilingual');
  });

  it('flags truncation when a row reads the whole context', async () => {
    const asker: Asker = {
      async ask(_s, questions) {
        const keys = Object.keys(questions);
        return {
          answers: Object.fromEntries(keys.map((k) => [k, { noul: 0.9 }])),
          usage: { input_tokens: 1024 * keys.length },
          routing: { model: 'multilingual' },
        };
      },
    };
    const result = await compact(transcript(), asker, { preserveRecentMessages: 2 });
    expect(result.stats.truncatedRequests).toBeGreaterThan(0);
  });
});

describe('applyDecisions', () => {
  it('returns untouched messages as the same objects', () => {
    const messages = transcript();
    const kept = applyDecisions(messages, [], collectToolCalls(messages, 2), 300);
    expect(kept[0]).toBe(messages[0]);
  });
});

describe('pool', () => {
  it('preserves order and respects the limit', async () => {
    let inFlight = 0;
    let peak = 0;
    const out = await pool([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return n * 2;
    });
    expect(out).toEqual([2, 4, 6, 8, 10, 12, 14]);
    expect(peak).toBeLessThanOrEqual(3);
  });
});

describe('FeatureAsker', () => {
  it('scores without a network call and answers every question asked', async () => {
    const messages = transcript();
    const result = await compact(messages, new FeatureAsker(), { preserveRecentMessages: 2 });
    expect(result.stats.failedRequests).toBe(0);
    expect(result.stats.requests).toBeGreaterThan(0);
    expect(result.decisions).toHaveLength(collectToolCalls(messages, 2).length);
  });

  // The signal the whole scorer rests on: an Edit's "file updated" is never
  // needed verbatim, while a long file read often is.
  it('ranks a long Read above an Edit acknowledgement', async () => {
    const messages = transcript();
    const calls = collectToolCalls(messages, 2);
    const contexts = callContexts(calls, messages.length);
    const asker = new FeatureAsker();
    const scoreOf = async (tool: string) => {
      const call = calls.find((c) => c.tool === tool)!;
      const { state } = buildCallState(call, contexts.get(call.id)!, 'goal', 700);
      const response = await asker.ask(state, questionsFor(call));
      return (response.answers[`result_${call.id}`] as { noul: number }).noul;
    };
    expect(await scoreOf('Read')).toBeGreaterThan(await scoreOf('Edit'));
  });

  it('reads the tool name back out of the state prose', () => {
    const state = 'Task: x\n\nThe assistant ran the Bash tool with the command ls. That happened just now.';
    expect(toolFromState(state)).toBe('Bash');
    expect(toolFromState('nothing here')).toBe('');
  });

  it('produces calibrated-range probabilities, never 0 or 1', async () => {
    const asker = new FeatureAsker();
    const { answers } = await asker.ask('The assistant ran the Read tool on the file a.ts.', {
      result_t1: { type: 'noul', instructions: 'x' },
      call_t1: { type: 'noul', instructions: 'x' },
    });
    for (const answer of Object.values(answers)) {
      const noul = (answer as { noul: number }).noul;
      expect(noul).toBeGreaterThan(0);
      expect(noul).toBeLessThan(1);
    }
  });
});

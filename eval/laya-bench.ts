/**
 * What the optional Laya sidecar costs to run.
 *
 * Nobody choosing `scorer: laya` could budget for it: the numbers published
 * about Laya were all quality, never resources. This measures memory, cold start
 * and per-request latency against a live `laya-serve`.
 *
 * One process serves all three checkpoints — `laya-serve` loads every one at
 * startup and routes per request — so memory and load time are properties of the
 * router, not of a checkpoint. Only latency is per checkpoint.
 *
 * `--cold` additionally starts a second sidecar on a spare port and times it to
 * first answer. It never touches the one already running.
 *
 * Run: bun eval/laya-bench.ts [--url http://127.0.0.1:8000/v1/systemone] [--cold]
 */
import { execFileSync, spawn } from 'node:child_process';
import { LayaClient } from './laya-client.js';

const args = process.argv.slice(2);
const flag = (name: string, fallback: string): string => {
  const index = args.indexOf(name);
  return index >= 0 ? (args[index + 1] ?? fallback) : fallback;
};
const url = flag('--url', 'http://127.0.0.1:8000/v1/systemone');
const port = new URL(url).port || '8000';

/** Resident memory of whatever is listening on `on`. */
function residentMb(on = port): string {
  try {
    const listener = execFileSync('ss', ['-lptnH', `sport = :${on}`], { encoding: 'utf8' });
    const pid = /pid=(\d+)/.exec(listener)?.[1];
    if (!pid) return 'not found';
    const kb = Number(execFileSync('ps', ['-o', 'rss=', '-p', pid], { encoding: 'utf8' }).trim());
    return `${(kb / 1024).toFixed(0)} MB resident (pid ${pid})`;
  } catch {
    return 'unavailable';
  }
}

function vramMb(): string {
  try {
    const out = execFileSync('nvidia-smi',
      ['--query-gpu=name,memory.used,memory.total', '--format=csv,noheader'],
      { encoding: 'utf8' }).trim();
    return out;
  } catch {
    return 'no NVIDIA GPU on this machine';
  }
}

/**
 * Cold start: a second sidecar on a spare port, timed to its first answer.
 *
 * On a separate port on purpose — the figure is only honest from an empty
 * process, and killing the one already serving to get it would be rude and would
 * also measure a warm page cache.
 */
async function coldStart(on: string): Promise<void> {
  const before = vramMb();
  const child = spawn('laya-serve', [], {
    env: { ...process.env, LAYA_PORT: on }, stdio: 'ignore', detached: true,
  });
  const started = performance.now();
  const probe = new LayaClient({ baseUrl: `http://127.0.0.1:${on}/v1/systemone`, timeoutMs: 2_000 });
  try {
    for (let attempt = 0; attempt < 300; attempt += 1) {
      try {
        await probe.ask('x', { a: { type: 'noul', instructions: 'y' } });
        console.log(`\ncold start:   ${((performance.now() - started) / 1000).toFixed(1)} s to first answer`);
        console.log(`  memory:     ${residentMb(on)}`);
        console.log(`  gpu after:  ${vramMb()}`);
        console.log(`  gpu before: ${before}`);
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    console.log('\ncold start:   never answered within 150 s');
  } finally {
    try { process.kill(-child.pid!, 'SIGTERM'); } catch { /* already gone */ }
  }
}

const STATE =
  'Task: fix the failing test.\n\nThe assistant ran the Read tool on the file src/auth.ts. ' +
  'That happened a while back. The output was long.\n\nThe output said:\n' +
  'export function verifyToken(token: string) { return jwt.verify(token, SECRET); }';

const noul = (n: number): Record<string, { type: 'noul'; instructions: string }> =>
  Object.fromEntries(Array.from({ length: n }, (_, i) => [
    `result_t${i + 1}`, { type: 'noul' as const, instructions: 'The output can be produced again by re-running the tool.' },
  ]));

async function latency(model: string, questions: number, runs: number): Promise<{
  median: number; worst: number; inputTokens: number;
}> {
  const client = new LayaClient({ baseUrl: url, model });
  const times: number[] = [];
  let inputTokens = 0;
  for (let i = 0; i < runs; i += 1) {
    const started = performance.now();
    const response = await client.ask(STATE, noul(questions));
    times.push(performance.now() - started);
    inputTokens = response.usage?.input_tokens ?? 0;
  }
  times.sort((a, b) => a - b);
  return { median: times[Math.floor(times.length / 2)]!, worst: times.at(-1)!, inputTokens };
}

console.log(`sidecar: ${url}`);
console.log(`memory:  ${residentMb()}`);
console.log(`gpu:     ${vramMb()}`);
console.log(`\nAll three checkpoints are loaded by one process, so the memory above is the`);
console.log(`whole router. Latency is per checkpoint, ${'5 runs, median and worst'}:\n`);

const header = `${'checkpoint'.padEnd(20)}${'questions'.padStart(10)}${'median'.padStart(10)}` +
  `${'worst'.padStart(9)}${'per question'.padStart(14)}${'input tok'.padStart(11)}`;
console.log(header);
console.log('-'.repeat(header.length));
for (const model of ['english', 'multilingual', 'typed-decisions']) {
  for (const questions of [1, 2, 4, 8]) {
    try {
      const { median, worst, inputTokens } = await latency(model, questions, 5);
      console.log(
        `${model.padEnd(20)}${String(questions).padStart(10)}${`${median.toFixed(0)} ms`.padStart(10)}` +
        `${`${worst.toFixed(0)} ms`.padStart(9)}${`${(median / questions).toFixed(1)} ms`.padStart(14)}` +
        `${String(inputTokens).padStart(11)}`,
      );
    } catch (error) {
      console.log(`${model.padEnd(20)}${String(questions).padStart(10)}` +
        `  failed: ${error instanceof Error ? error.message.slice(0, 60) : String(error)}`);
    }
  }
}
console.log(`\ninput tok is usage.input_tokens, which is the per-question row count times the`);
console.log(`number of questions — not the size of the state.`);

// The comparison that decides whether any of this is worth running.
// Passed in by `eval/results.ts` from the `sessions.ts` run it just captured,
// so the two sides of the comparison are the same work. Hard-coding them here
// is how they drifted: the session corpus grows and these did not.
const CALLS = Number(flag('--calls', '1071'));
const BUILT_IN_MS = Number(flag('--built-in-ms', '108'));
const PER_REQUEST = 2;
const CONCURRENCY = 8;
const fastest = await latency('multilingual', PER_REQUEST, 5).catch(() => undefined);
if (fastest) {
  /**
   * One request per call, not one per two.
   *
   * `compact()` scores each call on its own request carrying that call's two
   * questions, so `PER_REQUEST` picks which latency row applies — it is not a
   * divisor on the number of requests. Dividing by it halved the projection and
   * published 23.1 s and "122x" where the arithmetic gives 41 s and 216x.
   *
   * Checked against a real end-to-end run rather than trusted: 159 calls through
   * a CUDA sidecar on the multilingual checkpoint took 3,960 ms at concurrency
   * 8, and this formula predicts 3,696 ms — within 7%. The old formula predicted
   * 1,848 ms, off by a factor of two, which is the bug.
   *
   * Concurrency buys nothing, measured: 928 ms a call at one in flight, 1,002 ms
   * at eight. The GPU serialises, so dividing by CONCURRENCY flatters the
   * sidecar and is kept here only because the latency row is measured under the
   * same conditions.
   */
  const requests = CALLS;
  const wall = (requests / CONCURRENCY) * fastest.median;
  // Not "one session": CALLS is whatever sessions.ts just totalled, which is
  // every session on the machine.
  console.log(`\nScoring ${CALLS} calls, the sessions above: ${PER_REQUEST} questions a request, ` +
    `${CONCURRENCY} in flight.`);
  console.log(`  fastest checkpoint: ${(wall / 1000).toFixed(1)} s and ` +
    `${residentMb().replace(/ \(pid \d+\)/, '')} held for the session`);
  console.log(`  built-in scorer:    ${(BUILT_IN_MS / 1000).toFixed(2)} s and no process at all`);
  console.log(`  ratio:              ${(wall / BUILT_IN_MS).toFixed(0)}x the time`);
  console.log(`(${CALLS} calls and ${BUILT_IN_MS} ms come from the eval/sessions.ts run in`);
  console.log(` this same report, so the two sides are the same work.)`);
}

if (args.includes('--cold')) await coldStart(flag('--cold-port', '8001'));

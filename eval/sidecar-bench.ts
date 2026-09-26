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
 * THE DEVICE IS THE MEASUREMENT. Every figure this script published once was
 * taken against a sidecar started with `LAYA_DEVICE=cpu`, on a machine with an
 * idle RTX 4060 — and the proof was printed two lines above the table, as
 * `gpu: ... 148 MiB`. Nobody read it, and "319x the time" reached the landing
 * page. So the device is now checked, not printed: `/health` reports it in one
 * field, and a CPU sidecar refuses to produce publishable numbers unless
 * `--allow-cpu` is passed, which labels every row it prints.
 *
 * `--inprocess` measures the other half. `laya-serve` exposes `/health` and
 * `/v1/systemone` and nothing else, so one HTTP round trip per call is the
 * slowest path Laya has; `Agent.predict_batch` packs many states into shared
 * forward passes and is the fastest. A cost figure that quotes only the first
 * is not a cost figure for Laya, it is a cost figure for this deployment of it.
 *
 * Run: bun eval/sidecar-bench.ts [--url ...] [--cold] [--inprocess] [--allow-cpu]
 */
import { execFileSync, spawn } from 'node:child_process';
import { LayaClient } from './sidecar-client.js';

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

/** What the sidecar says about itself. One request, before anything is timed. */
async function health(): Promise<{ device: string; loaded: string[] }> {
  const response = await fetch(new URL('/health', url), { signal: AbortSignal.timeout(5_000) });
  const body = await response.json() as { device?: unknown; loaded?: unknown };
  return {
    device: typeof body.device === 'string' ? body.device : 'unknown',
    loaded: Array.isArray(body.loaded) ? body.loaded.map(String) : [],
  };
}

/**
 * Refuse to publish a CPU number as the cost of running Laya.
 *
 * This is the whole reason the script was wrong: a resource benchmark whose
 * result is dominated by which device it ran on, printing the device as
 * decoration rather than treating it as a precondition.
 */
function requireAccelerator(device: string): void {
  if (device !== 'cpu') return;
  if (args.includes('--allow-cpu')) {
    console.log('\nNOTE: --allow-cpu. Every latency row below is a CPU measurement and is');
    console.log('      NOT the cost of running Laya. Do not publish it as one.\n');
    return;
  }
  console.error(`the sidecar at ${url} reports device "cpu".`);
  console.error('Latency measured there is a property of this deployment, not of Laya:');
  console.error('publishing it once produced the "319x the time" figure on the page.');
  console.error('Restart it with LAYA_DEVICE=cuda, or pass --allow-cpu to label the rows.');
  process.exit(1);
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

const reported = await health();
console.log(`sidecar: ${url}`);
console.log(`device:  ${reported.device} (loaded: ${reported.loaded.join(', ') || 'none'})`);
console.log(`memory:  ${residentMb()}`);
console.log(`gpu:     ${vramMb()}`);
requireAccelerator(reported.device);
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

/**
 * The interpreter `laya-serve` itself runs under.
 *
 * Read off its shebang rather than hard-coded or assumed to be on `PATH`:
 * `laya` is commonly installed as a uv or pipx tool, so the `python3` in scope
 * here usually cannot import it, and guessing the venv path would rot.
 */
function layaPython(): string {
  const bin = execFileSync('sh', ['-c', 'command -v laya-serve'], { encoding: 'utf8' }).trim();
  const shebang = execFileSync('head', ['-1', bin], { encoding: 'utf8' }).trim();
  const interpreter = shebang.replace(/^#!\s*/, '').split(/\s+/)[0];
  if (!interpreter) throw new Error(`no interpreter in the shebang of ${bin}`);
  return interpreter;
}

/**
 * The paths the HTTP sidecar cannot take.
 *
 * `laya-serve` routes `/health` and `/v1/systemone` and nothing else, so over
 * HTTP every call is one state in one forward pass in one round trip. The
 * library has `Agent.predict_batch`, which packs many states into shared passes.
 * Quoting only the HTTP figure as "what Laya costs" measures this deployment,
 * not the model — which is the same mistake as measuring it on the wrong device,
 * one level up.
 */
function inProcess(device: string): string {
  const program = `
import json, time, sys
import laya
state = json.loads(sys.argv[1]); questions = json.loads(sys.argv[2]); device = sys.argv[3]
t = time.perf_counter()
agent = laya.load("convaiinnovations/laya", subfolder="multilingual", device=device)
load = time.perf_counter() - t
def median(xs): xs = sorted(xs); return xs[len(xs)//2]
agent.predict(state, questions)
single = median([(lambda t0: (agent.predict(state, questions), (time.perf_counter()-t0)*1000)[1])(time.perf_counter()) for _ in range(12)])
rows = [state]*32
agent.predict_batch(rows[:4], questions)
t = time.perf_counter(); agent.predict_batch(rows, questions); batch = (time.perf_counter()-t)*1000/32
print(json.dumps({"load": load, "single": single, "batch": batch}))
`;
  const out = execFileSync(layaPython(), ['-c', program, JSON.stringify(STATE), JSON.stringify(noul(PER_REQUEST)), device], {
    encoding: 'utf8', env: { ...process.env, HF_HUB_OFFLINE: '1', TQDM_DISABLE: '1' },
  });
  return out.trim().split('\n').at(-1)!;
}

/**
 * A sidecar of our own, on a spare port, so the wire cost can be measured on the
 * same device as everything else.
 *
 * One checkpoint, not all three: `LAYA_MODELS` keeps this to the ~1.4 GB the
 * ladder actually uses, which matters because the in-process measurement holds
 * its own copy of the same weights on the same 8 GB card.
 */
async function withSidecar<T>(device: string, on: string, body: (base: string) => Promise<T>): Promise<T | undefined> {
  const child = spawn('laya-serve', [], {
    env: { ...process.env, LAYA_PORT: on, LAYA_DEVICE: device, LAYA_MODELS: 'multilingual' },
    stdio: 'ignore', detached: true,
  });
  const base = `http://127.0.0.1:${on}/v1/systemone`;
  const probe = new LayaClient({ baseUrl: base, timeoutMs: 5_000 });
  try {
    for (let attempt = 0; attempt < 240; attempt += 1) {
      try {
        await probe.ask('x', { a: { type: 'noul', instructions: 'y' } });
        return await body(base);
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    return undefined;
  } finally {
    try { process.kill(-child.pid!, 'SIGTERM'); } catch { /* already gone */ }
  }
}

if (args.includes('--inprocess')) {
  const device = flag('--inprocess-device', 'cuda');
  console.log(`\nthe same work off the wire, ${PER_REQUEST} questions a state, ` +
    `multilingual on ${device}:`);
  try {
    const { load, single, batch } = JSON.parse(inProcess(device)) as
      { load: number; single: number; batch: number };
    const wire = await latency('multilingual', PER_REQUEST, 5).catch(() => undefined);
    const wireOnDevice = await withSidecar(device, flag('--ladder-port', '8002'), async (base) => {
      const client = new LayaClient({ baseUrl: base, model: 'multilingual' });
      const times: number[] = [];
      for (let i = 0; i < 7; i += 1) {
        const started = performance.now();
        await client.ask(STATE, noul(PER_REQUEST));
        times.push(performance.now() - started);
      }
      times.sort((a, b) => a - b);
      return times[Math.floor(times.length / 2)]!;
    }).catch(() => undefined);
    const rows: [string, number][] = [
      ...(wire ? [[`over HTTP on ${reported.device}, ${reported.loaded.length} resident`,
        wire.median] as [string, number]] : []),
      ...(wireOnDevice ? [[`over HTTP on ${device}, 1 resident`, wireOnDevice] as [string, number]] : []),
      [`in process on ${device}, one call at a time`, single],
      [`in process on ${device}, predict_batch(32)`, batch],
    ];
    const slowest = Math.max(...rows.map(([, ms]) => ms));
    console.log(`${'path'.padEnd(44)}${'per call'.padStart(11)}${'vs slowest'.padStart(12)}`);
    console.log('-'.repeat(67));
    for (const [name, ms] of rows) {
      console.log(`${name.padEnd(44)}${`${ms.toFixed(1)} ms`.padStart(11)}` +
        `${`${(slowest / ms).toFixed(1)}x`.padStart(12)}`);
    }
    console.log(`(model resident in ${load.toFixed(1)} s from a warm HF cache)`);
  } catch (error) {
    console.log(`  unavailable: ${error instanceof Error ? error.message.slice(0, 120) : String(error)}`);
  }
}

if (args.includes('--cold')) await coldStart(flag('--cold-port', '8001'));

/**
 * Study 18 — tool proposals: which re-created scripts are worth turning into a tool?
 *
 * `eval/tool-mining.ts` showed 17% of Bash calls create an ad-hoc script but grouped
 * them by filename, so 831 unrelated `python3 -c` one-liners collapsed into one blob.
 * This groups by PURPOSE instead — `toolSignature` signs a script by the modules it
 * imports and functions it calls — so the question becomes answerable: how many
 * DISTINCT tasks are re-created often enough (>= MIN_TIMES, in >= 2 sessions) to be
 * worth a durable tool? Ranks them by `estimateSaved`, the same currency the skill
 * proposer uses, and emits the counts.
 *
 * Exploration over local transcripts (~/.claude/projects); aggregates only (the
 * signatures are module/function names, already redaction-filtered — no literals,
 * no content). Run: bun eval/tool-proposals.ts [--write] [--min N]
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { toolSignature, estimateSaved } from '../src/signals.js';

const args = process.argv.slice(2);
const MIN_TIMES = ((): number => { const i = args.indexOf('--min'); return i >= 0 ? Number(args[i + 1]) : 3; })();
const MIN_SESSIONS = 2;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const f = join(dir, e);
    try { statSync(f).isDirectory() ? out.push(...walk(f)) : (e.endsWith('.jsonl') && out.push(f)); } catch { /* skip */ }
  }
  return out;
}

interface Cluster { n: number; calls: number; chars: number; sessions: Set<string> }

function main() {
  const root = join(homedir(), '.claude', 'projects');
  let files: string[] = [];
  try { files = walk(root); } catch { console.log('no ~/.claude/projects'); return; }
  const clusters = new Map<string, Cluster>();
  let bashCalls = 0, scripts = 0;
  for (const f of files) {
    const session = f.replace(root + '/', '');
    const outLen = new Map<string, number>(); // tool_use_id -> result chars
    const bashCmds: { id: string; cmd: string }[] = [];
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let o: any; try { o = JSON.parse(line); } catch { continue; }
      const content = o?.message?.content;
      if (!Array.isArray(content)) continue;
      for (const b of content) {
        if (b?.type === 'tool_use' && b?.name === 'Bash' && typeof b?.input?.command === 'string') bashCmds.push({ id: b.id, cmd: b.input.command });
        if (b?.type === 'tool_result') {
          const t = typeof b.content === 'string' ? b.content : Array.isArray(b.content) ? b.content.map((x: any) => x?.text ?? '').join('') : '';
          if (b.tool_use_id) outLen.set(b.tool_use_id, t.length);
        }
      }
    }
    for (const { id, cmd } of bashCmds) {
      bashCalls += 1;
      const sig = toolSignature(cmd);
      if (!sig) continue;
      scripts += 1;
      const c = clusters.get(sig) ?? { n: 0, calls: 0, chars: 0, sessions: new Set<string>() };
      c.n += 1; c.calls += 1; c.chars += outLen.get(id) ?? 0; c.sessions.add(session);
      clusters.set(sig, c);
    }
  }
  const ranked = [...clusters.entries()]
    .map(([sig, c]) => ({ sig, n: c.n, sessions: c.sessions.size, saved: estimateSaved(c.n, c.calls / c.n, c.chars / c.n) }))
    .sort((a, b) => b.saved - a.saved);
  const proposals = ranked.filter((r) => r.n >= MIN_TIMES && r.sessions >= MIN_SESSIONS);

  console.log(`transcripts: ${files.length}   Bash calls: ${bashCalls}   ad-hoc scripts: ${scripts} (${(100 * scripts / Math.max(1, bashCalls)).toFixed(1)}%)`);
  console.log(`distinct PURPOSE clusters: ${clusters.size}   proposable (>=${MIN_TIMES} times, >=${MIN_SESSIONS} sessions): ${proposals.length}`);
  console.log(`\ntop tool proposals (n, sessions, saved, purpose):`);
  for (const r of proposals.slice(0, 12)) console.log(`  ${String(r.n).padStart(4)}  ${String(r.sessions).padStart(2)}s  ${String(Math.round(r.saved)).padStart(6)}  ${r.sig}`);
  const verdict = proposals.length >= 3
    ? `WORTH BUILDING — ${proposals.length} distinct tasks recur across sessions; purpose-clustering turns the 831-blob into ${clusters.size} nameable candidates, ${proposals.length} proposable.`
    : `THIN — few tasks recur across sessions once grouped by purpose; the repetition is mostly one-off scripts.`;
  console.log(`\nverdict: ${verdict}`);

  if (args.includes('--write')) {
    const fixture = {
      transcripts: files.length, bashCalls, scripts,
      scriptPct: Number((100 * scripts / Math.max(1, bashCalls)).toFixed(1)),
      clusters: clusters.size, proposable: proposals.length,
      top: proposals.slice(0, 8).map((r) => ({ purpose: r.sig, n: r.n, sessions: r.sessions, saved: Math.round(r.saved) })),
      verdict,
      note: 'aggregates only; signatures are module/function names (redaction-filtered), no literals or content. Local corpus — re-run eval/tool-proposals.ts.',
    };
    writeFileSync(join(import.meta.dirname, 'fixtures', 'tool-proposals.json'), JSON.stringify(fixture, null, 2) + '\n');
    console.log('\nwrote fixtures/tool-proposals.json');
  }
  return { clusters: clusters.size, proposable: proposals.length };
}

function selfCheck() {
  // Two same-purpose python one-liners (different literals) must land on one
  // cluster; an http-fetch one on another.
  const a = toolSignature(`python3 -c 'import json,sys; print(json.load(sys.stdin))'`);
  const b = toolSignature(`python3 -c "import sys,json; d=json.load(sys.stdin); print(d)"`);
  const c = toolSignature(`python3 -c 'import urllib.request; urllib.request.urlopen("x")'`);
  console.assert(a && a === b && a !== c, `purpose clustering broke: ${a} / ${b} / ${c}`);
}

if (import.meta.main) { selfCheck(); main(); }
export { toolSignature };

/**
 * Study 6 — SkillOpt-style held-out payoff test for flow proposals.
 *
 * SkillOpt keeps a skill only if it improves HELD-OUT performance. We cannot run a
 * live A/B here (no way to replay a past session with a skill injected), so this
 * tests the necessary PREREQUISITE that a live A/B would need: do flows proposed
 * from PAST sessions actually recur in FUTURE, unseen sessions? If a proposal does
 * not recur on held-out data, no skill built from it can pay off, whatever the
 * A/B would say.
 *
 * Method: order parent sessions by time, split into an earlier "propose" half and
 * a later "held-out" half, replay each (reusing flow-proposals' extractor), propose
 * the reliable flows from the earlier half, and measure how many recur in the later
 * half — gated (>=2 sessions + actionable) vs ungated. Kept in RESULTS.md only.
 *
 * What this does NOT claim: realized time saved. A skill does not stop you running
 * the tools; its payoff is less re-derivation, which needs a live A/B to measure
 * and is bounded small. This measures predictive validity, the floor under any
 * payoff, not the payoff itself.
 *
 * Run: bun eval/skill-payoff.ts [--write] [--self-check]
 */
import { existsSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { type Aggregate, type Row } from '../hooks/kompact-signals.js';
import { isActionable, parentSession, replayFlows } from './flow-proposals.js';

const args = process.argv.slice(2);
const FLOW_KINDS = new Set(['sequence', 'orient', 'verify']);
const sigOf = (key: string): string => key.slice(key.indexOf('::') + 2);
const isFlow = (row: Row): boolean => FLOW_KINDS.has(row.kind);

function walk(root: string): { path: string; mtime: number }[] {
  const out: { path: string; mtime: number }[] = [];
  let entries: string[] = [];
  try { entries = readdirSync(root); } catch { return out; }
  for (const e of entries) {
    const p = join(root, e);
    try {
      const st = statSync(p);
      if (st.isDirectory()) out.push(...walk(p));
      else if (p.endsWith('.jsonl')) out.push({ path: p, mtime: st.mtimeMs });
    } catch { /* skip */ }
  }
  return out;
}

/** Proposed flow keys from an aggregate: gated (habit + actionable) or ungated. */
function proposals(a: Aggregate, gated: boolean): string[] {
  return Object.entries(a)
    .filter(([k, r]) => isFlow(r) && isActionable(sigOf(k)) && r.sessions.length >= (gated ? 2 : 1))
    .map(([k]) => k);
}

function main() {
  const root = join(homedir(), '.claude', 'projects');
  if (!existsSync(root)) { console.log('no corpus'); return; }
  // group transcripts by parent, earliest mtime per parent
  const byParent = new Map<string, { paths: string[]; first: number }>();
  for (const { path, mtime } of walk(root)) {
    const parent = parentSession(path);
    const g = byParent.get(parent) ?? { paths: [], first: mtime };
    g.paths.push(path); g.first = Math.min(g.first, mtime);
    byParent.set(parent, g);
  }
  const parents = [...byParent.entries()].sort((x, y) => x[1].first - y[1].first);
  if (parents.length < 4) { console.log(`only ${parents.length} parent sessions; too few to split`); return; }
  const cut = Math.ceil(parents.length / 2);
  const early = parents.slice(0, cut);
  const late = parents.slice(cut);

  const A: Aggregate = {}; const B: Aggregate = {};
  for (const [parent, g] of early) for (const p of g.paths) { try { replayFlows(A, p, parent); } catch { /* */ } }
  for (const [parent, g] of late) for (const p of g.paths) { try { replayFlows(B, p, parent); } catch { /* */ } }

  const substantial = (agg: Aggregate) => new Set(Object.values(agg).flatMap((r) => r.sessions)).size;
  const gatedProps = proposals(A, true);
  const ungatedProps = proposals(A, false);
  const recurred = (keys: string[]) => keys.filter((k) => B[k] && isFlow(B[k]!)).length;
  const gatedHits = recurred(gatedProps);
  const ungatedHits = recurred(ungatedProps);

  // Held-out flow occurrences the gated proposals account for, and the total.
  const heldOutFlowKeys = Object.entries(B).filter(([, r]) => isFlow(r));
  const heldOutTotalOcc = heldOutFlowKeys.reduce((s, [, r]) => s + r.n, 0);
  const addressed = gatedProps.reduce((s, k) => s + (B[k] && isFlow(B[k]!) ? B[k]!.n : 0), 0);

  const fixture = {
    parentSessions: parents.length,
    earlyParents: early.length,
    lateParents: late.length,
    proposeSideDistinctSessions: substantial(A),
    heldOutSideDistinctSessions: substantial(B),
    gatedProposals: gatedProps.length,
    gatedRecurredInHeldOut: gatedHits,
    gatedPredictivePrecisionPct: gatedProps.length ? Number((100 * gatedHits / gatedProps.length).toFixed(0)) : 0,
    ungatedProposals: ungatedProps.length,
    ungatedPredictivePrecisionPct: ungatedProps.length ? Number((100 * ungatedHits / ungatedProps.length).toFixed(0)) : 0,
    heldOutFlowOccurrences: heldOutTotalOcc,
    occurrencesAddressedByProposals: addressed,
    coveragePct: heldOutTotalOcc ? Number((100 * addressed / heldOutTotalOcc).toFixed(0)) : 0,
  };

  console.log(`\nparent sessions: ${fixture.parentSessions}  (propose ${fixture.earlyParents} -> held-out ${fixture.lateParents}, split by time)`);
  console.log(`distinct sessions with flows: propose ${fixture.proposeSideDistinctSessions}, held-out ${fixture.heldOutSideDistinctSessions}`);
  console.log(`\nproposals from the PROPOSE half:`);
  console.log(`  gated (>=2 sess + actionable): ${fixture.gatedProposals}  -> recurred in held-out: ${fixture.gatedRecurredInHeldOut}  (${fixture.gatedPredictivePrecisionPct}% predictive)`);
  console.log(`  ungated (any actionable flow): ${fixture.ungatedProposals}  -> ${fixture.ungatedPredictivePrecisionPct}% predictive`);
  console.log(`held-out flow occurrences covered by gated proposals: ${fixture.occurrencesAddressedByProposals}/${fixture.heldOutFlowOccurrences}  (${fixture.coveragePct}%)`);

  const powered = fixture.proposeSideDistinctSessions >= 3 && fixture.heldOutSideDistinctSessions >= 3;
  console.log(`\nverdict: ${!powered
    ? `UNDERPOWERED: only ${fixture.proposeSideDistinctSessions}/${fixture.heldOutSideDistinctSessions} sessions per side carry flows, so predictive precision (${fixture.gatedPredictivePrecisionPct}%) is not yet trustworthy. The held-out test is sound; the corpus is too thin to run it. Needs more diverse sessions (or a second operator) before the payoff question can be settled.`
    : fixture.gatedPredictivePrecisionPct >= 60
      ? `PREDICTIVE: gated proposals recur on held-out data (${fixture.gatedPredictivePrecisionPct}%), the prerequisite a real payoff needs; the gate also beats ungated (${fixture.ungatedPredictivePrecisionPct}%). Next: a live A/B for realized time saved.`
      : `WEAK: gated proposals mostly do NOT recur on held-out data (${fixture.gatedPredictivePrecisionPct}%), so a skill built from them would rarely apply again. No payoff to chase yet.`}`);
  console.log(`(This is predictive validity — the floor under any payoff. Realized time saved still needs a live A/B and is bounded small: a skill does not stop you running the tools.)`);

  if (args.includes('--write')) {
    const out = join(import.meta.dirname, 'fixtures', 'skill-payoff.json');
    writeFileSync(out, JSON.stringify(fixture, null, 2) + '\n');
    console.log(`\nwrote ${out}`);
  }
}

/** ponytail: self-check on the propose/recur logic, no corpus. */
function selfCheck() {
  const A: Aggregate = {
    'sequence::Read → Edit → Bash(npm test)': { kind: 'sequence', n: 6, calls: 18, chars: 0, sessions: ['s1', 's2'], samples: [], lastSeen: 1 },
    'sequence::Read → Glob → Grep': { kind: 'sequence', n: 3, calls: 9, chars: 0, sessions: ['s1', 's2'], samples: [], lastSeen: 1 },
    'sequence::Read → Edit → Write': { kind: 'sequence', n: 2, calls: 6, chars: 0, sessions: ['s1'], samples: [], lastSeen: 1 },
  };
  const B: Aggregate = {
    'sequence::Read → Edit → Bash(npm test)': { kind: 'sequence', n: 4, calls: 12, chars: 0, sessions: ['s3'], samples: [], lastSeen: 2 },
  };
  const g = proposals(A, true);
  // gated: needs >=2 sessions AND actionable. npm-test flow (2 sess, actionable) YES;
  // Glob/Grep (2 sess but NOT actionable) NO; Edit/Write (actionable but 1 sess) NO.
  if (g.length !== 1 || !g[0]!.includes('npm test')) throw new Error(`gated wrong: ${JSON.stringify(g)}`);
  const hits = g.filter((k) => B[k]).length;
  if (hits !== 1) throw new Error(`recurrence wrong: ${hits}`);
  const u = proposals(A, false);
  if (u.length !== 2) throw new Error(`ungated should be 2 actionable flows: ${JSON.stringify(u)}`);
}

selfCheck();
if (args.includes('--self-check')) console.log('self-check ok');
else main();

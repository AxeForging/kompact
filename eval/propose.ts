/**
 * What you keep doing, ranked, and drafts for the ones worth a skill.
 *
 *   npm run propose                   the report; writes nothing
 *   npm run propose -- --write 1,3    drafts those rows into .laya/proposals/
 *
 * The recorder (`hooks/laya-signals.ts`) has already classified everything as it
 * happened, so there are no detectors here — only ranking, rendering, and the
 * draft. That is the whole reason the recorder assigns a `kind` at record time
 * rather than storing raw events for something later to interpret.
 *
 * Two honesty constraints shape the output:
 *
 *   1. **The rank is a modelled estimate, not a measurement.** This project does
 *      not present modelled numbers as measured, so every input to it is printed
 *      on the same row and the formula is stated underneath. Any row can be
 *      recomputed by hand. No row says "saves nine minutes".
 *   2. **Corrections are ranked separately.** Their estimate is zero by
 *      construction — a correction costs no tool calls — and burying the
 *      highest-value signal at the bottom of a table sorted by a unit that does
 *      not apply to it would be a presentation bug dressed as arithmetic.
 *
 * Drafts land in `.laya/proposals/`, which is not a directory Claude Code scans.
 * Promotion into a skills directory stays a human `mv`, deliberately: nothing
 * here has measured whether the skills it drafts are any good.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { estimateSaved } from '../src/signals.js';

type Kind = 'command' | 'sequence' | 'intent' | 'error-fix' | 'correction' | 'orient' | 'verify';

type Row = {
  kind: Kind;
  n: number;
  calls: number;
  chars: number;
  sessions: string[];
  samples: string[];
  lastSeen: number;
};

export type Proposal = Row & {
  /** The signature, with its kind prefix removed. */
  sig: string;
  /** Modelled: total calls plus total output in thousands of characters. */
  saved: number;
};

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const num = (name: string, fallback: number): number => {
  const value = flag(name);
  return value === undefined ? fallback : Number(value);
};

const FILE = flag('--file') ?? join(homedir(), '.claude', 'laya-signals.json');
/** Three times, in two sessions, is the lowest bar that reads as a habit. */
const MIN_TIMES = num('--min', 3);
const MIN_SESSIONS = num('--min-sessions', 2);
const TOP = num('--top', 12);
const WRITE = flag('--write');
const PROPOSALS_DIR = resolve('.laya/proposals');

/** What the kinds mean in the report, and which of them rank on saved work. */
const KINDS: Record<Kind, { label: string; ranked: boolean }> = {
  command: { label: 'the same command', ranked: true },
  sequence: { label: 'the same run of tools', ranked: true },
  'error-fix': { label: 'got working on a retry', ranked: true },
  orient: { label: 'rebuilding context at the start', ranked: true },
  verify: { label: 'checked before handing back', ranked: true },
  intent: { label: 'the same request', ranked: true },
  correction: { label: 'had to correct the assistant', ranked: false },
};

export function readRows(file: string): Record<string, Row> {
  const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (!parsed || typeof parsed !== 'object') return {};
  const rows = (parsed as { rows?: unknown }).rows;
  return rows && typeof rows === 'object' ? (rows as Record<string, Row>) : {};
}

/**
 * Ranks by the total work the repetition stood for.
 *
 * The store holds totals, so `occurrences × (calls each + chars each / 1000)`
 * reduces to the totals themselves — the occurrence count is already inside
 * them. The count is still printed, because a row worth 40 from 2 occurrences is
 * a different proposition from one worth 40 from 20.
 */
export function rank(rows: Record<string, Row>, minTimes: number, minSessions: number): Proposal[] {
  return Object.entries(rows)
    .map(([key, row]) => ({
      ...row,
      sig: key.slice(key.indexOf('::') + 2),
      saved: estimateSaved(row.n, row.calls / row.n, row.chars / row.n),
    }))
    .filter((row) => row.n >= minTimes && row.sessions.length >= minSessions)
    .sort((a, b) => b.saved - a.saved || b.n - a.n);
}

/** A kebab-case name the skill validator accepts: `[a-z0-9-]`, no trailing dash. */
export function slugFor(kind: Kind, sig: string): string {
  const base = `${kind === 'command' ? '' : `${kind}-`}${sig}`
    .toLowerCase()
    .replace(/<[a-z]+>/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 56)
    .replace(/-+$/, '');
  return base || 'repeated-work';
}

/** The signature as a phrase a sentence can contain. */
function describe(row: Proposal): string {
  const what = row.sig.replace(/\s+/g, ' ').trim().slice(0, 180);
  switch (row.kind) {
    case 'command': return `running \`${what}\``;
    case 'sequence': return `the sequence ${what}`;
    case 'error-fix': return `getting \`${what}\` to work after it failed`;
    case 'orient': return `starting a session with ${what}`;
    case 'verify': return `verifying with ${what} before handing back`;
    case 'correction': return `the correction "${what}"`;
    default: return `asking for ${what}`;
  }
}

/**
 * A draft SKILL.md.
 *
 * Frontmatter is `name` and `description` only. Those are the two fields every
 * loader requires, and the skill validator's allow-list is barely wider — so a
 * draft that helpfully added `version` or `source` would be a draft that fails
 * validation, and this is meant to be movable into a skills directory unedited.
 *
 * The description opens `Use when` and is third person, because it goes into the
 * system prompt and is the only part always loaded: it is what the model matches
 * on. The body is deliberately thin, and says so. Nothing here knows how the work
 * ought to be done — only that it keeps being done.
 */
export function draft(row: Proposal): string {
  const perOccurrence = row.calls / row.n;
  const description =
    `Use when the work matches ${describe(row)}. ` +
    `Recorded ${row.n} times across ${row.sessions.length} sessions on this machine` +
    // Below 1.5 this rounds to "about 1.0 tool calls each time", which tells the
    // model nothing it cannot infer from the word "command". Say it only when the
    // repetition costs more than one call.
    `${perOccurrence >= 1.5 ? `, about ${perOccurrence.toFixed(1)} tool calls each time` : ''}. ` +
    'Draft: the steps below have not been written yet.';
  // The validator's hard limit. `describe` already caps the signature, so this is
  // the belt behind that brace rather than the thing doing the work.
  const capped = description.length > 1024 ? `${description.slice(0, 1021)}...` : description;
  const samples = row.samples.length
    ? row.samples.map((sample) => `- \`${sample.replace(/`/g, "'")}\``).join('\n')
    : '- (no sample was kept for this shape)';

  return `---
name: ${slugFor(row.kind, row.sig)}
description: ${capped.replace(/[<>]/g, '')}
---

# ${describe(row)}

## Why this is here

\`npm run propose\` noticed it. The signature it was counted under:

\`\`\`
${row.sig}
\`\`\`

Seen **${row.n} times** across **${row.sessions.length} sessions**, standing for
${row.calls.toLocaleString()} tool calls and ${row.chars.toLocaleString()} characters of output in
total. Counts from this machine only; nothing was sent anywhere.

Redacted examples of what was grouped under that signature:

${samples}

## Steps

**This section is empty on purpose.** The recorder knows that you repeat this. It
does not know how you would rather it were done. Write the steps, delete this
paragraph, then move the directory into \`~/.claude/skills/\` — or delete it, if
seeing the repetition written down was the useful part.
`;
}

function table(title: string, rows: Proposal[], offset: number): void {
  if (rows.length === 0) return;
  console.log(`\n${title}`);
  console.log(`  ${'#'.padStart(3)}  ${'times'.padStart(5)} ${'sess'.padStart(4)} ` +
    `${'calls'.padStart(6)} ${'chars'.padStart(9)} ${'est.'.padStart(7)}  what`);
  rows.forEach((row, index) => {
    console.log(`  ${String(offset + index + 1).padStart(3)}  ` +
      `${String(row.n).padStart(5)} ${String(row.sessions.length).padStart(4)} ` +
      `${String(row.calls).padStart(6)} ${row.chars.toLocaleString().padStart(9)} ` +
      `${row.saved.toFixed(1).padStart(7)}  ${KINDS[row.kind].label}: ${row.sig.slice(0, 54)}`);
  });
}

function main(): void {
  let rows: Record<string, Row>;
  try {
    rows = readRows(FILE);
  } catch {
    console.log(`No signals recorded yet — nothing at ${FILE}.\n`);
    console.log('The recorder is a hook, so it only sees sessions from the moment it is');
    console.log('installed. Install the plugin, work normally for a few sessions, then run this');
    console.log('again. It never mines transcripts you already have, by design.');
    return;
  }

  const ranked = rank(rows, MIN_TIMES, MIN_SESSIONS);
  const work = ranked.filter((row) => KINDS[row.kind].ranked).slice(0, TOP);
  const corrections = ranked.filter((row) => !KINDS[row.kind].ranked).slice(0, TOP);

  console.log(`Run: ${FILE}`);
  console.log(`${Object.keys(rows).length} shapes recorded; ` +
    `${ranked.length} seen ${MIN_TIMES}+ times in ${MIN_SESSIONS}+ sessions.`);

  if (work.length === 0 && corrections.length === 0) {
    console.log('\nNothing has repeated enough to propose yet. Lower the bar with ' +
      '`--min 2 --min-sessions 1` to see what is close.');
    return;
  }

  table('What repeating costs you', work, 0);
  console.log('\n  est. = total tool calls + total output characters / 1000. A model of effort,');
  console.log('  not a measurement of time, and every input to it is on the row.');

  table('What you keep having to correct', corrections, work.length);
  if (corrections.length > 0) {
    console.log('\n  Not ranked by est. — a correction costs no tool calls, so its estimate is 0');
    console.log('  by construction. These usually want a line in CLAUDE.md, not a skill.');
  }

  if (!WRITE) {
    console.log(`\nNothing written. \`npm run propose -- --write 1${work.length > 2 ? ',3' : ''}\` ` +
      'drafts those rows into .laya/proposals/.');
    return;
  }

  const all = [...work, ...corrections];
  const picked = WRITE.split(',')
    .map((part) => Number(part.trim()))
    .filter((index) => Number.isInteger(index) && index >= 1 && index <= all.length);
  if (picked.length === 0) {
    console.log(`\n--write wants row numbers from the tables above, 1 to ${all.length}.`);
    process.exitCode = 1;
    return;
  }

  console.log();
  const skillsDir = join(homedir(), '.claude', 'skills');
  for (const index of picked) {
    const row = all[index - 1] as Proposal;
    const path = join(PROPOSALS_DIR, slugFor(row.kind, row.sig), 'SKILL.md');
    // Never into a skills directory. Promotion is a human `mv`, because nothing
    // here has measured whether these drafts are worth having.
    if (path.startsWith(skillsDir)) throw new Error('refusing to write into a skills directory');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, draft(row));
    console.log(`wrote ${path}`);
  }
  console.log('\nDrafts only, and inert: .laya/proposals/ is not a directory Claude Code reads.');
  console.log('Write the steps, then move one into ~/.claude/skills/ if you agree with it.');
}

if (import.meta.main) main();

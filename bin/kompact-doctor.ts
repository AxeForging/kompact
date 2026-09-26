#!/usr/bin/env node
/**
 * Tells you whether kompact will actually run — before you trust it to.
 *
 *   npm run doctor        (or: bun bin/kompact-doctor.ts)
 *
 * The install has one failure mode that looks like success: the plugin installs,
 * the env var is missing or was set in the wrong shell, and it silently never
 * fires. Nothing on disk is wrong; you just get Claude Code's own summary and no
 * sign anything is amiss. This checks the four things that have to be true, in
 * the order they fail, and prints the fix for each.
 *
 * Read-only: it reads the environment, asks `claude` two questions, and scans
 * recent transcripts for the notice kompact prints. It writes nothing.
 *
 *   bun bin/kompact-doctor.ts --self-check   asserts the parsing logic
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** The version this was tested against; earlier is unknown, not known-bad. */
const TESTED_VERSION = '2.1.281';
/** kompact's own compaction notice — its presence proves the hook fired. */
const NOTICE = 'no summary (pass';

type Status = 'pass' | 'warn' | 'fail';
type Check = { status: Status; label: string; detail: string; fix?: string };

/** Numeric x.y.z compare. ponytail: naive, fine for Claude Code's scheme. */
export function versionAtLeast(have: string, want: string): boolean {
  const a = have.split('.').map((n) => parseInt(n, 10));
  const b = want.split('.').map((n) => parseInt(n, 10));
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (Number.isNaN(x)) return false;
    if (x !== y) return x > y;
  }
  return true;
}

/** First x.y.z found in a `claude --version` string, or undefined. */
export function parseVersion(text: string): string | undefined {
  return /(\d+\.\d+\.\d+)/.exec(text)?.[1];
}

/** Whether any of these transcript texts shows kompact having fired. */
export function firedIn(texts: readonly string[]): boolean {
  return texts.some((t) => t.includes(NOTICE));
}

function ask(cmd: string, args: string[]): string | undefined {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return undefined;
  }
}

function walk(dir: string, out: string[], limit: number): void {
  let entries: string[] = [];
  try { entries = readdirSync(dir); } catch { return; }
  for (const entry of entries) {
    if (out.length >= limit) return;
    const path = join(dir, entry);
    try {
      if (statSync(path).isDirectory()) walk(path, out, limit);
      else if (entry.endsWith('.jsonl')) out.push(path);
    } catch { /* a session being written can vanish mid-walk */ }
  }
}

function checkEnv(): Check {
  const on = process.env['CLAUDE_CODE_ENABLE_FUNCTION_HOOKS'] === '1';
  return on
    ? { status: 'pass', label: 'function hooks enabled', detail: 'CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1' }
    : {
      status: 'fail',
      label: 'function hooks enabled',
      detail: `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=${process.env['CLAUDE_CODE_ENABLE_FUNCTION_HOOKS'] ?? '(unset)'}`,
      fix: 'export CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 in your shell startup file, then start Claude '
        + 'Code from a NEW shell — the variable is read once at launch.',
    };
}

function checkVersion(): Check {
  const raw = ask('claude', ['--version']);
  if (raw === undefined) {
    return {
      status: 'warn', label: 'Claude Code version', detail: 'could not run `claude --version`',
      fix: 'Is the `claude` CLI on your PATH?',
    };
  }
  const version = parseVersion(raw);
  if (!version) return { status: 'warn', label: 'Claude Code version', detail: raw.trim() };
  return versionAtLeast(version, TESTED_VERSION)
    ? { status: 'pass', label: 'Claude Code version', detail: `${version} (tested: ${TESTED_VERSION}+)` }
    : {
      status: 'warn', label: 'Claude Code version',
      detail: `${version}; tested against ${TESTED_VERSION}+`,
      fix: `Below ${TESTED_VERSION} is unknown, not known-bad — but if nothing fires, upgrade first.`,
    };
}

function checkPlugin(): Check {
  const list = ask('claude', ['plugin', 'list']);
  if (list === undefined) {
    return {
      status: 'warn', label: 'plugin installed', detail: 'could not run `claude plugin list`',
    };
  }
  return /kompact/.test(list)
    ? { status: 'pass', label: 'plugin installed', detail: 'kompact is listed' }
    : {
      status: 'fail', label: 'plugin installed', detail: 'kompact not in `claude plugin list`',
      fix: 'claude plugin marketplace add AxeForging/kompact && claude plugin install kompact@kompact',
    };
}

function checkFired(): Check {
  const paths: string[] = [];
  walk(join(homedir(), '.claude', 'projects'), paths, 4000);
  const recent = paths
    .map((path) => ({ path, mtime: (() => { try { return statSync(path).mtimeMs; } catch { return 0; } })() }))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, 5)
    .map(({ path }) => { try { return readFileSync(path, 'utf8'); } catch { return ''; } });
  if (recent.length === 0) {
    return { status: 'warn', label: 'has fired', detail: 'no transcripts found yet to check' };
  }
  return firedIn(recent)
    ? { status: 'pass', label: 'has fired', detail: `saw "${NOTICE}…)" in a recent session` }
    : {
      status: 'warn', label: 'has fired', detail: 'no kompact notice in the last 5 sessions',
      fix: 'Expected once the three above pass and a compaction has happened. If they pass and this '
        + 'stays empty after a compaction, the build may predate function hooks.',
    };
}

function selfCheck(): void {
  const assert = (ok: boolean, msg: string): void => { if (!ok) throw new Error(`self-check: ${msg}`); };
  assert(versionAtLeast('2.1.281', '2.1.281'), 'equal versions');
  assert(versionAtLeast('2.2.0', '2.1.281'), 'higher minor');
  assert(!versionAtLeast('2.1.280', '2.1.281'), 'lower patch');
  assert(!versionAtLeast('2.0.999', '2.1.0'), 'lower minor');
  assert(parseVersion('2.1.281 (Claude Code)') === '2.1.281', 'parse version');
  assert(parseVersion('no version here') === undefined, 'no version');
  assert(firedIn(['... kept 34/212 messages, no summary (pass 1 of 6 ...']), 'detects notice');
  assert(!firedIn(['just an engine compact_boundary, no kompact notice']), 'ignores engine-only');
  console.log('self-check ok');
}

if (process.argv.includes('--self-check')) {
  selfCheck();
  process.exit(0);
}

const checks = [checkEnv(), checkVersion(), checkPlugin(), checkFired()];
const mark: Record<Status, string> = { pass: '✓', warn: '–', fail: '✗' };
console.log('\nkompact doctor\n');
for (const c of checks) {
  console.log(`  ${mark[c.status]} ${c.label.padEnd(22)} ${c.detail}`);
  if (c.fix) console.log(`      ${c.fix}`);
}
const failed = checks.filter((c) => c.status === 'fail').length;
console.log(failed === 0
  ? '\nAll clear. If a compaction still summarises silently, run this again right after it.\n'
  : `\n${failed} blocking issue${failed > 1 ? 's' : ''} above — fix ${failed > 1 ? 'them' : 'it'} and re-run.\n`);
process.exit(failed === 0 ? 0 : 1);

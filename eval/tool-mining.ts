/**
 * Prep for "propose tools, not just skills" — mine how often we re-create small
 * one-off scripts, BEFORE building any proposal surface (data first).
 *
 * A tool candidate is a Bash call that writes/runs an ad-hoc script: a heredoc
 * writing a *.py/.sh/.ts/.js, or an inline `python3 -c` / `node -e`. The question
 * this answers is only: is the repetition frequent enough to be worth a feature?
 * Signature = the script's target basename (heredoc/redirect) or `inline:<lang>`,
 * normalised so trivial name changes still group. Reports totals and recurrence.
 *
 * Exploration over local transcripts (~/.claude/projects), aggregates only, not CI.
 * Run: bun eval/tool-mining.ts
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const f = join(dir, e);
    try { statSync(f).isDirectory() ? out.push(...walk(f)) : (e.endsWith('.jsonl') && out.push(f)); } catch { /* skip */ }
  }
  return out;
}

/** Pull every Bash command string out of one Claude Code transcript. */
function bashCommands(path: string): string[] {
  const cmds: string[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let o: any; try { o = JSON.parse(line); } catch { continue; }
    const content = o?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (b?.type === 'tool_use' && b?.name === 'Bash' && typeof b?.input?.command === 'string') cmds.push(b.input.command);
    }
  }
  return cmds;
}

/** If this command creates/runs an ad-hoc script, return its signature, else null. */
function toolSignature(cmd: string): string | null {
  const heredoc = /(?:cat|tee)\s*>+\s*([^\s]+\.(?:py|sh|ts|js|mjs|rb|pl))\s*<</.exec(cmd)
    ?? />+\s*([^\s]+\.(?:py|sh|ts|js|mjs|rb|pl))\b/.exec(cmd);
  if (heredoc) {
    const base = heredoc[1]!.split('/').pop()!.replace(/[-_]?\d+/g, '').replace(/^_+/, '');
    return `script:${base}`;
  }
  if (/\bpython3?\s+-c\b/.test(cmd)) return 'inline:python';
  if (/\bnode\s+-e\b/.test(cmd)) return 'inline:node';
  if (/\bperl\s+-e\b/.test(cmd)) return 'inline:perl';
  return null;
}

function main() {
  const root = join(homedir(), '.claude', 'projects');
  const files = walk(root);
  let totalBash = 0, totalScript = 0;
  const bySig = new Map<string, { n: number; sessions: Set<string> }>();
  for (const f of files) {
    const session = f.replace(root + '/', '');
    for (const cmd of bashCommands(f)) {
      totalBash += 1;
      const sig = toolSignature(cmd);
      if (!sig) continue;
      totalScript += 1;
      const row = bySig.get(sig) ?? { n: 0, sessions: new Set<string>() };
      row.n += 1; row.sessions.add(session); bySig.set(sig, row);
    }
  }
  const ranked = [...bySig.entries()].sort((a, b) => b[1].n - a[1].n);
  const recurring = ranked.filter(([, v]) => v.n >= 2);
  console.log(`transcripts: ${files.length}   Bash calls: ${totalBash}   ad-hoc script creations: ${totalScript} (${(100 * totalScript / Math.max(1, totalBash)).toFixed(1)}% of Bash)`);
  console.log(`distinct script signatures: ${bySig.size}   recurring (>=2): ${recurring.length}`);
  console.log(`\ntop signatures by count (n, distinct sessions):`);
  for (const [sig, v] of ranked.slice(0, 15)) console.log(`  ${String(v.n).padStart(4)}  ${String(v.sessions.size).padStart(3)}s  ${sig}`);
  const worth = recurring.length >= 5 && totalScript / Math.max(1, totalBash) > 0.03;
  console.log(`\nverdict: ${worth
    ? `WORTH PURSUING — ${totalScript} ad-hoc scripts, ${recurring.length} shapes recur; a tool-proposal signal has real material.`
    : `THIN — repetition is not frequent/clustered enough yet to justify a tool-proposal feature.`}`);
}
main();

/**
 * A draft is meant to be moved into a skills directory unedited, so the
 * frontmatter it writes has to satisfy the skill validator's rules. Those are
 * narrow and easy to break by being helpful: adding a `version` field, or letting
 * an angle bracket through from a signature like `head -<n>`.
 *
 * `claude plugin validate` confirms this end to end, but it needs a plugin
 * manifest and a copy into a skills directory. These assert the same rules
 * mechanically, on every run.
 */
import { describe, expect, it } from 'vitest';

import { type Proposal, draft, rank, scaffoldTool, slugFor, toolSlug } from '../eval/propose.js';

const row = (over: Partial<Proposal> = {}): Proposal => ({
  kind: 'command',
  sig: 'npm test -- <path>',
  n: 7,
  calls: 7,
  chars: 12_000,
  sessions: ['s1', 's2'],
  samples: ['npm test -- test/auth.spec.ts'],
  lastSeen: 1,
  saved: 19,
  ...over,
});

/** The skill validator's own rules: kebab-case, 64 chars, no doubled dashes. */
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

describe('the name a draft gets', () => {
  it('is kebab-case and short enough for the validator', () => {
    for (const sig of [
      'npm test -- <path>',
      'gh run view <n> --log | tail -<n>',
      'Read → Bash(grep -n) → Bash(sed -n)',
      '<path>',
    ]) {
      const slug = slugFor('command', sig);
      expect(slug, sig).toMatch(NAME);
      expect(slug.length, sig).toBeLessThanOrEqual(64);
    }
  });

  it('never comes back empty, even from a signature of only placeholders', () => {
    expect(slugFor('command', '<path> <n>')).toMatch(NAME);
  });

  it('keeps two kinds of the same signature apart', () => {
    expect(slugFor('command', 'npm test')).not.toBe(slugFor('verify', 'npm test'));
  });
});

describe('the frontmatter a draft writes', () => {
  const frontmatter = (proposal: Proposal): { name: string; description: string } => {
    const text = draft(proposal);
    const block = text.slice(text.indexOf('---') + 3, text.indexOf('\n---', 3));
    const name = /name:\s*(.+)/.exec(block)?.[1]?.trim() ?? '';
    const description = /description:\s*(.+)/.exec(block)?.[1]?.trim() ?? '';
    return { name, description };
  };

  it('carries only name and description', () => {
    const text = draft(row());
    const block = text.slice(0, text.indexOf('\n---', 3));
    const keys = [...block.matchAll(/^([a-z-]+):/gm)].map((match) => match[1]);
    expect(keys.sort()).toEqual(['description', 'name']);
  });

  it('writes a name the validator accepts', () => {
    expect(frontmatter(row()).name).toMatch(NAME);
  });

  it('never lets an angle bracket into the description', () => {
    // `head -<n>` is an ordinary signature, and `<` is rejected there.
    const { description } = frontmatter(row({ sig: 'gh run view <n> --log | tail -<n>' }));
    expect(description).not.toContain('<');
    expect(description).not.toContain('>');
  });

  it('stays inside the 1024-character limit on a long signature', () => {
    const { description } = frontmatter(row({ sig: 'a-very-long-command '.repeat(60) }));
    expect(description.length).toBeLessThanOrEqual(1024);
  });

  it('opens with "Use when", which is what the model matches on', () => {
    expect(frontmatter(row()).description.startsWith('Use when ')).toBe(true);
  });
});

describe('the draft body', () => {
  it('shows the samples that were grouped, so a wrong grouping is visible', () => {
    expect(draft(row())).toContain('npm test -- test/auth.spec.ts');
  });

  it('says the steps are not written rather than inventing any', () => {
    expect(draft(row())).toContain('empty on purpose');
  });
});

describe('ranking', () => {
  const rows = {
    'command::a': { kind: 'command' as const, n: 9, calls: 9, chars: 0, sessions: ['s1', 's2'], samples: [], lastSeen: 2 },
    'command::b': { kind: 'command' as const, n: 4, calls: 80, chars: 0, sessions: ['s1', 's2'], samples: [], lastSeen: 1 },
    'command::rare': { kind: 'command' as const, n: 2, calls: 999, chars: 0, sessions: ['s1', 's2'], samples: [], lastSeen: 1 },
    'command::lonely': { kind: 'command' as const, n: 9, calls: 9, chars: 0, sessions: ['s1'], samples: [], lastSeen: 1 },
  };

  it('puts more total work above more occurrences', () => {
    const ranked = rank(rows, 3, 2);
    expect(ranked[0]?.sig).toBe('b');
  });

  it('drops what has not repeated enough, and what only happened once ever', () => {
    const sigs = rank(rows, 3, 2).map((proposal) => proposal.sig);
    expect(sigs, 'a two-occurrence row was proposed').not.toContain('rare');
    expect(sigs, 'a one-session row was proposed as a habit').not.toContain('lonely');
  });
});

describe('the tool scaffold a proposal creates', () => {
  const tool = (sig: string, over: Partial<Proposal> = {}): Proposal => ({
    kind: 'tool',
    sig,
    n: 17,
    calls: 17,
    chars: 11_391,
    sessions: ['s1', 's2'],
    samples: [],
    lastSeen: 1,
    saved: 28,
    ...over,
  });

  it('names the file after the purpose, kebab-cased, with the language extension', () => {
    const { filename } = scaffoldTool(tool('tool:python:json,json.load,load,sys'));
    expect(filename).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*\.py$/);
    expect(toolSlug('tool:node:fs,readFileSync')).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    // Never empty, even from a signature that is only punctuation.
    expect(toolSlug('tool:python:')).toMatch(/^[a-z0-9-]+$/);
  });

  it('writes a real, runnable script rather than a SKILL.md', () => {
    const { filename, content } = scaffoldTool(tool('tool:python:json,json.load,load,sys'));
    expect(filename.endsWith('.py')).toBe(true);
    expect(content.startsWith('#!/usr/bin/env python3')).toBe(true);
    // A stub that runs and fails until filled in, so a scaffold left untouched
    // cannot be mistaken for a working tool.
    expect(content).toContain('def main()');
    expect(content).toContain('raise SystemExit');
    // Not skill frontmatter.
    expect(content).not.toContain('description:');
  });

  it('carries the signature it was counted under and how to promote it', () => {
    const { content } = scaffoldTool(tool('tool:python:json,json.load,load,sys'));
    expect(content, 'the scaffold drops the purpose it was grouped by')
      .toContain('tool:python:json,json.load,load,sys');
    expect(content, 'the scaffold does not say how many times it was seen').toContain('17 times');
    expect(content, 'the scaffold does not say how to promote it onto PATH')
      .toContain('~/.local/bin/');
  });

  it('guesses the import from the dotted calls in the signature', () => {
    expect(scaffoldTool(tool('tool:python:json,json.load,load,sys')).content).toContain('import json');
    expect(scaffoldTool(tool('tool:python:is_available,torch,torch.cuda.is_available')).content)
      .toContain('import torch');
  });

  it('includes a kept sample when the store has one, so the author has a start', () => {
    const { content } = scaffoldTool(tool('tool:python:json,json.load,load,sys', {
      samples: ["python3 -c 'import json,sys; print(json.load(sys.stdin))'"],
    }));
    expect(content).toContain('print(json.load(sys.stdin))');
  });

  it('scaffolds node and an unfamiliar language rather than erroring', () => {
    const node = scaffoldTool(tool('tool:node:fs,readFileSync'));
    expect(node.filename.endsWith('.mjs')).toBe(true);
    expect(node.content.startsWith('#!/usr/bin/env node')).toBe(true);
    expect(node.content).toContain('function main()');
    // An unknown language still returns a file (falls back to python) instead of
    // throwing, so an odd signature scaffolds rather than crashing --write.
    expect(() => scaffoldTool(tool('tool:cobol:frobnicate'))).not.toThrow();
  });
});

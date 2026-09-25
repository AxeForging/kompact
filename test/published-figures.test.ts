/**
 * Every figure in the README, the page and the plugin manifest must match
 * `eval/RESULTS.md`, which `npm run eval:results` generates from the scripts.
 *
 * This test exists because hand-transcription drifted four separate times: the
 * published spread stayed 0.073 after a re-run made it 0.072 and then 0.073
 * again, the AUC retraction reached CONTRIBUTING but not the manifest an
 * installer reads, and the page carried "Freeing 66% of tokens" in a section
 * reporting 22%. Nothing catches that by review. Parsing the generated file and
 * asserting the prose agrees does.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path: string): string => readFileSync(join(root, path), 'utf8');
const results = read('eval/RESULTS.md');

/** `logistic (features)   0.905  0.078  0.684  0.944  0.044   35.4%` */
function scorerRow(name: string): { mean: string; sd: string; min: string; ece: string; drop: string } {
  const line = results.split('\n').find((l) => l.trimStart().startsWith(name));
  if (!line) throw new Error(`no row for ${name} in eval/RESULTS.md`);
  const [mean, sd, min, , ece, drop] = line.slice(name.length).trim().split(/\s+/);
  return { mean: mean!, sd: sd!, min: min!, ece: ece!, drop: drop! };
}

/** `budget 0.5, floor 0.10   42.5%  12  2  84.6%  87.5%` */
function policyRow(name: string): { freed: string; kept: string; charsKept: string } {
  const line = results.split('\n').find((l) => l.trimStart().startsWith(name));
  if (!line) throw new Error(`no policy row for ${name} in eval/RESULTS.md`);
  const [freed, , , kept, charsKept] = line.slice(name.length).trim().split(/\s+/);
  return { freed: freed!, kept: kept!, charsKept: charsKept! };
}

/** `total   1282   1,131,093   882,442   22.0%   104ms` — the sessions block. */
function sessionsTotal(): { calls: string; freed: string; ms: string } | undefined {
  const line = results.split('\n').find((l) => /^total\s+\d/.test(l));
  if (!line) return undefined;
  const [, calls, , , freed, ms] = line.trim().split(/\s+/);
  return { calls: calls!, freed: freed!, ms: ms!.replace('ms', '') };
}

/** `multilingual   8   700 ms   773 ms   87.5 ms   792` — one latency cell. */
function latency(checkpoint: string, questions: number): string | undefined {
  return new RegExp(`^${checkpoint}\\s+${questions}\\s+(\\d+) ms`, 'm').exec(results)?.[1];
}

const scalar = (re: RegExp): string | undefined => re.exec(results)?.[1];

const sessions = sessionsTotal();
const bench = {
  coldStart: scalar(/cold start:\s+([\d.]+) s/),
  warmMb: scalar(/memory:\s+(\d+) MB resident/),
  coldMb: scalar(/memory:\s+(\d+) MB resident \(pid \d+\)\n  gpu after/),
  oneSession: scalar(/fastest checkpoint: ([\d.]+) s/),
  ratio: scalar(/ratio:\s+(\d+)x/),
  multilingual8: latency('multilingual', 8),
  english8: latency('english', 8),
  typed8: latency('typed-decisions', 8),
};

const logistic = scorerRow('logistic (features)');
const laya = scorerRow('laya typed-decisions/direct');
const sizeOnly = scorerRow('output size only');
const shipped = policyRow('budget 0.5, floor 0.20');
// The page prints four policy rows and only the shipped one was bound here, so
// the rejected policy sat at 97.6%/5.1%/8.5% against a measured 95.3%/8.9%/16.9%
// through a full regeneration that corrected ten other figures — every error in
// the direction that flattered the default it is there to be compared against.
const rejected = policyRow('threshold only, 0.5 (old)');
const alsoSwept = ['budget 0.6, floor 0.20', 'budget 0.7, floor 0.20'].map(policyRow);
const closest = /range ([\d.]+) to [\d.]+/.exec(results)?.[1];

describe('published figures match eval/RESULTS.md', () => {
  const quoting: Array<[string, string[]]> = [
    ['README.md', [
      `**${logistic.mean} ± ${logistic.sd}**`, `| ${logistic.min} |`, `**${logistic.drop}**`,
      `${laya.mean} ± ${laya.sd}`, `${sizeOnly.mean} ± ${sizeOnly.sd}`, `**+${closest}**`,
    ]],
    ['docs/index.html', [`± ${logistic.sd}`, `worst split ${logistic.min}`, `+${closest}`,
      `${sizeOnly.mean} with an`,
      // Every row of the policy table, not only the one the product ships.
      // `>x<` rather than a bare match, so it has to be a cell and not prose.
      ...[rejected, shipped, ...alsoSwept].flatMap(
        (row) => [row.freed, row.kept, row.charsKept].map((cell) => `>${cell}<`)),
    ]],
    ['.claude-plugin/plugin.json', [`${logistic.mean} \\u00b1 ${logistic.sd}`, `${laya.mean} \\u00b1 ${laya.sd}`]],
    ['src/features.ts', [`sd ${logistic.sd}`, `worst split ${logistic.min}`]],
    ['src/compact.ts', [shipped.freed, shipped.kept]],
    ['.claude-plugin/plugin.json', [shipped.kept]],
  ];

  for (const [path, figures] of quoting) {
    for (const figure of figures) {
      it(`${path} quotes ${figure}`, () => {
        expect(read(path)).toContain(figure);
      });
    }
  }

  // The blocks that drifted while this test watched the other two. Both are
  // generated into eval/RESULTS.md, which is committed, so this runs on a runner
  // even though neither measurement can be taken there.
  it('quotes the measured session totals, not an older corpus', () => {
    expect(sessions, 'eval/RESULTS.md has no sessions block').toBeDefined();
    const page = read('docs/index.html');
    expect(page, 'the page quotes a call count from an older corpus')
      .toContain(Number(sessions!.calls).toLocaleString('en-GB'));
    expect(page).toContain(`${sessions!.freed}`);
    expect(page).toContain(`${sessions!.ms} ms`);
  });

  // Not "every file must quote every figure" — a file may legitimately mention
  // only some. This fires where a file *does* make the claim and the value has
  // gone stale, which is exactly how the last four drifted.
  it('quotes no stale sidecar figure anywhere', () => {
    expect(bench.coldStart, 'eval/RESULTS.md has no sidecar block').toBeDefined();
    const claims: Array<[RegExp, string, string]> = [
      [/(\d+)x the time/g, bench.ratio!, 'ratio'],
      [/(\d+)\u00d7 the time/g, bench.ratio!, 'ratio'],
      [/([\d.]+) s to score a session/g, bench.oneSession!, 'one-session time'],
      [/takes \*\*([\d.]+) s on the fastest/g, bench.oneSession!, 'one-session time'],
      [/starts in ([\d.]+) s/g, bench.coldStart!, 'cold start'],
      [/([\d.]+) s to start/g, bench.coldStart!, 'cold start'],
      [/cold start to first answer \| \*\*([\d.]+) s\*\*/g, bench.coldStart!, 'cold start'],
      [/scorer scores in\s+(\d+) ms/g, sessions!.ms, 'built-in scoring time'],
      [/against (\d+) ms for the built-in/g, sessions!.ms, 'built-in scoring time'],
    ];
    for (const path of ['README.md', 'docs/index.html', 'CHANGELOG.md', 'skills/laya-compact/SKILL.md']) {
      const text = read(path);
      for (const [pattern, want, what] of claims) {
        for (const match of text.matchAll(pattern)) {
          expect(match[1], `${path} quotes a stale ${what}: "${match[0]}"`).toBe(want);
        }
      }
    }
  });

  it('quotes the measured latencies', () => {
    const page = read('docs/index.html');
    const readme = read('README.md');
    for (const ms of [bench.multilingual8!, bench.english8!, bench.typed8!]) {
      const pretty = Number(ms).toLocaleString('en-GB');
      expect(`${readme}\n${page}`, `no file quotes the measured ${ms} ms`)
        .toMatch(new RegExp(`\\b(${ms}|${pretty.replace(',', ',')})\\b`));
    }
  });

  it('states the number of tests it has', () => {
    const count = read('docs/index.html').match(/<b>(\d+)<\/b> tests/)?.[1];
    expect(count, 'the page states no test count').toBeDefined();
    expect(read('README.md'), 'README and the page disagree on the test count')
      .toContain(`# ${count} tests`);
  });

  /**
   * The demonstration used to ship an empty `<ol>` and a hard-coded `0`, so with
   * scripts blocked section 03 read "FREED 0 chars / DECIDED 0 of 9" beside a
   * dead button, under prose referring to "the list above". `eval/demo.ts` now
   * writes the settled rows into the markup; this is what stops that regressing.
   */
  describe('the demonstration is complete without scripts', () => {
    const page = read('docs/index.html');
    const data = read('docs/demo-data.js');
    const decisions: Array<{ freed: number; outcome: string; chars: number }> =
      JSON.parse(data.slice(data.indexOf('{'), data.lastIndexOf('}') + 1)).decisions;
    const freed = decisions.reduce((sum, d) => sum + d.freed, 0);

    it('renders every row into the page', () => {
      const rows = page.match(/<li class="demo__call" data-state="/g) ?? [];
      expect(rows.length, 'the <ol> ships empty; only JS fills it').toBe(decisions.length);
    });

    it('states each row outcome as text, not only as a data attribute', () => {
      for (const outcome of new Set(decisions.map((d) => d.outcome))) {
        expect(page).toContain(`<span class="demo__outcome">${outcome}</span>`);
      }
    });

    it('ships the real total, not a zero waiting to be filled in', () => {
      expect(page, 'the freed total ships as 0').not.toContain('id="d-freed">0<');
      expect(page).toContain(`id="d-freed">${freed.toLocaleString('en-GB')}<`);
      expect(page).toContain(`id="d-count">${decisions.length}<`);
    });

    // A control that cannot do anything is worse than no control.
    it('hides the replay button until the script that drives it runs', () => {
      expect(page).toMatch(/id="d-run" hidden/);
      expect(read('docs/index.html')).toContain('run.hidden = false;');
    });
  });

  // A figure that was corrected once tends to survive somewhere.
  const published = [
    'README.md', 'CONTRIBUTING.md', 'CHANGELOG.md', 'DESIGN-BRIEF.md', '.impeccable.md',
    'docs/index.html', '.claude-plugin/plugin.json', 'skills/laya-compact/SKILL.md',
    'src/features.ts', 'src/compact.ts', 'src/types.ts', 'hooks/laya-compact.ts',
  ];

  // These never meant anything: each is a value some earlier run produced for a
  // figure that later moved. No file has a reason to carry one.
  it('nowhere carries a spread from a superseded run', () => {
    for (const path of published) {
      for (const stale of ['0.687', '0.689', '0.690', '+0.002', '+0.003', '+0.005']) {
        if (stale === logistic.min || stale === `+${closest}`) continue;
        expect(read(path), `${path} still says ${stale}`).not.toContain(stale);
      }
    }
  });

  // These do mean something — as history. Retracted claims may be named by the
  // files that narrate the retraction, and nowhere else.
  it('states a retracted claim only where it is retracted', () => {
    const narrating = new Set([
      'README.md', 'CONTRIBUTING.md', 'CHANGELOG.md', '.impeccable.md', 'src/features.ts',
    ]);
    for (const path of published.filter((p) => !narrating.has(p))) {
      for (const retracted of ['0.918', '0.694', '50–88%', '66% of tokens']) {
        expect(read(path), `${path} still claims ${retracted}`).not.toContain(retracted);
      }
    }
  });
});

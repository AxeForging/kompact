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
// The figure an installer actually gets. It was quoted in six places and bound
// in none, because eval/RESULTS.md had no block for it until eval/fit.ts got one.
const loso = /result_needed: LOSO AUC ([\d.]+)\s+ECE ([\d.]+)/.exec(results);

describe('published figures match eval/RESULTS.md', () => {
  const quoting: Array<[string, string[]]> = [
    ['README.md', [
      `**${logistic.mean} ± ${logistic.sd}**`, `| ${logistic.min} |`, `**${logistic.drop}**`,
      `${laya.mean} ± ${laya.sd}`, `${sizeOnly.mean} ± ${sizeOnly.sd}`, `**+${closest}**`,
    ]],
    // The page bound the spread but not the mean beside it, so a typo in 0.905
    // would have survived on the one file a reader actually looks at.
    ['docs/index.html', [`${logistic.mean} <span`, `± ${logistic.sd}`,
      `worst split ${logistic.min}`, `+${closest}`, `${sizeOnly.mean} with an`,
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

  it('binds the generalisation figure, not only the headline one', () => {
    expect(loso, 'eval/RESULTS.md has no leave-one-session-out block').not.toBeNull();
    const [, auc, ece] = loso!;
    for (const path of ['docs/index.html', 'README.md', 'src/features.ts']) {
      expect(read(path), `${path} does not quote the LOSO AUC ${auc}`).toContain(auc!);
      expect(read(path), `${path} does not quote the LOSO ECE ${ece}`).toContain(ece!);
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

  // Four claims were promoted into the masthead and the FAQ in one editing pass
  // and none of them was bound to anything. They are all in the generated report;
  // being right once is not the same as staying right.
  it('binds the claims a later copy pass put in the masthead', () => {
    const page = read('docs/index.html');

    // `  ratio:              122x the time`
    const ratio = /ratio:\s+(\d+)x the time/.exec(results)?.[1];
    expect(ratio, 'eval/RESULTS.md no longer reports a latency ratio').toBeDefined();
    expect(page, `the report says ${ratio}x`).toContain(`${ratio}&#215;`);

    // `  logistic won 10/10 splits`
    const won = /logistic won (\d+)\/(\d+) splits/.exec(results);
    expect(won, 'eval/RESULTS.md no longer reports a paired win count').not.toBeNull();
    expect(page, `the report says ${won?.[1]} of ${won?.[2]}`)
      .toContain(`${won?.[1]} of ${won?.[2]} paired splits`);

    // `features: 13 (tool=Read, ...)` — the page said twelve in one place and
    // thirteen in another until this was checked against the source.
    const features = /^features: (\d+)/m.exec(results)?.[1];
    expect(features, 'eval/RESULTS.md no longer reports a feature count').toBeDefined();
    expect(page, `the scorer has ${features} coefficients`).toContain(`${features} coefficients`);
  });

  // The checkpoint comparison is the whole of README section 1b and a paragraph
  // of the FAQ. Every figure in it comes from one table.
  it('binds the checkpoint comparison to the results table', () => {
    const readme = read('README.md');
    const page = read('docs/index.html');
    for (const [config, where] of [
      ['laya english/direct', 'english on the wording that works'],
      ['laya multilingual/direct', 'multilingual on the same wording'],
      ['laya english/entailment', "english's best config"],
    ] as const) {
      const { mean } = scorerRow(config);
      expect(readme, `README no longer matches ${config} (${where}: ${mean})`).toContain(mean);
    }
    // The page quotes only the two that carry the argument.
    expect(page, 'the page no longer matches english/direct').toContain(scorerRow('laya english/direct').mean);
    expect(page, 'the page no longer matches multilingual/direct')
      .toContain(scorerRow('laya multilingual/direct').mean);
  });

  // The masthead claims a number of unverified claims. That is the page's most
  // unusual asset stated as a fact, so it has to stay true as the ledger changes —
  // and a hand-typed count beside a hand-maintained list is the oldest way for a
  // page to start lying slowly.
  it('counts its own unverified claims correctly', () => {
    const page = read('docs/index.html');
    const open = (page.match(/ledger__row--open/g) ?? []).length;
    expect(open, 'no unverified claims found, so this proves nothing').toBeGreaterThan(0);
    const claimed = /<b>(\d+)<\/b> claims <a href="#checked">not verified<\/a>/.exec(page)?.[1];
    expect(claimed, 'the masthead no longer states an unverified-claim count').toBeDefined();
    expect(Number(claimed), `the ledger holds ${open} unverified claims`).toBe(open);
  });

  // Three separate tag breakages in one editing pass — a summary with a closing
  // heading and no opening one, two headings never closed, and a stray bracket
  // left where a slice cut through a tag. None of them failed a test and the
  // browser rendered all three without complaint.
  it('has balanced markup for the elements that carry its structure', () => {
    const page = read('docs/index.html')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/g, '')
      .replace(/<script[^>]*>[\s\S]*?<\/script>/g, '');
    for (const tag of ['section', 'details', 'summary', 'h2', 'h3', 'dl', 'table']) {
      const open = (page.match(new RegExp(`<${tag}\\b`, 'g')) ?? []).length;
      const close = (page.match(new RegExp(`</${tag}\\s*>`, 'g')) ?? []).length;
      expect(open, `<${tag}> opened ${open} times and closed ${close}`).toBe(close);
    }
    expect(page, 'a slice cut through a tag').not.toMatch(/<\/?[a-z]+\b[^>]*\n\s*<\/?[a-z]+[^>]*>\s*>/);

    // Counting is not enough, which is how five mis-nested FAQ items passed this
    // test: every `</div>` closed its item while the `<details>` inside was still
    // open, so the counts balanced and the nesting interleaved. Chromium's error
    // recovery hid it, at the cost of 49px of dead space inside each question.
    const nested = ['section', 'details', 'summary', 'div', 'dl', 'ul', 'ol', 'table'];
    const stack: string[] = [];
    for (const [, close, name] of page.matchAll(/<(\/?)([a-z][a-z0-9]*)\b[^>]*>/g)) {
      if (!nested.includes(name as string)) continue;
      if (!close) stack.push(name as string);
      else {
        const top = stack.pop();
        expect(top, `</${name}> closes ${top ?? 'nothing'}: tags interleave`).toBe(name);
      }
    }
    expect(stack, `left open: ${stack.join(', ')}`).toHaveLength(0);
  });

  // The page claims it is complete with scripts blocked, and nothing checked it.
  // The check needs no browser: strip every script from the markup and assert the
  // content is still there and every control that cannot act without one ships
  // hidden. A button that does nothing is worse than no button.
  it('is complete with scripts blocked, and ships no dead controls', () => {
    const page = read('docs/index.html');
    // Styles go too: a CSS comment on this page mentions `<details>` by name, and
    // a tag counter cannot tell prose about markup from markup.
    const noscript = page
      .replace(/<script[^>]*>[\s\S]*?<\/script>/g, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/g, '');
    expect(noscript).not.toContain('<script');

    const rows = (pattern: RegExp): number => (noscript.match(pattern) ?? []).length;
    expect(rows(/demo__call/g), 'the demo table is rendered by script').toBeGreaterThanOrEqual(9);
    expect(rows(/ledger__row/g), 'the ledger is rendered by script').toBeGreaterThanOrEqual(10);
    // `<dt[ >]`, not `<dt>`: each term carries an id now, so the link from where
    // the word is used lands on the definition rather than on the section.
    expect(rows(/<dt[ >]/g), 'the glossary is rendered by script').toBeGreaterThanOrEqual(12);
    expect(rows(/<details class="more"/g), 'the folded blocks need script').toBeGreaterThanOrEqual(15);

    // Nesting is the defect worth guarding, not the count. The script that
    // wrapped these found its boundaries by searching forward, so the five FAQ
    // answers ended up inside one another, six levels deep — two clicks to read
    // one question, and the innermost invisible until four others were open.
    let depth = 0;
    for (const tag of noscript.match(/<\/?details\b/g) ?? []) {
      depth += tag === '<details' ? 1 : -1;
      expect(depth, 'a folded block is nested inside another').toBeLessThanOrEqual(1);
      expect(depth, 'a folded block closes without opening').toBeGreaterThanOrEqual(0);
    }
    expect(depth, 'a folded block is never closed').toBe(0);

    // Each of these acts only through script, so each ships hidden and is
    // revealed by the script that gives it something to do.
    for (const control of [
      'class="copy" type="button" data-copy hidden',
      'id="d-run" hidden',
      'id="sweep" hidden',
      'id="open-all" hidden',
      'class="gloss-back" hidden',
    ]) {
      expect(noscript, `a control that cannot act is visible: ${control}`).toContain(control);
    }
  });

  // Renumbering has silently broken these twice. Moving the demo to the front of
  // the page shifted Evidence from 01 to 02, and two references — one to a
  // calibration figure, one to an outcome — went on naming the old number and
  // pointing a reader at the wrong section. The page writes them as
  // "section NN, Name", which is exactly enough to check by machine.
  it('every cross-reference names the section it actually points at', () => {
    const page = read('docs/index.html');
    const numbers = new Map(
      [...page.matchAll(/rubric__n">(\d\d)<\/span>([^<]+)/g)].map((m) => [
        (m[2] ?? '').trim(), (m[1] ?? ''),
      ]),
    );
    expect(numbers.size, 'no rubric numbers found, so this test proves nothing').toBeGreaterThan(4);
    const refs = [...page.matchAll(/[Ss]ection (\d\d), ([^<]+?)</g)];
    expect(refs.length, 'no named cross-references found').toBeGreaterThan(3);
    for (const ref of refs) {
      const [, number, name] = ref;
      const actual = numbers.get((name ?? '').trim());
      expect(actual, `"section ${number}, ${name}" names no section on the page`).toBeDefined();
      expect(actual, `"${name}" is section ${actual}, but a reference calls it ${number}`).toBe(number);
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

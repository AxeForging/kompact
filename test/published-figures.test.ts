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
/**
 * Every page a reader can reach, as one string.
 *
 * The landing page was 17,000px until cost, losses and verification moved to
 * `docs/evidence.html`, and the stylesheet and script left with them into
 * `app.css` and `app.js`. Assertions that mean "the site publishes this figure"
 * read this; assertions that mean "the LANDING page says this" keep naming
 * `docs/index.html`, because that distinction is the whole point of the split.
 */
const site = (): string =>
  read('docs/index.html') + read('docs/evidence.html') + read('docs/glossary.html');
const results = read('eval/RESULTS.md');
/**
 * The machine-local half, split out of `RESULTS.md` because mixing the two is
 * what let twelve figures go stale at once: regenerating moved figures the page
 * quoted, for reasons that had nothing to do with any change to the code.
 *
 * Still bound, deliberately — unbound is how they went stale. What the split
 * changes is that regenerating `SNAPSHOT.md` is an explicit act, and these
 * failing is the correct signal to update the page in the same commit rather
 * than a surprise on an unrelated one.
 */
const snapshot = read('eval/SNAPSHOT.md');

/** `logistic (features)   0.905  0.078  0.684  0.944  0.044   35.4%` */
/**
 * `logistic (features)   0.905  0.078  0.684  0.944  0.044   0.044     35.4%`
 *
 * Positional, and therefore fragile: adding the `ECE(T)` column shifted `drop`
 * one place and this test began asserting that README quotes an ECE as a drop
 * share. That is the failure working — the column moved and something said so —
 * but it is worth naming, because a column added at the END would have moved
 * nothing and been bound by nothing.
 */
function scorerRow(name: string): {
  mean: string; sd: string; min: string; ece: string; eceT: string; drop: string;
} {
  const line = results.split('\n').find((l) => l.trimStart().startsWith(name));
  if (!line) throw new Error(`no row for ${name} in eval/RESULTS.md`);
  const [mean, sd, min, , ece, eceT, drop] = line.slice(name.length).trim().split(/\s+/);
  return { mean: mean!, sd: sd!, min: min!, ece: ece!, eceT: eceT!, drop: drop! };
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
  const line = snapshot.split('\n').find((l) => /^total\s+\d/.test(l));
  if (!line) return undefined;
  const [, calls, , , freed, ms] = line.trim().split(/\s+/);
  return { calls: calls!, freed: freed!, ms: ms!.replace('ms', '') };
}

/** `multilingual   8   700 ms   773 ms   87.5 ms   792` — one latency cell. */
function latency(checkpoint: string, questions: number): string | undefined {
  return new RegExp(`^${checkpoint}\\s+${questions}\\s+(\\d+) ms`, 'm').exec(snapshot)?.[1];
}

// The sidecar benchmark is a snapshot: it reads whatever session corpus
// `sessions.ts` just measured, on whatever card is in the machine.
const scalar = (re: RegExp): string | undefined => re.exec(snapshot)?.[1];

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
/**
 * The figure an installer actually gets from the shipped defaults.
 *
 * Bound late, and the gap showed: the page carried 22.2% in three places while
 * `eval/policy.ts` had started reporting 33.7%, because the sweep had gained a
 * cap and lost a bug — it had been counting a truncated result as entirely
 * freed when it keeps a 300-character head. Changing all three by hand failed
 * nothing, which is how a generated page ends up with a hand-typed number.
 */
const shippedPath = /shipped code path[^\n]*\n\s*([\d.]+)% freed, ([\d.]+)% of reused outputs kept/
  .exec(results);

describe('published figures match eval/RESULTS.md', () => {
  const quoting: Array<[string, string[]]> = [
    ['README.md', [
      `**${logistic.mean} ± ${logistic.sd}**`, `| ${logistic.min} |`, `**${logistic.drop}**`,
      `${laya.mean} ± ${laya.sd}`, `${sizeOnly.mean} ± ${sizeOnly.sd}`, `**+${closest}**`,
    ]],
    // The page bound the spread but not the mean beside it, so a typo in 0.905
    // would have survived on the one file a reader actually looks at.
    ['docs/index.html', [`${logistic.mean} <span`, `± ${logistic.sd}`,
      `worst split ${logistic.min}`, `+${closest}`]],
    // Cost, losses and verification moved to their own page when the landing
    // page reached 17,000px. The figures did not change; their address did, and
    // twenty-one assertions failed loudly rather than silently, which is what
    // naming the file buys.
    ['docs/evidence.html', [
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

  /**
   * The calibration column the model was condemned by, and its own self-check.
   *
   * `ECE` against Laya measured a step this project never ran — the vendor's
   * guide asks for a temperature refit on your own labels and warns that
   * `multilingual` ships at 1.0. `ECE(T)` is that step. Two things have to stay
   * true or the column is decoration again: it has to MOVE where the guide said
   * it would, and it has to leave the ranking columns alone.
   */
  it('calibrating the uncalibrated checkpoint actually changes its error', () => {
    const uncalibrated = scorerRow('laya multilingual/reproducible');
    expect(Number(uncalibrated.eceT),
      'temperature scaling should cut multilingual\'s calibration error sharply')
      .toBeLessThan(Number(uncalibrated.ece) - 0.1);
  });

  it('leaves the fitted scorer, and therefore the argument, untouched', () => {
    // Already fitted by maximum likelihood on the same sessions, so a
    // temperature on top should find ~1. If this ever moves, the arithmetic is
    // wrong, not the model.
    expect(logistic.eceT).toBe(logistic.ece);
  });

  // The blocks that drifted while this test watched the other two. Both are
  // generated into eval/RESULTS.md, which is committed, so this runs on a runner
  // even though neither measurement can be taken there.
  it('quotes the measured session totals, not an older corpus', () => {
    expect(sessions, 'eval/SNAPSHOT.md has no sessions block').toBeDefined();
    const page = site();
    expect(page, 'the page quotes a call count from an older corpus')
      .toContain(Number(sessions!.calls).toLocaleString('en-GB'));
    expect(page).toContain(`${sessions!.freed}`);
    expect(page).toContain(`${sessions!.ms} ms`);
  });

  // Not "every file must quote every figure" — a file may legitimately mention
  // only some. This fires where a file *does* make the claim and the value has
  // gone stale, which is exactly how the last four drifted.
  it('quotes no stale sidecar figure anywhere', () => {
    expect(bench.coldStart, 'eval/SNAPSHOT.md has no sidecar block').toBeDefined();
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
    for (const path of ['README.md', 'docs/index.html', 'CHANGELOG.md', 'skills/kompact/SKILL.md']) {
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
    const demo: {
      stats: { charsBefore: number; charsAfter: number };
      decisions: Array<{ freed: number; outcome: string; chars: number }>;
    } = JSON.parse(data.slice(data.indexOf('{'), data.lastIndexOf('}') + 1));
    const decisions = demo.decisions;
    const freed = decisions.reduce((sum, d) => sum + d.freed, 0);

    /**
     * The headline and the rows have to be the same number.
     *
     * They were not: the page said 8,393 freed while its own data file recorded
     * a 45,581-character delta, because `freedBy` credited a capped result with
     * freeing nothing. Exact equality, not a tolerance — the truncation note's
     * length is computable, so an approximation here would only hide the next
     * version of that bug.
     */
    it('accounts for every character the compaction actually removed', () => {
      expect(freed).toBe(demo.stats.charsBefore - demo.stats.charsAfter);
    });

    it('renders every row into the page', () => {
      // `[^"]*`, because the two rows that carry their own reading are
      // `demo__call demo__call--noted` and a literal class match silently
      // counted seven of nine.
      const rows = page.match(/<li class="demo__call[^"]*" data-state="/g) ?? [];
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

    /**
     * The two rows that carry their own reading.
     *
     * These replaced two Q&A paragraphs, so the numbers in them have to come
     * from the same decisions the bars are drawn from — a note is prose until
     * something checks it against the data, and prose is what went stale.
     */
    it('annotates the head-only and dropped rows from their own decisions', () => {
      const head = decisions.find((d) => d.outcome === 'head only');
      const dropped = decisions.find((d) => d.outcome === 'dropped');
      expect(head, 'the demo no longer has a head-only row').toBeDefined();
      expect(dropped, 'the demo no longer has a dropped row').toBeDefined();

      const fmt = (n: number): string => n.toLocaleString('en-GB');
      expect(page, 'the head-only note does not say what survived')
        .toContain(`Kept <b>${fmt(head!.chars - head!.freed)}</b> of ${fmt(head!.chars)} characters`);
      expect(page, 'the dropped note does not price the call its result came with')
        .toContain(`<b>${fmt(dropped!.chars)}</b> characters of output, <b>${fmt(dropped!.freed)}</b> freed`);

      // Exactly two: a note on all nine would be noise rather than a reading.
      expect((page.match(/class="demo__note"/g) ?? []).length).toBe(2);
    });

    // A control that cannot do anything is worse than no control.
    it('hides the replay button until the script that drives it runs', () => {
      expect(page).toMatch(/id="d-run" hidden/);
      expect(read('docs/app.js')).toContain('run.hidden = false;');
    });

    /**
     * The stub spark, which replaced the sentence "flat at about seven after
     * that" with the seven points it was summarising.
     *
     * Same contract as everything else here: `eval/passes-page.ts` computes the
     * coordinates from the fixture and writes them into the markup, so the shape
     * is correct with scripts blocked and `app.js` only draws the line on. A
     * figure whose points arrived by script would be a blank box to a reader who
     * has them off, and this page is read by people who do.
     */
    /**
     * The four session bars, and the cut sweeping the plate.
     *
     * Both read data the page already carried and neither has a fixture of its
     * own, which is the point: the bars parse the same `SNAPSHOT.md` table the
     * masthead quotes, and the cut counts marks out of the array the plate is
     * drawn from. A figure with its own copy of a measurement is a second thing
     * to keep in step, and the first draft of the bars went out of step on the
     * day it was written.
     */
    it('draws the session bars from the snapshot the page already quotes', () => {
      const table = /## What it frees in practice[\s\S]*?```\n([\s\S]*?)```/.exec(snapshot)?.[1];
      expect(table, 'eval/SNAPSHOT.md has no sessions table').toBeDefined();
      const rows = (table ?? '').split('\n')
        .filter((line) => /^\S+\s+\d+\s+[\d,]+/.test(line.trim()) && !line.startsWith('total'));
      expect(rows.length, 'no session rows to draw').toBeGreaterThan(0);
      expect((page.match(/class="spread__row"/g) ?? []).length).toBe(rows.length);

      for (const row of rows) {
        const freed = /([\d.]+)%/.exec(row)?.[1];
        expect(page, `a session freeing ${freed}% is not on the figure`)
          .toContain(`>${freed}%</span>`);
      }
    });

    it('counts the sweep out of the same marks the plate is drawn from', () => {
      const data = read('docs/distribution-data.js');
      const plot: { sweep: Array<{ at: number; swept: number }>; reusedTotal: number } =
        JSON.parse(data.slice(data.indexOf('{'), data.lastIndexOf('}') + 1));
      const last = plot.sweep[plot.sweep.length - 1]!;

      // The settled markup is the end of the sweep, so a reader with scripts
      // blocked gets the finding rather than a line parked at the floor.
      expect(page).toContain(`id="cut-at">${last.at.toFixed(2)}</b>`);
      expect(page).toContain(`id="cut-n">${last.swept}</b>`);
      expect(page).toContain(`id="cut-pct">${Math.round((100 * last.swept) / plot.reusedTotal)}%</b>`);
      expect(page).toContain(`style="--at:${last.at}"`);
    });

    /**
     * The model calls that did not happen.
     *
     * Two of its three numbers are measured and the third is arithmetic, so the
     * arithmetic is what this checks: nine blocks, and a token total that is the
     * count times the window share the engine asks at. The figure states a
     * derived number as if it were large, and a derived number nothing checks is
     * how a page starts lying slowly.
     */
    it('derives the tokens not sent from the fixture, and shows nine blocks', () => {
      const fixture: { avoided: number; window: number; at: number } =
        JSON.parse(read('eval/fixtures/passes.json'));
      const blocks = page.match(/<li class="avoided__block"/g) ?? [];
      expect(blocks.length, 'the strip ships without its blocks').toBe(fixture.avoided);

      const perSummary = Math.round((fixture.window * fixture.at) / 100);
      const total = perSummary * fixture.avoided;
      expect(page, `${fixture.avoided} summaries of ~${perSummary} tokens is ${total}`)
        .toContain(`data-to="${total}"`);
      expect(page).toContain(`${total.toLocaleString('en-GB')}</b>`);

      // The claim this figure must never make. A duration is an unverified row
      // on the ledger, and the page argues that it does not publish those.
      const section = page.slice(page.indexOf('id="freed"'), page.indexOf('</section>', page.indexOf('id="freed"')));
      expect(section, 'the section publishes a saving in seconds')
        .not.toMatch(/saves?\s+[\d.,]+\s*(seconds|minutes|hours)/i);
      expect(section, 'the section does not say the duration is unmeasured')
        .toContain('is not measured');
    });

    it('plots every measured point of the stub spark into the markup', () => {
      const fixture: { stubShare: number[] } =
        JSON.parse(read('eval/fixtures/passes.json'));
      const dots = page.match(/<circle class="spark__dot"/g) ?? [];
      expect(dots.length, 'the spark ships without its points').toBe(fixture.stubShare.length);

      // The path has to reach every one of them, so it carries n-1 line-tos.
      const path = /class="spark__line"[^>]*\sd="([^"]+)"/.exec(page)?.[1];
      expect(path, 'the spark ships without a path').toBeDefined();
      expect((path?.match(/L/g) ?? []).length).toBe(fixture.stubShare.length - 1);

      // The axis is zeroed and says so on the figure. Without the ceiling named,
      // a line drawn at 8.3 of 10 sits near the top of its box and reads as the
      // opposite of what it measures.
      expect(page, 'the spark axis does not name its ceiling')
        .toMatch(/<text class="spark__tick"[^>]*>10%<\/text>/);
    });
  });

  /**
   * The ladder figure in section 03.
   *
   * Every row is written by `eval/passes.ts --publish`, including the sentence
   * above it — which is the point of these three. The sentence used to say "the
   * sixth" as hand-typed prose beside a figure that draws however many passes
   * the measurement found, and on a page whose rule is that no number is typed
   * by hand that was the wrong kind of six.
   */
  describe('the compaction ladder', () => {
    const page = read('docs/index.html');
    const rows = page.match(/<li class="ladder__row[^"]*"/g) ?? [];
    const refused = rows.filter((row) => row.includes('ladder__row--over'));
    const taken = rows.length - refused.length;

    it('draws the pass that was refused, not only the ones that were taken', () => {
      expect(rows.length, 'no ladder rows in the page').toBeGreaterThan(1);
      expect(refused.length, 'the hand-over row is missing or duplicated').toBe(1);
    });

    it('never draws more taken passes than the shipped ceiling allows', () => {
      const hook = read('hooks/kompact.ts');
      const ceiling = Number(/maxPasses: (\d+)/.exec(hook)?.[1]);
      expect(Number.isFinite(ceiling)).toBe(true);
      expect(taken).toBeLessThanOrEqual(ceiling);
    });

    it('counts the same passes in its sentence as it draws', () => {
      const words = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh',
        'eighth', 'ninth', 'tenth'];
      expect(page, `the sentence should say "the ${words[taken - 1]}" for ${taken} taken passes`)
        .toContain(`runs after the\n    ${words[taken - 1]} of them rather than the first`);
    });
  });

  /**
   * The verification ledger counts itself.
   *
   * The heading read "Including the one that was not" while four rows carried
   * the not-verified flag, and then five. A page that asks to be checked on its
   * arithmetic cannot miscount its own open claims.
   */
  it('says how many claims are open and how many are checked', () => {
    const page = site();
    const body = page.slice(page.indexOf('<main>'));
    const rows = [...body.matchAll(/<div class="ledger__row( ledger__row--open)?">/g)];
    const open = rows.filter((row) => row[1]).length;
    const checked = rows.length - open;
    const words = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight',
      'nine', 'ten', 'eleven', 'twelve'];
    const heading = /<h2 id="checked-h">([^<]*)<\/h2>/.exec(body)?.[1] ?? '';
    expect(heading.toLowerCase(), `${checked} checked and ${open} open`)
      .toBe(`${words[checked]} claims checked, ${words[open]} not.`);
    expect(page).toContain(`And the ${checked} claims that are verified`);
  });

  /**
   * The loop's own cost, bound to the table that measured it.
   *
   * These are the numbers that qualify the ladder rather than sell it, which is
   * exactly the kind that goes stale quietly when the eval moves and the prose
   * does not.
   */
  it('quotes the loop\'s cost as eval/RESULTS.md measured it', () => {
    const results = read('eval/RESULTS.md');
    const page = read('docs/index.html');
    const whole = /whole loop: (\d+) outputs lost[\s\S]*?([\d.]+)x the characters, ([\d.]+)x the loss/
      .exec(results);
    expect(whole, 'eval/RESULTS.md no longer states the whole-loop cost').not.toBeNull();
    // The first pass's own loss, which is what the loop is compared against.
    const firstPass = /\n\s+1\s+\d+\s+\d+\s+(\d+)\s/.exec(
      results.slice(results.indexOf('the loop, up to')));
    expect(firstPass, 'the per-pass table no longer has a first row').not.toBeNull();
    // Compared as numbers: the script prints 3.17x and the page sets 3.17×,
    // but a trailing zero on either side is not a drift.
    const quoted = [...page.matchAll(/<span class="val">([\d.]+)(?:&#215;)?<\/span>/g)]
      .map((match) => Number(match[1]));
    for (const [what, figure] of [
      ['outputs lost by the loop', Number(whole![1])],
      ['outputs lost by one pass', Number(firstPass![1])],
      ['the characters multiple', Number(whole![2])],
      ['the loss multiple', Number(whole![3])],
    ] as [string, number][]) {
      expect(quoted, `the page no longer quotes ${what} (${figure})`).toContain(figure);
    }
  });

  // A figure that was corrected once tends to survive somewhere.
  const published = [
    'README.md', 'CONTRIBUTING.md', 'CHANGELOG.md', 'DESIGN-BRIEF.md', '.impeccable.md',
    'docs/index.html', '.claude-plugin/plugin.json', 'skills/kompact/SKILL.md',
    'src/features.ts', 'src/compact.ts', 'src/types.ts', 'hooks/kompact.ts',
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
    // The masthead that named this test is gone: it carried 310 words and now
    // carries 134, and the claims it used to state moved down into the sections
    // that prove them, where two of them are now marked up mid-sentence. So
    // these read the landing page with its tags removed. What is being asserted
    // is unchanged — the landing page still quotes these figures and they still
    // come from the generated reports — only where on it has stopped mattering.
    const page = read('docs/index.html').replace(/<[^>]+>/g, '');

    // `  ratio:              122x the time` — a snapshot: it compares against
    // whatever session corpus `sessions.ts` measured in the same report.
    // Across the site, not the landing page: this comparison moved to the
    // evidence page with the cost measurement it belongs to. It was passing
    // here on an accident — `3.17&#215;` in a different sentence contains
    // `17&#215;` — and only surfaced when that unrelated figure changed.
    const ratio = /ratio:\s+(\d+)x the time/.exec(snapshot)?.[1];
    expect(ratio, 'eval/SNAPSHOT.md no longer reports a latency ratio').toBeDefined();
    expect(site(), `the report says ${ratio}x`).toContain(`${ratio}&#215;`);

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
    const page = site();
    for (const [config, where] of [
      ['laya english/direct', 'english on the wording that works'],
      ['laya multilingual/direct', 'multilingual on the same wording'],
      ['laya english/entailment', "english's best config"],
      ['laya typed-decisions/direct', 'the best laya config of all'],
    ] as const) {
      const { mean } = scorerRow(config);
      expect(readme, `README no longer matches ${config} (${where}: ${mean})`).toContain(mean);
    }
    // The page quotes only the two that carry the argument.
    expect(page, 'the page no longer matches english/direct').toContain(scorerRow('laya english/direct').mean);
    expect(page, 'the page no longer matches multilingual/direct')
      .toContain(scorerRow('laya multilingual/direct').mean);
  });

  // `eval/render-check.ts` builds its browser probe as a template literal, so a
  // single backtick anywhere inside it ends the string early and the entire check
  // stops running. That has happened twice, both times in a comment, and both
  // times the run printed a parse error where results should have been.
  it('keeps the render probe free of the character that silently ends it', () => {
    const check = read('eval/render-check.ts');
    const probe = /const PROBE = String\.raw`([\s\S]*?)`;/.exec(check)?.[1];
    expect(probe, 'the probe is no longer a single template literal').toBeDefined();
    expect(probe, 'a backtick inside the probe ends it early').not.toContain('`');
  });

  // The masthead claims a number of unverified claims. That is the page's most
  // unusual asset stated as a fact, so it has to stay true as the ledger changes —
  // and a hand-typed count beside a hand-maintained list is the oldest way for a
  // page to start lying slowly.
  it('counts its own unverified claims correctly', () => {
    // `<style>` goes first, and that omission is why this test passed while the
    // colophon said six: two of the six matches were the CSS rules that style the
    // row, so the guard counted the stylesheet and confirmed a wrong number
    // against itself. A check that can agree with the bug is worse than none.
    //
    // The stylesheet moved to `docs/app.css` when the page gained siblings, so
    // this strip is now a no-op and the class of bug it guards against cannot
    // recur from that direction. Kept rather than deleted: it costs nothing, and
    // an inline block could come back for critical CSS without anyone thinking
    // to restore it.
    const page = site().replace(/<style[^>]*>[\s\S]*?<\/style>/g, '');
    const open = (page.match(/ledger__row--open/g) ?? []).length;
    expect(open, 'no unverified claims found, so this proves nothing').toBeGreaterThan(0);
    const claimed = /<b>(\d+)<\/b> claims <a href="[^"]*#checked">not verified<\/a>/.exec(page)?.[1];
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
    // Both pages, because the guarantee is about what a reader with scripts off
    // gets from the site, and half the folded blocks moved to the evidence page.
    const page = site();
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
    expect(rows(/<details class="more"/g), 'the folded blocks need script').toBeGreaterThanOrEqual(13);
    // None on the landing page. Every one of them was a reader being asked to
    // click a triangle to find out whether the page is honest, and two carried
    // the diagnostic tree and the safety contract — the two things someone
    // deciding whether to install this is actually looking for.
    expect(read('docs/index.html'), 'a folded block is back on the landing page')
      .not.toContain('<details');

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
      'id="open-all" hidden',
      'class="gloss-back" hidden',
      'id="stream" hidden',
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
    // Both pages: a reference like "section 06, Cost" is written on the landing
    // page and numbered on the evidence page now, so checking one file alone
    // would call every cross-page reference a dangling one.
    const page = site();
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

  /**
   * The signals figures, against the fixture the page is generated from.
   *
   * `eval/signals-page.ts` writes section 04 from `eval/fixtures/signals.json`,
   * so that section is always right. The prose around it is not generated: the
   * README and the verification ledger both said "nine repeated command shapes"
   * and "25 of 2,000" while the generated table two thousand pixels above said
   * 10 and 27, because a later replay moved the fixture and only the generated
   * half followed. A reader who checks two numbers against each other finds a
   * page arguing that every figure comes from `eval/` and failing its own claim.
   */
  it('states the signals figures its own fixture reports', () => {
    const fixture = JSON.parse(read('eval/fixtures/signals.json')) as {
      meta: { sessions: number; calls: number; shapes: number; repeated: number };
      rows: Record<string, unknown>;
    };
    const commands = Object.keys(fixture.rows).filter((k) => k.startsWith('command::')).length;
    expect(commands, 'the fixture has no command rows, so this test proves nothing')
      .toBeGreaterThan(0);

    const readme = read('README.md');
    expect(readme).toContain(`${fixture.meta.calls.toLocaleString('en-GB')} tool`);
    expect(readme).toContain(
      `${fixture.meta.repeated} of ${fixture.meta.shapes.toLocaleString('en-GB')}`);
    expect(readme).toContain(`all ${commands} of the repeated`);

    // On the page, wherever the repeated command shapes are counted — prose or
    // CSS comment — the count has to be the fixture's.
    // The animation's own counter. It is labelled "on a shape nothing else
    // shares", and it read 1,638 against the fixture's 1,625 because every
    // arrival outside the six drawn bars — including 13 on shapes that did
    // repeat — was collapsed into one bucket.
    const data = read('docs/signals-data.js');
    const stream = JSON.parse((/"stream":(\[[^\]]*\])/.exec(data) ?? [])[1] ?? '[]') as number[];
    expect(stream.length, 'no stream in docs/signals-data.js').toBeGreaterThan(0);
    const keys = Object.keys(fixture.rows);
    const alone = (JSON.parse(read('eval/fixtures/signals.json')) as { order: number[] }).order
      .filter((i) => keys[i] === undefined).length;
    expect(stream.filter((v) => v === -1).length,
      'the stream counts an arrival on a repeated shape as one nothing else shares').toBe(alone);

    // Tags out first: the generated half wraps its figure in `<span class="val">`,
    // so the raw file never reads as "10 repeated command shapes" the way a
    // reader sees it.
    // §05 "What you repeat" moved to the evidence page; the count lives there now.
    const page = read('docs/evidence.html').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    const claims = [...page.matchAll(/(\S+) repeated command shapes/g)];
    expect(claims.length, 'the page never counts the repeated command shapes')
      .toBeGreaterThan(0);
    for (const claim of claims) {
      expect(claim[1], `the page says "${claim[0]}", but the fixture has ${commands}`)
        .toBe(String(commands));
    }
  });

  it('states the summary-cost figures from its fixture', () => {
    const f = JSON.parse(read('eval/fixtures/summary-cost.json')) as {
      count: number; medianSec: number; minSec: number; maxSec: number; medianReductionPct: number;
    };
    const page = read('docs/evidence.html');
    expect(page, 'the count is not the fixture count').toContain(`<b>${f.count}</b> real`);
    expect(page, 'the median is not the fixture median').toContain(`<b>${f.medianSec}&#8239;s</b>`);
    expect(page).toContain(`${f.minSec}&#8239;s to ${f.maxSec}&#8239;s`);
    expect(page).toContain(`about
    ${f.medianReductionPct}%`);
    // It must not claim the quality row is settled: this is produce-time only.
    expect(page, 'the produce-time fact must point at the still-unverified row')
      .toContain('stays not verified');
  });

  it('quotes the shipped defaults the sweep actually reports', () => {
    expect(shippedPath, 'eval/RESULTS.md has no shipped-code-path line to bind to').not.toBeNull();
    const [, freed, kept] = shippedPath!;
    const page = site();
    expect(page.match(new RegExp(`${freed!.replace('.', '\\.')}% freed`)),
      `the page should quote ${freed}% freed`).not.toBeNull();
    for (const stale of ['22.2% freed', '22.2% and 77.7%']) {
      expect(page, `docs/index.html still quotes ${stale}`).not.toContain(stale);
    }
    expect(page).toContain(`${kept}%`);
  });

  /**
   * The glossary says how many terms it holds, in a summary a reader opens to
   * count them. Adding the cap made it thirteen and the summary still said
   * twelve, which is the smallest possible version of the error this whole file
   * exists to prevent.
   */
  it('counts its own glossary correctly', () => {
    // The glossary moved to its own page when the landing page had to earn back
    // the height that unfolding two hidden figures cost it.
    const page = read('docs/glossary.html');
    const terms = [...page.matchAll(/<dt id="g-/g)].length;
    expect(terms, 'no glossary terms found, so this test proves nothing').toBeGreaterThan(5);
    const words = ['ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen'];
    const said = /The (\w+) terms this page uses/.exec(page);
    expect(said, 'the glossary no longer says how many terms it has').not.toBeNull();
    expect(said![1], `the glossary holds ${terms} terms`).toBe(words[terms - 10]);
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

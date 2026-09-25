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

/** `logistic (features)   0.895  0.073  0.689  0.927   38.9%` */
function scorerRow(name: string): { mean: string; sd: string; min: string; drop: string } {
  const line = results.split('\n').find((l) => l.trimStart().startsWith(name));
  if (!line) throw new Error(`no row for ${name} in eval/RESULTS.md`);
  const [mean, sd, min, , drop] = line.slice(name.length).trim().split(/\s+/);
  return { mean: mean!, sd: sd!, min: min!, drop: drop! };
}

/** `budget 0.5, floor 0.10   42.5%  12  2  84.6%  87.5%` */
function policyRow(name: string): { freed: string; kept: string; charsKept: string } {
  const line = results.split('\n').find((l) => l.trimStart().startsWith(name));
  if (!line) throw new Error(`no policy row for ${name} in eval/RESULTS.md`);
  const [freed, , , kept, charsKept] = line.slice(name.length).trim().split(/\s+/);
  return { freed: freed!, kept: kept!, charsKept: charsKept! };
}

const logistic = scorerRow('logistic (features)');
const laya = scorerRow('laya typed-decisions/direct');
const sizeOnly = scorerRow('output size only');
const shipped = policyRow('budget 0.5, floor 0.10');
const closest = /range ([\d.]+) to [\d.]+/.exec(results)?.[1];

describe('published figures match eval/RESULTS.md', () => {
  const quoting: Array<[string, string[]]> = [
    ['README.md', [
      `**0.895 ± ${logistic.sd}**`, `| ${logistic.min} |`, `**${logistic.drop}**`,
      `0.721 ± ${laya.sd}`, `${sizeOnly.mean} ± ${sizeOnly.sd}`, `**+${closest}**`,
    ]],
    ['docs/index.html', [`± ${logistic.sd}`, `worst split ${logistic.min}`, `+${closest}`]],
    ['.claude-plugin/plugin.json', [`0.895 \\u00b1 ${logistic.sd}`, `0.721 \\u00b1 ${laya.sd}`]],
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

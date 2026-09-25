/**
 * The two ways this feature can embarrass its author.
 *
 * Normalisation: over-collapse and unrelated work merges into one meaningless
 * row; under-collapse and nothing ever reaches a threshold. Both directions are
 * asserted, because only checking that `a.ts` and `b.ts` collapse would pass
 * for a normaliser that returns the empty string.
 *
 * Redaction: the recorder writes a file the developer did not ask for. A secret
 * in it is the worst outcome this feature has, so a planted one of each shape
 * has to come back unrecognisable. Every credential below is a fake.
 */
import { describe, expect, it } from 'vitest';
import {
  commandSignature, estimateSaved, intentSignature, isCorrection, redact, sequenceSignature,
} from '../src/signals.js';

/**
 * Fakes of real credential shapes, assembled rather than written out.
 *
 * A literal token shape in a committed file is refused by GitHub's own push
 * protection — which is fair evidence that these have the right shape, and the
 * reason they are built at runtime instead.
 */
const FAKE = {
  github: `ghp_${'A'.repeat(36)}`,
  openai: `sk-${'A'.repeat(24)}`,
  aws: `AKIA${'JQ2EXAMPLE12'}`,
  slack: `xoxb-${'1'.repeat(11)}-${'A'.repeat(24)}`,
  flagValue: 'hunter2primary',
  urlPassword: 's3cr3tpass',
};

describe('command signatures collapse the same work', () => {
  const same = (a: string, b: string): void => {
    expect(commandSignature(a), `${a}\n  ${b}`).toBe(commandSignature(b));
  };

  it('ignores which file a command was pointed at', () => {
    same('npm test -- test/auth.spec.ts', 'npm test -- test/hook.spec.ts');
    same('bun eval/fit.ts --fixture', 'bun eval/repeat.ts --fixture');
    same('cat src/state.ts', 'cat ./docs/index.html');
  });

  it('ignores commit messages, ids and shas', () => {
    same('git commit -m "one thing"', 'git commit -m "a different thing"');
    same('gh run view 36152046005 --log', 'gh run view 36098881234 --log');
    same('git show 57cfc7e', 'git show d63b238a91');
  });

  it('ignores the value of a flag but keeps the flag', () => {
    same('chromium --window-size=1400,900', 'chromium --window-size=390,844');
    expect(commandSignature('chromium --window-size=1400,900')).toContain('--window-size=');
  });
});

describe('command signatures keep different work apart', () => {
  const differ = (a: string, b: string): void => {
    expect(commandSignature(a), `${a}\n  ${b}`).not.toBe(commandSignature(b));
  };

  it('separates different programs and subcommands', () => {
    differ('npm test', 'npm run build');
    differ('git status', 'git diff');
    differ('npm test', 'bun test');
  });

  it('separates a pipeline from its first stage', () => {
    differ('gh run view --log', 'gh run view --log | tail -20');
  });

  // A normaliser that returned '' would pass every collapse test above.
  it('does not collapse everything to nothing', () => {
    for (const command of ['npm test', 'git status', 'ls -la /tmp']) {
      expect(commandSignature(command).length, command).toBeGreaterThan(2);
    }
  });
});

describe('redaction', () => {
  const planted: Array<[string, string]> = [
    [`gh api -H "Authorization: Bearer ${FAKE.github}"`, FAKE.github],
    [`curl -H "x-api-key: ${FAKE.openai}" https://example.test`, FAKE.openai],
    [`aws configure set aws_access_key_id ${FAKE.aws}`, FAKE.aws],
    [`deploy --token=${FAKE.flagValue}`, FAKE.flagValue],
    [`psql postgres://admin:${FAKE.urlPassword}@db.example.test/app`, FAKE.urlPassword],
    [`export SLACK=${FAKE.slack}`, FAKE.slack],
  ];

  for (const [command, secret] of planted) {
    it(`strips ${secret.slice(0, 12)} before anything is stored`, () => {
      expect(redact(command), 'the raw secret survived redaction').not.toContain(secret);
    });

    // The signature is what gets counted, so it must be clean independently —
    // a normaliser that skipped redact() would be caught here, not in review.
    it(`keeps ${secret.slice(0, 12)} out of the signature too`, () => {
      expect(commandSignature(command)).not.toContain(secret);
    });
  }

  it('leaves an ordinary command legible', () => {
    expect(redact('npm test -- test/auth.spec.ts')).toBe('npm test -- test/auth.spec.ts');
  });

  it('redacts inside a prompt as well as a command', () => {
    expect(intentSignature(`deploy using ${FAKE.github} now`)).not.toContain(FAKE.github);
  });
});

describe('corrections', () => {
  it('recognises a turn that corrects the assistant', () => {
    for (const text of [
      'no, use rtk not plain grep',
      "don't add Co-Authored-By lines",
      'Actually, the floor is 0.2',
      'stop — that is the wrong file',
      'I said use lightpanda',
    ]) expect(isCorrection(text), text).toBe(true);
  });

  it('does not mistake an ordinary request for a correction', () => {
    for (const text of [
      'add a test for the normaliser',
      'there is no coverage of the print path yet',
      'why is CI red?',
      'the answer is not obvious, so explain it',
    ]) expect(isCorrection(text), text).toBe(false);
  });
});

describe('intent signatures', () => {
  it('collapses the same request phrased two ways', () => {
    expect(intentSignature('fix the failing test'))
      .toBe(intentSignature('the test is failing, fix it'));
  });

  it('keeps different requests apart', () => {
    expect(intentSignature('regenerate the docs'))
      .not.toBe(intentSignature('why is CI red'));
  });

  it('survives a prompt that is mostly a code block', () => {
    expect(intentSignature('update this\n```ts\nconst x = 1;\n```\nfor the parser'))
      .toContain('parser');
  });
});

describe('sequence signatures', () => {
  it('keeps the program a Bash step ran', () => {
    const sig = sequenceSignature([
      { tool: 'Edit' },
      { tool: 'Bash', command: 'npm test -- test/a.spec.ts' },
      { tool: 'Read' },
    ]);
    expect(sig).toBe('Edit → Bash(npm test) → Read');
  });

  it('separates two sequences that differ only in their command', () => {
    const a = sequenceSignature([{ tool: 'Bash', command: 'npm test' }]);
    const b = sequenceSignature([{ tool: 'Bash', command: 'git status' }]);
    expect(a).not.toBe(b);
  });
});

describe('the time estimate', () => {
  // It is a modelled figure, so what matters is that it is monotone in each
  // input and that the report can print the inputs beside it.
  it('rises with occurrences, calls and output', () => {
    expect(estimateSaved(2, 3, 1000)).toBeGreaterThan(estimateSaved(1, 3, 1000));
    expect(estimateSaved(2, 4, 1000)).toBeGreaterThan(estimateSaved(2, 3, 1000));
    expect(estimateSaved(2, 3, 2000)).toBeGreaterThan(estimateSaved(2, 3, 1000));
  });

  it('is recomputable by hand from the printed inputs', () => {
    expect(estimateSaved(10, 3, 2000)).toBe(10 * (3 + 2));
  });
});

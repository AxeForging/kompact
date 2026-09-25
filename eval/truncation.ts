/**
 * The silent truncation probe, as a script rather than as a table someone typed.
 *
 * Laya's English checkpoint reads 512 tokens of state and discards the rest with
 * HTTP 200 and no warning, so a long state and a much longer one return
 * bit-identical answers. The page has published that finding since the first
 * draft, and until now the three rows behind it existed only as prose — the one
 * claim on the page with no code that reproduces it, on a page whose argument is
 * that every figure is generated.
 *
 * The shape, in two halves. First, the decisive sentence at the FRONT, padded
 * with filler that says nothing about it: two states differing by 32,000
 * characters come back bit-identical, which is the cut made visible. Then the
 * same sentence at the BACK of the same filler, where the cut removes it: the
 * answer collapses although the text still states the fact verbatim.
 *
 * The second half is the one that costs you something. A caller cannot tell the
 * two apart — same HTTP 200, same shape, no warning in either — so whether an
 * answer is about your input or about the first 512 tokens of it is decided by
 * where in the state the evidence happened to fall.
 *
 * Needs a live `laya-serve`. Run: bun eval/truncation.ts [--url ...] [--model english]
 */
import { LayaClient } from '../src/client.js';
import { inputTokens, noulAnswer } from '../src/request.js';
import type { SystemOneQuestions } from '../src/types.js';

const args = process.argv.slice(2);
const flag = (name: string, fallback: string): string => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] ?? fallback : fallback;
};
const baseUrl = flag('--url', process.env['LAYA_URL'] ?? 'http://127.0.0.1:8000/v1/systemone');
const model = flag('--model', 'english');

/** The one sentence the question is about. Nothing else in any state mentions it. */
const FACT = 'The deployment was rolled back at 14:02 because the migration locked the users table.';

/** Plausible prose that says nothing about the rollback. */
const FILLER = Array.from({ length: 48 }, (_, i) =>
  `Note ${i + 1}: the build cache was warm, the linter reported no new findings, and the ` +
  'documentation site rebuilt in under a minute as it usually does on a weekday afternoon.',
).join(' ');

const QUESTION: SystemOneQuestions = {
  rolled_back: {
    type: 'noul',
    instructions: 'The text says the deployment was rolled back',
    criteria: { true: 'it says so', false: 'it does not say so' },
  },
};

const wall = Array(5).fill(FILLER).join(' ');
const states: Array<[string, string]> = [
  ['the sentence alone', FACT],
  ['first, plus filler', `${FACT} ${FILLER}`],
  ['first, plus 5× filler', `${FACT} ${wall}`],
  ['last, after 5× filler', `${wall} ${FACT}`],
];

const client = new LayaClient({ baseUrl, model });
const n = (value: number): string => value.toLocaleString('en-GB');

console.log(`sidecar: ${baseUrl}`);
console.log(`checkpoint: ${model}`);
console.log(`question: "${QUESTION['rolled_back']!.instructions}"`);
console.log(`stated verbatim in every state: "${FACT}"\n`);

const header = `${'state'.padEnd(24)}${'characters'.padStart(11)}${'tokens read'.padStart(13)}${'answer'.padStart(9)}`;
console.log(header);
console.log('-'.repeat(header.length));

const answers: number[] = [];
const tokens: number[] = [];
for (const [name, state] of states) {
  const reply = await client.ask(state, QUESTION);
  const value = noulAnswer(reply.answers, 'rolled_back');
  const read = inputTokens(reply) ?? Number.NaN;
  answers.push(value);
  tokens.push(read);
  console.log(
    `${name.padEnd(24)}${n(state.length).padStart(11)}${String(read).padStart(13)}` +
    `${value.toFixed(4).padStart(9)}`,
  );
}

// Two findings, and the second is the one that costs something.
const identical = answers[1] === answers[2] && tokens[1] === tokens[2];
const lost = answers[3] !== undefined && answers[2] !== undefined && answers[3] < answers[2];
console.log();
console.log(identical
  ? `The cut: ${n(states[1]![1].length)} characters and ${n(states[2]![1].length)} characters both ` +
    `read as ${tokens[1]} tokens and both answer ${answers[1]!.toFixed(4)}, bit-identical. ` +
    `${n(states[2]![1].length - states[1]![1].length)} characters were discarded, with HTTP 200 and no warning.`
  : `The cut did NOT reproduce on ${model}: answers ${answers.map((a) => a.toFixed(4)).join(', ')}, ` +
    `tokens read ${tokens.join(', ')}.`);
console.log(lost
  ? `The cost: move that same sentence to the end of that same filler and the answer falls from ` +
    `${answers[2]!.toFixed(4)} to ${answers[3]!.toFixed(4)} — for a fact the text still states ` +
    `verbatim. Nothing in the response distinguishes the two.`
  : `The cost did NOT reproduce: sentence-last answered ${answers[3]?.toFixed(4)}, not below the ` +
    `sentence-first ${answers[2]?.toFixed(4)}. Report what you got.`);
console.log(
  '\nBoth upstream projects send the whole conversation, up to 25,000 tokens, as a single state.',
);

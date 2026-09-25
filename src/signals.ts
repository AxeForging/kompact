/**
 * Turning what a developer did into a signature that can be counted.
 *
 * The plugin already reads every tool call to decide what to keep. The same
 * observation answers a different question: what does this person do over and
 * over? That is a skill waiting to be written, and nobody writes it because
 * noticing the repetition is the hard part.
 *
 * Everything here is pure string work — no I/O, no Node — so the hook module
 * can import it under its own sandbox and the tests can drive it directly.
 *
 * Two rules the rest of the feature depends on:
 *
 *   1. `redact` runs before anything is stored, on every path. Not "usually" —
 *      the recorder calls it once, at the boundary, so there is exactly one
 *      place to audit and one place for a test to plant a secret.
 *   2. A signature keeps the *shape* and loses the *values*. `npm test -- a.ts`
 *      and `npm test -- b.ts` must collapse; `npm test` and `npm run build`
 *      must not. Over-collapse and unrelated work merges into one meaningless
 *      row; under-collapse and nothing ever reaches a threshold. The tests in
 *      `test/signals.test.ts` are the guard on both directions.
 */

/** What kind of repetition a signature describes. */
export type SignalKind =
  | 'command'      // the same shell invocation, modulo its arguments
  | 'sequence'     // the same run of tools, in order
  | 'intent'       // the same thing asked for, in the developer's own words
  | 'error-fix'    // a failure and the call that resolved it
  | 'correction'   // the developer correcting the assistant
  | 'orient'       // the same files read at the start of a session
  | 'verify';      // the same checks run before handing back

/** One observation, already redacted, ready to be counted. */
export interface Signal {
  kind: SignalKind;
  /** The countable shape. Same work ⇒ same string. */
  sig: string;
  /** A redacted instance, kept so a reader can see what was grouped. */
  sample: string;
  /** Tool calls this observation stands for, for the time estimate. */
  calls: number;
  /** Characters of tool output it moved, for the time estimate. */
  chars: number;
}

/**
 * Patterns that must never reach disk, applied before storage.
 *
 * Deliberately broad and dumb: a false redaction costs a slightly vaguer
 * sample, a missed one costs a secret sitting in a file the developer did not
 * know they were writing. `test/signals.test.ts` plants one of each.
 */
const SECRETS: ReadonlyArray<readonly [RegExp, string]> = [
  // Known token shapes first — these are unambiguous.
  [/\bgh[pousr]_[A-Za-z0-9]{16,}/g, '<token>'],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, '<token>'],
  [/\bAKIA[0-9A-Z]{12,}/g, '<token>'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, '<token>'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '<jwt>'],
  // Anything named like a credential, however it is spelled.
  [/(--?(?:token|key|secret|password|passwd|pwd|auth)[= ])\S+/gi, '$1<secret>'],
  [/\b(?:authorization|x-api-key)\s*:\s*\S+/gi, '<auth-header>'],
  [/\bBearer\s+\S+/gi, 'Bearer <token>'],
  // Credentials inside a URL.
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi, '$1<credentials>@'],
  // A long opaque run is a secret often enough to be worth losing.
  [/\b[A-Fa-f0-9]{32,}\b/g, '<hex>'],
  [/\b[A-Za-z0-9+/]{40,}={0,2}\b/g, '<blob>'],
];

/** Strips anything credential-shaped. Runs once, at the storage boundary. */
export function redact(text: string): string {
  let out = text;
  for (const [pattern, replacement] of SECRETS) out = out.replace(pattern, replacement);
  return out;
}

/** Collapses the parts of a command that vary between runs of the same work. */
const ARGUMENT_SHAPES: ReadonlyArray<readonly [RegExp, string]> = [
  [/'[^']*'/g, '<str>'],
  [/"[^"]*"/g, '<str>'],
  // Any path with a separator, including a bare relative one: `src/state.ts`
  // must not leave `src` behind, which it did while this required a leading `/`.
  [/(?:\.{1,2}\/|\/)?[\w.@-]+(?:\/[\w.@-]+)+\/?/g, '<path>'],
  // A lone filename, once the paths are gone.
  [/\b[\w-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|yml|yaml|toml|py|rs|go|sh|css|html|svg|lock)\b/g, '<path>'],
  // A git sha needs at least one hex letter, or an all-digit CI run id reads as
  // a commit and two different runs stop collapsing onto one signature.
  [/\b(?=[0-9a-f]{7,40}\b)(?=[0-9a-f]*[a-f])[0-9a-f]+\b/g, '<sha>'],
  [/\b\d[\d_,.]*\b/g, '<n>'],
  // `--flag=value` keeps the flag, loses the value.
  [/(--[\w-]+=)\S+/g, '$1<v>'],
];

/**
 * The countable shape of a shell command.
 *
 * `npm test -- test/auth.spec.ts` and `npm test -- test/hook.spec.ts` both give
 * `npm test -- <path>`; `npm test` and `npm run build` stay apart. A pipeline
 * keeps its stages, because `gh run view | tail` is different work from
 * `gh run view`.
 */
export function commandSignature(command: string): string {
  return redact(command)
    .split(/\s*(\|\||&&|\||;)\s*/)
    .map((part) => {
      if (/^(\|\||&&|\||;)$/.test(part)) return part;
      let shape = part.trim();
      for (const [pattern, replacement] of ARGUMENT_SHAPES) shape = shape.replace(pattern, replacement);
      // Repeated placeholders carry no more information than one.
      return shape.replace(/(<(?:path|str|n|sha|v)>)(\s+\1)+/g, '$1').replace(/\s+/g, ' ').trim();
    })
    .join(' ')
    .trim();
}

/** Openers that mark a turn as correcting the assistant rather than asking for something. */
const CORRECTIONS = [
  'no,', 'no ', 'nope', 'actually', "don't", 'dont', 'do not', 'stop', 'wrong',
  'not like that', 'instead', 'why did you', 'i said', 'i told you', 'again,', 'never ',
];

/**
 * Whether a turn reads as a correction.
 *
 * These are the highest-value thing in the whole feature: each one is a standing
 * preference the assistant keeps missing, so the right output is a line in
 * CLAUDE.md rather than a skill. Matched on the opening words only — a "no" in
 * the middle of a paragraph is usually part of an explanation.
 */
export function isCorrection(text: string): boolean {
  const opening = text.trim().toLowerCase().slice(0, 40);
  return CORRECTIONS.some((mark) => opening.startsWith(mark));
}

/** Words too common to tell two requests apart. */
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'that', 'this', 'it', 'its', 'is', 'are',
  'was', 'were', 'be', 'been', 'to', 'of', 'in', 'on', 'for', 'with', 'as', 'at', 'by', 'from',
  'you', 'your', 'i', 'me', 'my', 'we', 'our', 'can', 'could', 'should', 'would', 'will', 'do',
  'does', 'did', 'have', 'has', 'had', 'not', 'so', 'now', 'just', 'please', 'lets', 'let',
]);

/**
 * The countable shape of a request.
 *
 * Keeps the rarest few content words, sorted, so "fix the failing test" and
 * "the test is failing, fix it" land on the same signature. Crude on purpose:
 * anything cleverer needs a model, and this runs on the developer's machine
 * inside a hook budget.
 */
export function intentSignature(text: string, keep = 4): string {
  const words = redact(text)
    .toLowerCase()
    .replace(/```[\s\S]*?```/g, ' ')
    .match(/[a-z][a-z0-9-]{2,}/g) ?? [];
  const seen = new Set<string>();
  const content: string[] = [];
  for (const word of words) {
    if (STOPWORDS.has(word) || seen.has(word)) continue;
    seen.add(word);
    content.push(word);
  }
  return content.slice(0, keep).sort().join(' ');
}

/** The countable shape of a run of tools. Bash keeps its program, so `Bash(npm)` ≠ `Bash(git)`. */
export function sequenceSignature(steps: ReadonlyArray<{ tool: string; command?: string }>): string {
  return steps
    .map((step) => {
      if (step.tool !== 'Bash' || !step.command) return step.tool;
      const program = commandSignature(step.command).split(' ').slice(0, 2).join(' ');
      return `Bash(${program})`;
    })
    .join(' → ');
}

/**
 * What a repetition is worth, as chosen: occurrences × the work each one stands
 * for. It is an estimate and the report says so — every input is printed beside
 * it so a reader can recompute the row by hand.
 */
export function estimateSaved(occurrences: number, calls: number, chars: number): number {
  return occurrences * (calls + chars / 1000);
}

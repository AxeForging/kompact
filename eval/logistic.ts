/**
 * One logistic regression, used by every eval script.
 *
 * Full-batch gradient descent with L2, no library and no framework: thirteen
 * coefficients over a thousand rows does not need one, and a deterministic fit
 * means a reported number can be reproduced exactly.
 */
export const sigmoid = (z: number): number => 1 / (1 + Math.exp(-z));

export const dot = (a: readonly number[], b: readonly number[]): number =>
  a.reduce((sum, value, index) => sum + value * (b[index] ?? 0), 0);

export function fitLogistic(
  xs: readonly (readonly number[])[],
  ys: readonly number[],
  { steps = 20_000, lr = 0.5, l2 = 1e-3 }: { steps?: number; lr?: number; l2?: number } = {},
): number[] {
  const d = xs[0]?.length ?? 0;
  const w = new Array<number>(d).fill(0);
  for (let step = 0; step < steps; step += 1) {
    const g = new Array<number>(d).fill(0);
    for (let i = 0; i < xs.length; i += 1) {
      const e = sigmoid(dot(xs[i]!, w)) - ys[i]!;
      for (let j = 0; j < d; j += 1) g[j]! += (e * xs[i]![j]!) / xs.length;
    }
    for (let j = 1; j < d; j += 1) g[j]! += l2 * w[j]!;
    for (let j = 0; j < d; j += 1) w[j]! -= lr * g[j]!;
  }
  return w;
}

/** Predictions for held-out sessions, fitting once per fold. */
export function outOfFold(
  rows: readonly { session: string }[],
  xs: readonly number[][],
  ys: readonly number[],
  options?: { steps?: number },
): number[] {
  const sessions = [...new Set(rows.map((r) => r.session))];
  const out = new Array<number>(rows.length).fill(0.5);
  for (const held of sessions) {
    const trainIdx = rows.map((_, i) => i).filter((i) => rows[i]!.session !== held);
    const testIdx = rows.map((_, i) => i).filter((i) => rows[i]!.session === held);
    if (trainIdx.length === 0 || testIdx.length === 0) continue;
    const w = fitLogistic(trainIdx.map((i) => xs[i]!), trainIdx.map((i) => ys[i]!), options);
    for (const i of testIdx) out[i] = sigmoid(dot(xs[i]!, w));
  }
  return out;
}

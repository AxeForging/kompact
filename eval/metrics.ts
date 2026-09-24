/**
 * Metrics, kept apart from `score.ts` because that file runs as a script on
 * import: anything importing `auc` from it would silently re-score the whole
 * corpus against the sidecar as a side effect.
 */
/** Area under the ROC curve — rank-based, so it ignores calibration. */
export function auc(scores: readonly number[], labels: readonly boolean[]): number {
  const pairs = scores.map((s, i) => ({ s, y: labels[i]! })).sort((a, b) => a.s - b.s);
  let rankSum = 0;
  let i = 0;
  while (i < pairs.length) {
    let j = i;
    while (j + 1 < pairs.length && pairs[j + 1]!.s === pairs[i]!.s) j += 1;
    const avgRank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k += 1) if (pairs[k]!.y) rankSum += avgRank;
    i = j + 1;
  }
  const pos = labels.filter(Boolean).length;
  const neg = labels.length - pos;
  if (pos === 0 || neg === 0) return NaN;
  return (rankSum - (pos * (pos + 1)) / 2) / (pos * neg);
}

/** Expected calibration error, 15 equal-width bins. */
export function ece(scores: readonly number[], labels: readonly boolean[], bins = 15): number {
  const counts = new Array(bins).fill(0);
  const conf = new Array(bins).fill(0);
  const acc = new Array(bins).fill(0);
  scores.forEach((s, i) => {
    const b = Math.min(bins - 1, Math.floor(s * bins));
    counts[b] += 1;
    conf[b] += s;
    acc[b] += labels[i] ? 1 : 0;
  });
  let total = 0;
  for (let b = 0; b < bins; b += 1) {
    if (counts[b] === 0) continue;
    total += (counts[b] / scores.length) * Math.abs(conf[b] / counts[b] - acc[b] / counts[b]);
  }
  return total;
}

/**
 * The product metric. Sweep the threshold down; at the lowest threshold that
 * still keeps `safety` of the genuinely-needed outputs, report the share of
 * output characters that can be dropped.
 */
export function droppableAt(
  scores: readonly number[],
  labels: readonly boolean[],
  chars: readonly number[],
  safety: number,
): { threshold: number; droppedChars: number; totalChars: number; wrongDrops: number } {
  const totalChars = chars.reduce((a, b) => a + b, 0);
  const positives = labels.filter(Boolean).length;
  let best = { threshold: 1, droppedChars: 0, totalChars, wrongDrops: positives };
  const candidates = [...new Set(scores)].sort((a, b) => a - b);
  for (const threshold of candidates) {
    let keptPositives = 0;
    let droppedChars = 0;
    let wrongDrops = 0;
    scores.forEach((s, i) => {
      const keep = s >= threshold;
      if (labels[i] && keep) keptPositives += 1;
      if (!keep) {
        droppedChars += chars[i]!;
        if (labels[i]) wrongDrops += 1;
      }
    });
    if (positives > 0 && keptPositives / positives < safety) continue;
    if (droppedChars > best.droppedChars) best = { threshold, droppedChars, totalChars, wrongDrops };
  }
  return best;
}


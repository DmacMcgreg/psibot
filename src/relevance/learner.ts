/**
 * Dependency-free learning + evaluation utilities for the relevance engine.
 *
 * - L2-regularised logistic regression fitted by Newton's method (IRLS) on
 *   standardised features: Jev feature probabilities → P(relevant).
 * - Seeded RNG, stratified split and k-fold, lambda selection by out-of-fold
 *   log-loss, threshold selection for a target precision.
 * - Metrics: ROC AUC (Mann–Whitney, tie-aware), bootstrap CI, precision /
 *   recall / accuracy at a threshold, calibration buckets.
 */

// ─── RNG + splits ───────────────────────────────────────────────────────────

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffleInPlace<T>(arr: T[], rng: () => number): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** Stratified train/test split over indices; each class split at testFrac. */
export function stratifiedSplit(labels: number[], testFrac: number, seed: number): { train: number[]; test: number[] } {
  const rng = mulberry32(seed);
  const train: number[] = [];
  const test: number[] = [];
  for (const cls of [...new Set(labels)].sort()) {
    const idx = shuffleInPlace(labels.map((l, i) => (l === cls ? i : -1)).filter((i) => i >= 0), rng);
    const nTest = Math.round(idx.length * testFrac);
    test.push(...idx.slice(0, nTest));
    train.push(...idx.slice(nTest));
  }
  return { train: train.sort((a, b) => a - b), test: test.sort((a, b) => a - b) };
}

/** Stratified k folds (fold id per index). k is clamped to the minority class size. */
export function stratifiedFolds(labels: number[], k: number, seed: number): number[] {
  const rng = mulberry32(seed);
  const minority = Math.min(...[...new Set(labels)].map((c) => labels.filter((l) => l === c).length));
  const kk = Math.max(2, Math.min(k, minority));
  const folds = new Array<number>(labels.length).fill(0);
  for (const cls of [...new Set(labels)].sort()) {
    const idx = shuffleInPlace(labels.map((l, i) => (l === cls ? i : -1)).filter((i) => i >= 0), rng);
    idx.forEach((i, j) => (folds[i] = j % kk));
  }
  return folds;
}

// ─── logistic regression ────────────────────────────────────────────────────

export interface LogisticModel {
  weights: number[];
  bias: number;
  means: number[];
  sds: number[];
  lambda: number;
}

export function sigmoid(z: number): number {
  if (z >= 0) return 1 / (1 + Math.exp(-z));
  const e = Math.exp(z);
  return e / (1 + e);
}

/** Solve A x = b by Gaussian elimination with partial pivoting (A is d×d). */
export function solveLinear(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    [M[col], M[piv]] = [M[piv], M[col]];
    const p = M[col][col];
    if (Math.abs(p) < 1e-12) continue;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col] / p;
      if (f === 0) continue;
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  return M.map((row, i) => (Math.abs(row[i]) < 1e-12 ? 0 : row[n] / row[i]));
}

export interface FitOptions {
  lambda?: number;
  iterations?: number;
  /** Per-sample weights (e.g. class balancing). */
  sampleWeights?: number[];
}

/**
 * Fit P(y=1|x) = sigmoid(w·z + b) with z the standardised x, penalty
 * (lambda/2)·|w|² (bias unpenalised). Newton/IRLS converges in a few steps for
 * the small feature counts used here.
 */
export function fitLogistic(X: number[][], y: number[], opts: FitOptions = {}): LogisticModel {
  const n = X.length;
  if (n === 0) throw new Error("fitLogistic: no rows");
  const d = X[0].length;
  const lambda = opts.lambda ?? 1;
  const sw = opts.sampleWeights ?? new Array(n).fill(1);
  const means = new Array(d).fill(0);
  const sds = new Array(d).fill(0);
  for (let j = 0; j < d; j++) {
    for (let i = 0; i < n; i++) means[j] += X[i][j];
    means[j] /= n;
    for (let i = 0; i < n; i++) sds[j] += (X[i][j] - means[j]) ** 2;
    sds[j] = Math.sqrt(sds[j] / n) || 1;
  }
  // Augmented design: [1, z_1..z_d]
  const Z = X.map((row) => [1, ...row.map((v, j) => (v - means[j]) / sds[j])]);
  const D = d + 1;
  let beta = new Array(D).fill(0);
  const iters = opts.iterations ?? 30;
  for (let it = 0; it < iters; it++) {
    const g = new Array(D).fill(0);
    const H = Array.from({ length: D }, () => new Array(D).fill(0));
    for (let i = 0; i < n; i++) {
      let z = 0;
      for (let j = 0; j < D; j++) z += beta[j] * Z[i][j];
      const p = sigmoid(z);
      const w = sw[i] * Math.max(p * (1 - p), 1e-9);
      const r = sw[i] * (p - y[i]);
      for (let j = 0; j < D; j++) {
        g[j] += r * Z[i][j];
        const zij = Z[i][j] * w;
        for (let k = j; k < D; k++) H[j][k] += zij * Z[i][k];
      }
    }
    for (let j = 0; j < D; j++) for (let k = 0; k < j; k++) H[j][k] = H[k][j];
    for (let j = 1; j < D; j++) {
      g[j] += lambda * beta[j];
      H[j][j] += lambda;
    }
    H[0][0] += 1e-6;
    const step = solveLinear(H, g);
    let maxStep = 0;
    beta = beta.map((b, j) => {
      maxStep = Math.max(maxStep, Math.abs(step[j]));
      return b - step[j];
    });
    if (maxStep < 1e-7) break;
  }
  return { bias: beta[0], weights: beta.slice(1), means, sds, lambda };
}

export function predictLogistic(m: LogisticModel, x: number[]): number {
  let z = m.bias;
  for (let j = 0; j < m.weights.length; j++) z += m.weights[j] * ((x[j] - m.means[j]) / m.sds[j]);
  return sigmoid(z);
}

export function logLoss(p: number[], y: number[]): number {
  let s = 0;
  for (let i = 0; i < p.length; i++) {
    const q = Math.min(1 - 1e-12, Math.max(1e-12, p[i]));
    s -= y[i] ? Math.log(q) : Math.log(1 - q);
  }
  return s / Math.max(1, p.length);
}

export interface CvResult {
  lambda: number;
  oof: number[];
  lossByLambda: Record<string, number>;
}

/** Choose lambda by k-fold out-of-fold log-loss; returns OOF predictions at the best lambda. */
export function cvSelectLambda(
  X: number[][],
  y: number[],
  lambdas = [0.01, 0.1, 1, 3, 10, 30, 100],
  k = 5,
  seed = 13,
): CvResult {
  const folds = stratifiedFolds(y, k, seed);
  const K = Math.max(...folds) + 1;
  let best = { lambda: lambdas[0], loss: Infinity, oof: [] as number[] };
  const lossByLambda: Record<string, number> = {};
  for (const lambda of lambdas) {
    const oof = new Array(y.length).fill(0);
    for (let f = 0; f < K; f++) {
      const tr = y.map((_, i) => i).filter((i) => folds[i] !== f);
      const te = y.map((_, i) => i).filter((i) => folds[i] === f);
      const m = fitLogistic(tr.map((i) => X[i]), tr.map((i) => y[i]), { lambda });
      for (const i of te) oof[i] = predictLogistic(m, X[i]);
    }
    const loss = logLoss(oof, y);
    lossByLambda[String(lambda)] = loss;
    if (loss < best.loss) best = { lambda, loss, oof };
  }
  return { lambda: best.lambda, oof: best.oof, lossByLambda };
}

// ─── metrics ────────────────────────────────────────────────────────────────

/** ROC AUC via the Mann–Whitney statistic with average ranks for ties. Null if one class is absent. */
export function auc(scores: number[], labels: number[]): number | null {
  const pairs = scores.map((s, i) => ({ s, y: labels[i] })).filter((p) => Number.isFinite(p.s));
  const nPos = pairs.filter((p) => p.y === 1).length;
  const nNeg = pairs.length - nPos;
  if (nPos === 0 || nNeg === 0) return null;
  pairs.sort((a, b) => a.s - b.s);
  let rankSumPos = 0;
  let i = 0;
  while (i < pairs.length) {
    let j = i;
    while (j + 1 < pairs.length && pairs[j + 1].s === pairs[i].s) j++;
    const avgRank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) if (pairs[k].y === 1) rankSumPos += avgRank;
    i = j + 1;
  }
  return (rankSumPos - (nPos * (nPos + 1)) / 2) / (nPos * nNeg);
}

/** Percentile bootstrap 95% CI for AUC (stratified resampling). */
export function aucBootstrapCI(scores: number[], labels: number[], reps = 1000, seed = 99): [number, number] | null {
  const pos = labels.map((l, i) => (l === 1 ? i : -1)).filter((i) => i >= 0);
  const neg = labels.map((l, i) => (l === 0 ? i : -1)).filter((i) => i >= 0);
  if (!pos.length || !neg.length) return null;
  const rng = mulberry32(seed);
  const vals: number[] = [];
  for (let r = 0; r < reps; r++) {
    const idx = [
      ...pos.map(() => pos[Math.floor(rng() * pos.length)]),
      ...neg.map(() => neg[Math.floor(rng() * neg.length)]),
    ];
    const a = auc(idx.map((i) => scores[i]), idx.map((i) => labels[i]));
    if (a !== null) vals.push(a);
  }
  vals.sort((a, b) => a - b);
  return [vals[Math.floor(0.025 * vals.length)], vals[Math.min(vals.length - 1, Math.floor(0.975 * vals.length))]];
}

export interface ThresholdMetrics {
  threshold: number;
  n: number;
  tp: number;
  fp: number;
  tn: number;
  fn: number;
  accuracy: number;
  precision: number | null;
  recall: number | null;
  f1: number | null;
}

export function metricsAt(scores: number[], labels: number[], threshold: number): ThresholdMetrics {
  let tp = 0;
  let fp = 0;
  let tn = 0;
  let fn = 0;
  for (let i = 0; i < scores.length; i++) {
    const pred = scores[i] >= threshold;
    if (pred && labels[i] === 1) tp++;
    else if (pred) fp++;
    else if (labels[i] === 1) fn++;
    else tn++;
  }
  const precision = tp + fp ? tp / (tp + fp) : null;
  const recall = tp + fn ? tp / (tp + fn) : null;
  const f1 = precision !== null && recall !== null && precision + recall > 0
    ? (2 * precision * recall) / (precision + recall)
    : null;
  return { threshold, n: scores.length, tp, fp, tn, fn, accuracy: (tp + tn) / Math.max(1, scores.length), precision, recall, f1 };
}

/**
 * Lowest threshold whose precision ≥ target (maximises recall at that
 * precision). Falls back to the max-F1 threshold when the target is
 * unreachable; `reached` says which.
 */
export function chooseThreshold(scores: number[], labels: number[], targetPrecision: number): { threshold: number; reached: boolean } {
  const cands = [...new Set(scores)].sort((a, b) => a - b);
  let bestF1 = { t: 0.5, f1: -1 };
  for (const t of cands) {
    const m = metricsAt(scores, labels, t);
    if (m.precision !== null && m.precision >= targetPrecision && m.tp > 0) return { threshold: t, reached: true };
    if ((m.f1 ?? -1) > bestF1.f1) bestF1 = { t, f1: m.f1 ?? -1 };
  }
  return { threshold: bestF1.t, reached: false };
}

export interface CalibrationBucket {
  lo: number;
  hi: number;
  n: number;
  meanPredicted: number | null;
  observedRate: number | null;
}

export function calibrationBuckets(probs: number[], labels: number[], nBins = 5): CalibrationBucket[] {
  const out: CalibrationBucket[] = [];
  for (let b = 0; b < nBins; b++) {
    const lo = b / nBins;
    const hi = (b + 1) / nBins;
    const idx = probs.map((p, i) => (p >= lo && (p < hi || (b === nBins - 1 && p <= hi)) ? i : -1)).filter((i) => i >= 0);
    out.push({
      lo,
      hi,
      n: idx.length,
      meanPredicted: idx.length ? idx.reduce((s, i) => s + probs[i], 0) / idx.length : null,
      observedRate: idx.length ? idx.reduce((s, i) => s + labels[i], 0) / idx.length : null,
    });
  }
  return out;
}

/** Brier score (mean squared error of probabilities). */
export function brier(probs: number[], labels: number[]): number {
  return probs.reduce((s, p, i) => s + (p - labels[i]) ** 2, 0) / Math.max(1, probs.length);
}

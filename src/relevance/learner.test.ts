import { describe, expect, it } from "bun:test";
import {
  auc,
  aucBootstrapCI,
  calibrationBuckets,
  chooseThreshold,
  cvSelectLambda,
  fitLogistic,
  metricsAt,
  mulberry32,
  predictLogistic,
  solveLinear,
  stratifiedFolds,
  stratifiedSplit,
} from "./learner.ts";

describe("auc", () => {
  it("is 1 for perfect separation and 0 for inverted", () => {
    expect(auc([0.1, 0.2, 0.8, 0.9], [0, 0, 1, 1])).toBe(1);
    expect(auc([0.9, 0.8, 0.2, 0.1], [0, 0, 1, 1])).toBe(0);
  });
  it("counts ties as half", () => {
    expect(auc([0.5, 0.5], [0, 1])).toBe(0.5);
    expect(auc([0.1, 0.5, 0.5, 0.9], [0, 0, 1, 1])).toBeCloseTo(0.875, 10);
  });
  it("returns null when a class is missing", () => {
    expect(auc([0.1, 0.2], [1, 1])).toBeNull();
  });
  it("bootstrap CI brackets the point estimate", () => {
    const rng = mulberry32(3);
    const y = Array.from({ length: 200 }, (_, i) => (i % 2));
    const s = y.map((v) => v * 0.6 + rng());
    const a = auc(s, y)!;
    const ci = aucBootstrapCI(s, y, 300)!;
    expect(ci[0]).toBeLessThanOrEqual(a);
    expect(ci[1]).toBeGreaterThanOrEqual(a);
  });
});

describe("solveLinear", () => {
  it("solves a 3x3 system", () => {
    const x = solveLinear([[2, 1, -1], [-3, -1, 2], [-2, 1, 2]], [8, -11, -3]);
    expect(x[0]).toBeCloseTo(2, 8);
    expect(x[1]).toBeCloseTo(3, 8);
    expect(x[2]).toBeCloseTo(-1, 8);
  });
});

describe("fitLogistic", () => {
  // y depends on x0 only; x1 is noise.
  const rng = mulberry32(11);
  const X: number[][] = [];
  const y: number[] = [];
  for (let i = 0; i < 400; i++) {
    const x0 = rng();
    const x1 = rng();
    X.push([x0, x1]);
    y.push(rng() < 1 / (1 + Math.exp(-(8 * x0 - 4))) ? 1 : 0);
  }

  it("recovers the informative feature and ranks well", () => {
    const m = fitLogistic(X, y, { lambda: 0.1 });
    expect(Math.abs(m.weights[0])).toBeGreaterThan(5 * Math.abs(m.weights[1]));
    expect(m.weights[0]).toBeGreaterThan(0);
    const p = X.map((x) => predictLogistic(m, x));
    expect(auc(p, y)!).toBeGreaterThan(0.8);
    expect(p.every((v) => v > 0 && v < 1)).toBe(true);
  });

  it("shrinks weights as lambda grows", () => {
    const small = fitLogistic(X, y, { lambda: 0.01 });
    const big = fitLogistic(X, y, { lambda: 1000 });
    expect(Math.abs(big.weights[0])).toBeLessThan(Math.abs(small.weights[0]));
  });

  it("survives perfectly separable data (L2 keeps it finite)", () => {
    const m = fitLogistic([[0], [0.1], [0.9], [1]], [0, 0, 1, 1], { lambda: 1 });
    expect(Number.isFinite(m.weights[0])).toBe(true);
    expect(predictLogistic(m, [1])).toBeGreaterThan(0.5);
  });

  it("handles a constant column", () => {
    const m = fitLogistic(X.map((x) => [x[0], 1]), y, { lambda: 1 });
    expect(Number.isFinite(m.weights[1])).toBe(true);
  });

  it("cv picks a lambda and returns aligned out-of-fold predictions", () => {
    const cv = cvSelectLambda(X, y, [0.1, 10], 5, 1);
    expect([0.1, 10]).toContain(cv.lambda);
    expect(cv.oof.length).toBe(y.length);
    expect(auc(cv.oof, y)!).toBeGreaterThan(0.75);
  });
});

describe("splits", () => {
  const labels = [...Array(70).fill(1), ...Array(30).fill(0)];
  it("stratified split keeps class ratios and is deterministic", () => {
    const a = stratifiedSplit(labels, 0.3, 42);
    const b = stratifiedSplit(labels, 0.3, 42);
    expect(a).toEqual(b);
    expect(a.test.filter((i) => labels[i] === 1).length).toBe(21);
    expect(a.test.filter((i) => labels[i] === 0).length).toBe(9);
    expect(new Set([...a.train, ...a.test]).size).toBe(100);
  });
  it("folds are clamped to the minority class size", () => {
    const folds = stratifiedFolds([1, 1, 1, 1, 0, 0], 5, 1);
    expect(Math.max(...folds) + 1).toBe(2);
  });
});

describe("thresholds + calibration", () => {
  const s = [0.1, 0.2, 0.3, 0.6, 0.7, 0.8, 0.9];
  const y = [0, 0, 1, 0, 1, 1, 1];
  it("metricsAt counts the confusion matrix", () => {
    const m = metricsAt(s, y, 0.6);
    expect([m.tp, m.fp, m.tn, m.fn]).toEqual([3, 1, 2, 1]);
    expect(m.precision).toBeCloseTo(0.75);
    expect(m.recall).toBeCloseTo(0.75);
  });
  it("chooseThreshold returns the lowest threshold meeting the precision target", () => {
    const t = chooseThreshold(s, y, 1.0);
    expect(t.reached).toBe(true);
    expect(t.threshold).toBe(0.7);
  });
  it("falls back to max-F1 when the target is unreachable", () => {
    const t = chooseThreshold([0.9, 0.8], [0, 1], 0.99);
    expect(t.reached).toBe(false);
  });
  it("calibration buckets partition all rows", () => {
    const b = calibrationBuckets(s, y, 5);
    expect(b.reduce((n, x) => n + x.n, 0)).toBe(s.length);
    expect(b[4].observedRate).toBe(1);
  });
});

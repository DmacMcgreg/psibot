/**
 * Relevance engine: Jev batteries → named feature vectors → per-type learned
 * logistic model → P(relevant) + category.
 *
 * Self-learning loop (see cli.ts `retrain`):
 *   labels (human decisions) → profile text → featurize labeled items →
 *   fit per-type logistic + choose threshold at a target precision →
 *   data/relevance/model.json. Scoring new items loads that file.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { expectedScore, type JevClient, type JevResult, type Payload, type RawAnswer } from "./jev.ts";
import type { ItemType, RelItem } from "./labels.ts";
import {
  chooseThreshold,
  cvSelectLambda,
  fitLogistic,
  predictLogistic,
  type LogisticModel,
} from "./learner.ts";
import { contentBattery, featureNames, gateOnly, profileBattery } from "./questions.ts";

export const MODEL_PATH = "data/relevance/model.json";

export interface CategoryAnswer {
  pick: string;
  confidence: number | null;
  probs: Record<string, number>;
}

export interface FeatureRow {
  key: string;
  type: ItemType;
  features: Record<string, number>;
  category: CategoryAnswer | null;
  /** Gate asked alone (benchmark baseline); null unless requested. */
  gateOnly: number | null;
  errors: string[];
}

function noulOf(a: RawAnswer | undefined): number | null {
  return a && typeof a.noul === "number" ? a.noul : null;
}

function categoryOf(a: RawAnswer | undefined): CategoryAnswer | null {
  if (!a || typeof a.choice !== "string") return null;
  return { pick: a.choice, confidence: a.confidence ?? null, probs: a.probabilities ?? {} };
}

export interface FeaturizeOptions {
  /** Item keys that also get a separate gate-only call. */
  gateOnlyKeys?: Set<string>;
  onProgress?: (done: number, total: number) => void;
}

/** Run all batteries for `items` and assemble one FeatureRow per item. */
export async function featurize(
  client: JevClient,
  items: RelItem[],
  profile: string,
  groups: Record<string, string>,
  opts: FeaturizeOptions = {},
): Promise<Map<string, FeatureRow>> {
  type Job = { key: string; kind: "content" | "profile" | "gate"; payload: Payload };
  const jobs: Job[] = [];
  for (const it of items) {
    jobs.push({ key: it.key, kind: "content", payload: contentBattery(it, groups) });
    const pb = profileBattery(it, profile);
    if (pb) jobs.push({ key: it.key, kind: "profile", payload: pb });
    if (opts.gateOnlyKeys?.has(it.key)) {
      const g = gateOnly(it, profile);
      if (g) jobs.push({ key: it.key, kind: "gate", payload: g });
    }
  }
  const results = await client.askMany(jobs.map((j) => j.payload), opts.onProgress);

  const byKey = new Map<string, Partial<Record<Job["kind"], JevResult | Error>>>();
  jobs.forEach((j, i) => {
    const m = byKey.get(j.key) ?? {};
    m[j.kind] = results[i];
    byKey.set(j.key, m);
  });

  const out = new Map<string, FeatureRow>();
  for (const it of items) {
    const r = byKey.get(it.key) ?? {};
    const errors: string[] = [];
    const features: Record<string, number> = {};
    let category: CategoryAnswer | null = null;
    let gate: number | null = null;
    for (const kind of ["content", "profile", "gate"] as const) {
      const res = r[kind];
      if (res instanceof Error) errors.push(`${kind}: ${res.message}`);
    }
    const content = r.content instanceof Error ? null : r.content;
    const prof = r.profile instanceof Error ? null : r.profile;
    const g = r.gate instanceof Error ? null : r.gate;

    if (content) {
      for (const [k, a] of Object.entries(content.answers)) {
        const v = noulOf(a);
        if (v !== null) features[k] = v;
      }
      if (it.type === "video") category = categoryOf(content.answers.category);
      if (it.type === "article") category = categoryOf(content.answers.value_type);
      if (it.type === "entity") {
        const es = expectedScore(content.answers.link_state);
        if (es !== null) features.link_state = es / 2;
        features.alias_is_separate_entity = it.content.alias_is_separate_entity ? 1 : 0;
        features.log_containing = Math.log1p(Number(it.content.other_entities_containing_alias ?? 0));
      }
    }
    if (prof) {
      for (const [k, a] of Object.entries(prof.answers)) {
        const v = noulOf(a);
        if (v !== null) features[k] = v;
      }
    }
    if (g) gate = noulOf(g.answers.relevant);
    out.set(it.key, { key: it.key, type: it.type, features, category, gateOnly: gate, errors });
  }
  return out;
}

/** Feature vector in canonical order; null when any feature is missing. */
export function vectorize(row: FeatureRow, names = featureNames(row.type)): number[] | null {
  const v: number[] = [];
  for (const n of names) {
    const x = row.features[n];
    if (typeof x !== "number" || !Number.isFinite(x)) return null;
    v.push(x);
  }
  return v;
}

/** The single-number Jev signal used when no learner can be fitted. */
export function gateSignal(row: FeatureRow): number | null {
  const k = row.type === "entity" ? "link_state" : "relevant";
  const v = row.features[k];
  return typeof v === "number" ? v : null;
}

// ─── per-type model ─────────────────────────────────────────────────────────

export interface TypeModel {
  type: ItemType;
  featureNames: string[];
  /** Null when there were too few labels of one class: the gate signal is used instead. */
  logistic: LogisticModel | null;
  threshold: number;
  targetPrecision: number;
  thresholdReached: boolean;
  trainedOn: { n: number; positives: number; negatives: number };
  note: string;
}

export interface FitTypeOptions {
  targetPrecision: number;
  minPerClass?: number;
  seed?: number;
}

export interface FitTypeResult {
  model: TypeModel;
  /** Out-of-fold P(relevant) for the training rows (for threshold/calibration diagnostics). */
  oof: number[];
}

export function fitTypeModel(type: ItemType, X: number[][], y: number[], opts: FitTypeOptions): FitTypeResult {
  const names = featureNames(type);
  const pos = y.filter((v) => v === 1).length;
  const neg = y.length - pos;
  const minPerClass = opts.minPerClass ?? 8;
  if (pos < minPerClass || neg < minPerClass) {
    // Too few of one class to learn weights: fall back to the gate column.
    const gi = 0;
    const scores = X.map((r) => r[gi]);
    const t = pos && neg ? chooseThreshold(scores, y, opts.targetPrecision) : { threshold: 0.5, reached: false };
    return {
      model: {
        type,
        featureNames: names,
        logistic: null,
        threshold: t.threshold,
        targetPrecision: opts.targetPrecision,
        thresholdReached: t.reached,
        trainedOn: { n: y.length, positives: pos, negatives: neg },
        note: `gate fallback: needs >= ${minPerClass} labels per class`,
      },
      oof: scores,
    };
  }
  const cv = cvSelectLambda(X, y, undefined, 5, opts.seed ?? 13);
  const logistic = fitLogistic(X, y, { lambda: cv.lambda });
  const t = chooseThreshold(cv.oof, y, opts.targetPrecision);
  return {
    model: {
      type,
      featureNames: names,
      logistic,
      threshold: t.threshold,
      targetPrecision: opts.targetPrecision,
      thresholdReached: t.reached,
      trainedOn: { n: y.length, positives: pos, negatives: neg },
      note: `logistic, lambda=${cv.lambda} (5-fold CV log-loss)`,
    },
    oof: cv.oof,
  };
}

export function predictType(m: TypeModel, x: number[]): number {
  return m.logistic ? predictLogistic(m.logistic, x) : x[0];
}

// ─── model file ─────────────────────────────────────────────────────────────

export interface RelevanceModel {
  version: 1;
  trainedAt: string;
  jevModel: string;
  profile: { text: string; hash: string };
  groups: Record<string, string>;
  types: Partial<Record<ItemType, TypeModel>>;
}

export function saveModel(m: RelevanceModel, path = MODEL_PATH): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(m, null, 2));
}

export function loadModel(path = MODEL_PATH): RelevanceModel | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf-8")) as RelevanceModel;
}

export interface Scored {
  key: string;
  title: string;
  pRelevant: number | null;
  decision: "relevant" | "not_relevant" | "unknown";
  category: CategoryAnswer | null;
  features: Record<string, number>;
}

/** Score items with a trained model (featurizes with the model's profile). */
export async function scoreItems(client: JevClient, model: RelevanceModel, items: RelItem[]): Promise<Scored[]> {
  const rows = await featurize(client, items, model.profile.text, model.groups);
  return items.map((it) => {
    const row = rows.get(it.key)!;
    const tm = model.types[it.type];
    const x = tm ? vectorize(row, tm.featureNames) : null;
    const p = tm && x ? predictType(tm, x) : null;
    return {
      key: it.key,
      title: it.title,
      pRelevant: p,
      decision: p === null ? "unknown" : p >= tm!.threshold ? "relevant" : "not_relevant",
      category: row.category,
      features: row.features,
    };
  });
}

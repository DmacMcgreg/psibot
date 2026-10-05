/**
 * Benchmark: Jev relevance engine vs the user's real past choices.
 *
 * Per item type it reports n, class balance, ROC AUC (with bootstrap 95% CI),
 * accuracy/precision/recall at the chosen threshold, calibration buckets and
 * cost, for:
 *   - learned  — logistic over Jev features (trained on the train split)
 *   - gate     — the single relevance noul asked alone with the profile
 *   - gate_in_battery — the same noul inside the profile battery
 *   - existing — PsiBot's current signals (triage priority, signal_score,
 *                discovery score), where present
 *
 * Videos are evaluated as positive-unlabeled (PU): "chosen" videos vs
 * discovery-found videos with no feedback. Unlabeled ≠ negative, so the video
 * precision numbers are lower bounds and AUC is a PU-AUC; the handful of
 * explicit video rejections are reported as a separate spot check.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { JevClient } from "./jev.ts";
import {
  loadArticles,
  loadEntities,
  loadTopicGroups,
  loadVideos,
  labelStats,
  openReadonly,
  type ItemType,
  type LabelStats,
  type RelItem,
} from "./labels.ts";
import {
  auc,
  aucBootstrapCI,
  brier,
  calibrationBuckets,
  metricsAt,
  mulberry32,
  shuffleInPlace,
  stratifiedSplit,
  type CalibrationBucket,
  type ThresholdMetrics,
} from "./learner.ts";
import { buildProfile } from "./profile.ts";
import { featureNames } from "./questions.ts";
import { featurize, fitTypeModel, gateSignal, predictType, vectorize, type FeatureRow, type TypeModel } from "./engine.ts";

export interface BenchOptions {
  dbPath: string;
  seed: number;
  testFrac: number;
  targetPrecision: Record<ItemType, number>;
  /** Cap items per type (stratified sample) — for dry runs / budget fitting. */
  limitPerType: number | null;
  types: ItemType[];
  outDir: string;
  /** Also benchmark videos from title + channel only (what discovery has before processing). */
  titleOnlyArm: boolean;
}

interface Arm {
  name: string;
  n: number;
  auc: number | null;
  aucCI: [number, number] | null;
  atThreshold: ThresholdMetrics | null;
  brier?: number;
  calibration?: CalibrationBucket[];
  coverage: string;
}

interface TypeReport {
  type: ItemType;
  labels: LabelStats;
  evaluation: string;
  split: { train: number; trainAfterExemplars: number; test: number; testPos: number; testNeg: number };
  model: TypeModel | null;
  weights: Array<{ feature: string; coef: number }>;
  arms: Arm[];
  gateBatchingCorrelation: number | null;
  category: {
    agreementWithExisting: number | null;
    existingLabel: string;
    meanConfidence: number | null;
    relevantRateByCategory: Array<{ category: string; n: number; relevantRate: number }>;
  } | null;
  spotChecks: Array<Record<string, unknown>>;
  failedItems: number;
}

function pearson(a: number[], b: number[]): number | null {
  const n = a.length;
  if (n < 3) return null;
  const ma = a.reduce((s, x) => s + x, 0) / n;
  const mb = b.reduce((s, x) => s + x, 0) / n;
  let sab = 0;
  let saa = 0;
  let sbb = 0;
  for (let i = 0; i < n; i++) {
    sab += (a[i] - ma) * (b[i] - mb);
    saa += (a[i] - ma) ** 2;
    sbb += (b[i] - mb) ** 2;
  }
  return saa && sbb ? sab / Math.sqrt(saa * sbb) : null;
}

function arm(name: string, scores: Array<number | null>, labels: number[], threshold: number | null, withCalibration = false): Arm {
  const idx = scores.map((s, i) => (s === null || !Number.isFinite(s) ? -1 : i)).filter((i) => i >= 0);
  const s = idx.map((i) => scores[i] as number);
  const y = idx.map((i) => labels[i]);
  const out: Arm = {
    name,
    n: s.length,
    auc: auc(s, y),
    aucCI: aucBootstrapCI(s, y, 500),
    atThreshold: threshold === null ? null : metricsAt(s, y, threshold),
    coverage: `${s.length}/${scores.length}`,
  };
  if (withCalibration) {
    out.brier = brier(s, y);
    out.calibration = calibrationBuckets(s, y, 5);
  }
  return out;
}

/** Stratified sample of at most n items, by labelKind. */
function sampleItems(items: RelItem[], n: number | null, seed: number): RelItem[] {
  if (n === null || items.length <= n) return items;
  const rng = mulberry32(seed);
  const byKind = new Map<string, RelItem[]>();
  for (const it of items) (byKind.get(it.labelKind) ?? byKind.set(it.labelKind, []).get(it.labelKind)!).push(it);
  const out: RelItem[] = [];
  for (const group of byKind.values()) {
    const k = Math.max(1, Math.round((group.length / items.length) * n));
    out.push(...shuffleInPlace([...group], rng).slice(0, k));
  }
  return out;
}

export async function runBench(client: JevClient, opts: BenchOptions): Promise<{ jsonPath: string; mdPath: string; report: Record<string, unknown> }> {
  const db = openReadonly(opts.dbPath);
  const groups = loadTopicGroups(db);
  const all: Record<ItemType, RelItem[]> = {
    video: loadVideos(db),
    article: loadArticles(db),
    entity: loadEntities(db).items,
  };
  const entityMeta = loadEntities(db);
  db.close();

  const stats = {
    video: labelStats("video", all.video),
    article: labelStats("article", all.article),
    entity: labelStats("entity", all.entity),
  };

  // ── split (video: PU label; stratify by labelKind so explicit rejections land on both sides)
  const split: Record<ItemType, { train: RelItem[]; test: RelItem[] }> = {
    video: { train: [], test: [] },
    article: { train: [], test: [] },
    entity: { train: [], test: [] },
  };
  for (const t of ["video", "article"] as const) {
    if (!opts.types.includes(t)) continue;
    const pool = sampleItems(t === "video" ? all.video : all.article.filter((i) => i.label !== null), opts.limitPerType, opts.seed);
    const kinds = [...new Set(pool.map((i) => i.labelKind))].sort();
    const strat = pool.map((i) => kinds.indexOf(i.labelKind));
    const s = stratifiedSplit(strat, opts.testFrac, opts.seed);
    split[t] = { train: s.train.map((i) => pool[i]), test: s.test.map((i) => pool[i]) };
  }
  if (opts.types.includes("entity")) {
    split.entity = { train: [], test: sampleItems(all.entity, opts.limitPerType, opts.seed) };
  }

  // ── profile from TRAIN labels only
  const trainLabeled = [...split.video.train, ...split.article.train].filter((i) => i.label !== null);
  const profile = buildProfile(trainLabeled, { seed: opts.seed, groupLabels: groups });
  const exemplars = new Set(profile.exemplarKeys);

  // ── featurize everything in scope
  const scope = [...split.video.train, ...split.video.test, ...split.article.train, ...split.article.test, ...split.entity.test];
  const gateKeys = new Set([...split.video.test, ...split.article.test].map((i) => i.key));
  const t0 = Date.now();
  let lastLog = 0;
  const rows = await featurize(client, scope, profile.text, groups, {
    gateOnlyKeys: gateKeys,
    onProgress: (d, n) => {
      if (Date.now() - lastLog > 5000 || d === n) {
        lastLog = Date.now();
        process.stderr.write(`  featurize ${d}/${n} ${client.meter()}\n`);
      }
    },
  });
  // Title+channel-only variant of every video (discovery's pre-processing view).
  const titleOnlyKey = (k: string) => `${k}#title`;
  const titleOnly = (i: RelItem): RelItem => ({ ...i, key: titleOnlyKey(i.key), content: { title: i.content.title, channel: i.content.channel } });
  let titleRows = new Map<string, FeatureRow>();
  if (opts.titleOnlyArm && opts.types.includes("video")) {
    const tItems = [...split.video.train, ...split.video.test].map(titleOnly);
    titleRows = await featurize(client, tItems, profile.text, groups, {
      gateOnlyKeys: new Set(split.video.test.map((i) => titleOnlyKey(i.key))),
      onProgress: (d, n) => {
        if (Date.now() - lastLog > 5000 || d === n) {
          lastLog = Date.now();
          process.stderr.write(`  featurize(title-only) ${d}/${n} ${client.meter()}\n`);
        }
      },
    });
  }
  const featurizeSeconds = (Date.now() - t0) / 1000;

  const reports: TypeReport[] = [];

  for (const t of ["video", "article"] as const) {
    if (!opts.types.includes(t)) continue;
    const names = featureNames(t);
    const yOf = (i: RelItem) => (i.label === 1 ? 1 : 0); // PU for videos: unlabeled → 0
    const trainItems = split[t].train.filter((i) => !exemplars.has(i.key));
    const trainRows = trainItems
      .map((i) => ({ i, x: vectorize(rows.get(i.key)!, names) }))
      .filter((r): r is { i: RelItem; x: number[] } => r.x !== null);
    const testRows = split[t].test
      .map((i) => ({ i, row: rows.get(i.key)!, x: vectorize(rows.get(i.key)!, names) }))
      .filter((r) => r.x !== null) as Array<{ i: RelItem; row: FeatureRow; x: number[] }>;
    const failed = [...split[t].train, ...split[t].test].filter((i) => {
      const row = rows.get(i.key);
      return !row || row.errors.length > 0 || vectorize(row, names) === null;
    }).length;

    const fit = fitTypeModel(t, trainRows.map((r) => r.x), trainRows.map((r) => yOf(r.i)), { targetPrecision: opts.targetPrecision[t], seed: opts.seed });
    const yTest = testRows.map((r) => yOf(r.i));
    const learned = testRows.map((r) => predictType(fit.model, r.x));
    const gateB = testRows.map((r) => gateSignal(r.row));
    const gateO = testRows.map((r) => r.row.gateOnly);

    const arms: Arm[] = [
      arm("learned (Jev features → logistic)", learned, yTest, fit.model.threshold, true),
      arm("gate-only (1 noul + profile)", gateO, yTest, 0.5, true),
      arm("gate inside profile battery", gateB, yTest, 0.5),
    ];
    const baselineNames = [...new Set(testRows.flatMap((r) => Object.keys(r.i.baselines)))];
    for (const b of baselineNames) {
      arms.push(arm(`existing: ${b}`, testRows.map((r) => r.i.baselines[b] ?? null), yTest, null));
    }

    if (t === "video" && titleRows.size) {
      const vec = (i: RelItem) => { const r = titleRows.get(titleOnlyKey(i.key)); return r ? vectorize(r, names) : null; };
      const tTrain = trainItems.map((i) => ({ i, x: vec(i) })).filter((r): r is { i: RelItem; x: number[] } => r.x !== null);
      const tFit = fitTypeModel(t, tTrain.map((r) => r.x), tTrain.map((r) => yOf(r.i)), { targetPrecision: opts.targetPrecision[t], seed: opts.seed });
      const tTest = testRows.map((r) => ({ y: yOf(r.i), x: vec(r.i), g: titleRows.get(titleOnlyKey(r.i.key))?.gateOnly ?? null }));
      arms.splice(3, 0,
        arm("title+channel only: learned", tTest.map((r) => (r.x ? predictType(tFit.model, r.x) : null)), tTest.map((r) => r.y), tFit.model.threshold),
        arm("title+channel only: gate-only", tTest.map((r) => r.g), tTest.map((r) => r.y), 0.5),
      );
    }

    const paired = testRows.map((r) => [gateSignal(r.row), r.row.gateOnly]).filter((p) => p[0] !== null && p[1] !== null) as number[][];
    const weights = fit.model.logistic
      ? names.map((f, j) => ({ feature: f, coef: fit.model.logistic!.weights[j] })).sort((a, b) => Math.abs(b.coef) - Math.abs(a.coef))
      : [];

    // Category: agreement with existing automatic category + relevant rate per Jev category.
    const withCat = testRows.filter((r) => r.row.category);
    const agreeRows = withCat.filter((r) => r.i.existingCategory);
    const agreement = agreeRows.length
      ? agreeRows.filter((r) => r.row.category!.pick === r.i.existingCategory).length / agreeRows.length
      : null;
    const catAgg = new Map<string, { n: number; pos: number }>();
    for (const r of [...trainRows.map((x) => ({ i: x.i, row: rows.get(x.i.key)! })), ...testRows]) {
      const c = r.row.category?.pick;
      if (!c) continue;
      const a = catAgg.get(c) ?? { n: 0, pos: 0 };
      a.n++;
      a.pos += yOf(r.i);
      catAgg.set(c, a);
    }

    const spot: Array<Record<string, unknown>> = [];
    if (t === "video") {
      const posScores = testRows.filter((r) => yOf(r.i) === 1).map((r) => predictType(fit.model, r.x));
      for (const r of testRows.filter((x) => x.i.labelKind === "explicit_neg" || x.i.labelKind === "explicit_pos")) {
        const p = predictType(fit.model, r.x);
        spot.push({
          kind: r.i.labelKind,
          title: r.i.title,
          reason: r.i.reason,
          pLearned: round(p),
          gateOnly: round(r.row.gateOnly),
          pctOfTestPositivesScoringHigher: round(posScores.filter((s) => s > p).length / Math.max(1, posScores.length)),
          jevCategory: r.row.category?.pick ?? null,
        });
      }
    }

    reports.push({
      type: t,
      labels: stats[t],
      evaluation: t === "video"
        ? "PU: chosen (sent manually / Watch Later / explicit interested) vs discovery-found with no feedback + explicit rejections. Unlabeled is not negative: precision is a lower bound."
        : "Human triage actions: research|watch = relevant vs archive|drop = not relevant.",
      split: {
        train: split[t].train.length,
        trainAfterExemplars: trainRows.length,
        test: testRows.length,
        testPos: yTest.filter((v) => v === 1).length,
        testNeg: yTest.filter((v) => v === 0).length,
      },
      model: fit.model,
      weights,
      arms,
      gateBatchingCorrelation: pearson(paired.map((p) => p[0]), paired.map((p) => p[1])),
      category: {
        agreementWithExisting: agreement,
        existingLabel: t === "video" ? "discover_item_groups (embedding clusters, automatic)" : "pending_items.value_type (LLM triage, automatic)",
        meanConfidence: withCat.length ? withCat.reduce((s, r) => s + (r.row.category!.confidence ?? 0), 0) / withCat.length : null,
        relevantRateByCategory: [...catAgg.entries()]
          .map(([category, a]) => ({ category, n: a.n, relevantRate: a.pos / a.n }))
          .sort((a, b) => b.n - a.n),
      },
      spotChecks: spot,
      failedItems: failed,
    });
  }

  if (opts.types.includes("entity")) {
    const items = split.entity.test;
    const labeled = items.filter((i) => i.label !== null);
    const y = labeled.map((i) => i.label as number);
    const gate = labeled.map((i) => gateSignal(rows.get(i.key)!));
    const route = (v: number | null) => (v === null ? "error" : v * 2 >= 1.5 ? "merge" : v * 2 >= 0.5 ? "queue" : "leave");
    const routing = (list: RelItem[]) => {
      const m: Record<string, number> = {};
      for (const i of list) {
        const r = route(gateSignal(rows.get(i.key)!));
        m[r] = (m[r] ?? 0) + 1;
      }
      return m;
    };
    const spot: Array<Record<string, unknown>> = [];
    for (const i of items.filter((x) => x.label === 0 || x.content.alias_is_separate_entity)) {
      const row = rows.get(i.key)!;
      spot.push({
        item: i.title,
        label: i.label === null ? "pending" : i.label ? "approved" : "rejected",
        linkState: round(row.features.link_state),
        route: route(gateSignal(row)),
        alias_names_other_thing: round(row.features.alias_names_other_thing),
      });
    }
    reports.push({
      type: "entity",
      labels: stats.entity,
      evaluation: `Alias-merge decisions (approved = merge). Only ${stats.entity.negatives} rejections survive de-duplication (${entityMeta.conflicts} proposals flip-flopped between approve and reject; ${entityMeta.duplicateRows} duplicate proposal rows) — too few to fit or honestly benchmark a learner; zero-shot Score routing shown.`,
      split: { train: 0, trainAfterExemplars: 0, test: labeled.length, testPos: y.filter((v) => v === 1).length, testNeg: y.filter((v) => v === 0).length },
      model: null,
      weights: [],
      arms: [
        arm("gate (3-level link_state Score, zero-shot)", gate, y, 0.75),
        arm("existing: heuristic_rule (plural/punct yes, tail-token no)", labeled.map((i) => i.baselines.heuristic_rule ?? null), y, 0.75),
      ],
      gateBatchingCorrelation: null,
      category: {
        agreementWithExisting: null,
        existingLabel: "n/a",
        meanConfidence: null,
        relevantRateByCategory: Object.entries({
          approved: routing(labeled.filter((i) => i.label === 1)),
          rejected: routing(labeled.filter((i) => i.label === 0)),
          pending: routing(items.filter((i) => i.label === null)),
        }).map(([category, r]) => ({ category: `${category} → ${JSON.stringify(r)}`, n: Object.values(r).reduce((s, v) => s + v, 0), relevantRate: NaN })),
      },
      spotChecks: spot.slice(0, 30),
      failedItems: items.filter((i) => rows.get(i.key)!.errors.length).length,
    });
  }

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  mkdirSync(opts.outDir, { recursive: true });
  const report = {
    generatedAt: new Date().toISOString(),
    options: opts,
    jev: {
      model: client.model,
      mode: client.mode,
      liveCalls: client.liveCalls,
      cacheHits: client.cacheHits,
      liveCostUsd: client.totalCost,
      inputTokens: client.inputTokens,
      featurizeSeconds,
      itemsInScope: scope.length,
      costPerItemUsd: scope.length ? client.totalCost / scope.length : null,
    },
    profile: { hash: profile.hash, chars: profile.text.length, exemplars: profile.exemplarKeys.length, basedOn: profile.basedOn, text: profile.text },
    types: reports,
  };
  const jsonPath = join(opts.outDir, `${ts}.json`);
  const mdPath = join(opts.outDir, `${ts}.md`);
  writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  writeFileSync(mdPath, renderMarkdown(report, reports));
  return { jsonPath, mdPath, report };
}

function round(v: number | null | undefined, d = 3): number | null {
  return v === null || v === undefined || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d;
}

function f(v: number | null | undefined, d = 3): string {
  const r = round(v, d);
  return r === null ? "—" : r.toFixed(d);
}

function renderMarkdown(report: Record<string, any>, types: TypeReport[]): string {
  const L: string[] = [];
  L.push(`# Jev relevance benchmark — ${report.generatedAt}`);
  L.push("");
  L.push(`Jev ${report.jev.model} (${report.jev.mode}): ${report.jev.liveCalls} live calls, ${report.jev.cacheHits} cached, live spend **$${report.jev.liveCostUsd.toFixed(4)}**, ${report.jev.itemsInScope} items.`);
  L.push(`Profile ${report.profile.hash}: ${report.profile.chars} chars, ${report.profile.exemplars} exemplars (excluded from training), built from the train split only.`);
  for (const t of types) {
    L.push("");
    L.push(`## ${t.type}`);
    L.push("");
    L.push(`Labels: ${t.labels.positives} positive / ${t.labels.negatives} negative / ${t.labels.unlabeled} unlabeled — ${JSON.stringify(t.labels.byKind)}`);
    L.push(`Evaluation: ${t.evaluation}`);
    L.push(`Split: train ${t.split.train} (${t.split.trainAfterExemplars} used after exemplar exclusion), test ${t.split.test} (${t.split.testPos} pos / ${t.split.testNeg} neg).`);
    if (t.model) L.push(`Model: ${t.model.note}; threshold ${f(t.model.threshold)} for target precision ${t.model.targetPrecision} (${t.model.thresholdReached ? "reached on OOF" : "NOT reachable on OOF — max-F1 threshold used"}).`);
    L.push("");
    L.push("| Arm | n | AUC | 95% CI | thr | precision | recall | accuracy | Brier |");
    L.push("|---|---|---|---|---|---|---|---|---|");
    for (const a of t.arms) {
      const m = a.atThreshold;
      L.push(`| ${a.name} | ${a.coverage} | ${f(a.auc)} | ${a.aucCI ? `${f(a.aucCI[0], 2)}–${f(a.aucCI[1], 2)}` : "—"} | ${m ? f(m.threshold, 2) : "—"} | ${m ? f(m.precision) : "—"} | ${m ? f(m.recall) : "—"} | ${m ? f(m.accuracy) : "—"} | ${a.brier !== undefined ? f(a.brier) : "—"} |`);
    }
    const cal = t.arms[0]?.calibration;
    if (cal) {
      L.push("");
      L.push(`Calibration (${t.arms[0].name}): ` + cal.map((b) => `[${b.lo.toFixed(1)}–${b.hi.toFixed(1)}) n=${b.n} pred=${f(b.meanPredicted, 2)} obs=${f(b.observedRate, 2)}`).join("; "));
    }
    if (t.gateBatchingCorrelation !== null) L.push(`Gate asked alone vs inside the battery: Pearson r = ${f(t.gateBatchingCorrelation)}.`);
    if (t.weights.length) {
      L.push("");
      L.push("Standardised coefficients: " + t.weights.map((w) => `${w.feature} ${w.coef >= 0 ? "+" : ""}${w.coef.toFixed(2)}`).join(", "));
    }
    if (t.category) {
      L.push("");
      if (t.category.agreementWithExisting !== null) L.push(`Category agreement with existing ${t.category.existingLabel}: ${f(t.category.agreementWithExisting)} (mean Jev confidence ${f(t.category.meanConfidence)}).`);
      L.push("");
      L.push("| Jev category | n | relevant rate |");
      L.push("|---|---|---|");
      for (const c of t.category.relevantRateByCategory.slice(0, 25)) L.push(`| ${c.category} | ${c.n} | ${Number.isFinite(c.relevantRate) ? f(c.relevantRate, 2) : "—"} |`);
    }
    if (t.spotChecks.length) {
      L.push("");
      L.push("Spot checks:");
      for (const s of t.spotChecks) L.push(`- ${JSON.stringify(s)}`);
    }
  }
  L.push("");
  L.push("## Profile used");
  L.push("");
  L.push("```");
  L.push(report.profile.text);
  L.push("```");
  return L.join("\n") + "\n";
}

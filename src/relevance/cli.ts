#!/usr/bin/env bun
/**
 * Relevance engine CLI.
 *
 *   bun src/relevance/cli.ts labels                  # label counts, no API calls
 *   bun src/relevance/cli.ts profile                 # print the current profile text
 *   bun src/relevance/cli.ts probe [--n 20]          # dry run: featurize a few items, show cost/item
 *   bun src/relevance/cli.ts bench [--limit N] ...   # benchmark → data/relevance-bench/<ts>.{json,md}
 *   bun src/relevance/cli.ts retrain                 # nightly self-learning step → data/relevance/model.json
 *   bun src/relevance/cli.ts score --type video [--n 10]   # score unlabeled items with the saved model
 *
 * Library taxonomy (docs/plans/2026-09-25-jev-taxonomy.md):
 *   bun src/relevance/cli.ts taxonomy                # tree with item counts
 *   bun src/relevance/cli.ts categorize --kind all|video|research|archive|article [--limit N] [--budget X]
 *                                        [--force] [--dry-run] [--sample N] [--threshold 0.5]
 *   bun src/relevance/cli.ts cat-sample [--n 40]     # random stored categories for hand-checking
 *   bun src/relevance/cli.ts search "<query>" [--limit 15] [--mode lean|full] [--keys-file <path>]
 *
 * Discover auto-triage (writes ONLY discover_jev_triage, never discover_feedback):
 *   bun src/relevance/cli.ts triage-discover [--dry-run] [--limit N] [--budget 1.00]
 *                                        [--hide-threshold 0.85] [--pick-threshold 0.80]
 *                                        [--hide-threshold-saved 0.95] [--guard 0.5] [--out file.jsonl]
 *                                        [--groups "Label A,Label B"] [--sources youtube_discovery,github]
 *                                        [--chosen-sample 40] [--pick-threshold-channel 0.8] [--pick-threshold-news 0.6]
 *                                        [--retriage-news | --retriage-channels <regex>]   # replace those rows
 *   bun src/relevance/cli.ts triage-discover --undo <run_id|all>
 *   bun src/relevance/cli.ts triage-discover --status
 *
 * Live calls need OPENROUTER_API_KEY, injected by vaultd:
 *   ~/Volaris/code/jev-2026-09-18/tools/with_key.sh bun src/relevance/cli.ts bench
 * Without it the CLI replays data/jev-cache/ only.
 *
 * Spend: every live run appends to data/relevance-bench/spend.jsonl; a run's
 * budget is min(--budget, --total-cap − ledger total).
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { JevClient } from "./jev.ts";
import {
  ITEM_TYPES,
  labelStats,
  loadArticles,
  loadEntities,
  loadTopicGroups,
  loadVideos,
  openReadonly,
  type ItemType,
  type RelItem,
} from "./labels.ts";
import { buildProfile } from "./profile.ts";
import { runBench } from "./bench.ts";
import { featurize, fitTypeModel, saveModel, loadModel, scoreItems, vectorize, type RelevanceModel } from "./engine.ts";
import { featureNames } from "./questions.ts";
import { mulberry32, shuffleInPlace } from "./learner.ts";
import { Database } from "bun:sqlite";
import { DEFAULT_STOP_THRESHOLD, leaves, loadTaxonomy } from "./taxonomy.ts";
import { LIB_KINDS, loadLibrary, tableExists, type LibKind } from "./library.ts";
import { categorize, categoryCounts, renderTree } from "./categorize.ts";
import { searchLibrary } from "./search.ts";
import { DEFAULT_THRESHOLDS, NEWS_CHANNEL_RE, triageCounts, triageDiscover, undoTriage } from "./discover-triage.ts";

const LEDGER = "data/relevance-bench/spend.jsonl";

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}

function ledgerTotal(): number {
  if (!existsSync(LEDGER)) return 0;
  return readFileSync(LEDGER, "utf-8")
    .split("\n")
    .filter(Boolean)
    .reduce((s, l) => s + (JSON.parse(l).costUsd ?? 0), 0);
}

function record(command: string, client: JevClient): void {
  if (client.liveCalls === 0) return;
  mkdirSync("data/relevance-bench", { recursive: true });
  appendFileSync(LEDGER, JSON.stringify({ ts: new Date().toISOString(), command, liveCalls: client.liveCalls, costUsd: client.totalCost }) + "\n");
}

function makeClient(): JevClient {
  const totalCap = Number(arg("total-cap", "10"));
  const spent = ledgerTotal();
  const budget = Math.max(0, Math.min(Number(arg("budget", "1")), totalCap - spent));
  const client = new JevClient({ budgetUsd: budget, concurrency: Number(arg("concurrency", "8")) });
  console.error(`jev: mode=${client.mode} model=${client.model} run budget=$${budget.toFixed(3)} (ledger so far $${spent.toFixed(4)} of $${totalCap})`);
  return client;
}

function loadAll(dbPath: string) {
  const db = openReadonly(dbPath);
  const out = {
    groups: loadTopicGroups(db),
    video: loadVideos(db),
    article: loadArticles(db),
    entity: loadEntities(db).items,
    articleUnlabeled: [] as RelItem[],
  };
  db.close();
  return out;
}

async function main() {
  const cmd = process.argv[2] ?? "help";
  const dbPath = arg("db", "data/app.db")!;

  if (cmd === "labels") {
    const a = loadAll(dbPath);
    for (const t of ITEM_TYPES) console.log(JSON.stringify(labelStats(t, a[t])));
    return;
  }

  if (cmd === "profile") {
    const a = loadAll(dbPath);
    const p = buildProfile([...a.video, ...a.article].filter((i) => i.label !== null), { groupLabels: a.groups });
    console.log(p.text);
    console.error(`\n(${p.text.length} chars, hash ${p.hash}, ${p.exemplarKeys.length} exemplars)`);
    return;
  }

  if (cmd === "probe") {
    const n = Number(arg("n", "20"));
    const a = loadAll(dbPath);
    const rng = mulberry32(1);
    const labeled = (xs: RelItem[]) => shuffleInPlace(xs.filter((i) => i.label !== null), rng);
    const per = Math.max(1, Math.floor(n / 3));
    const items = [...labeled(a.video).slice(0, per), ...labeled(a.article).slice(0, per), ...labeled(a.entity).slice(0, n - 2 * per)];
    const profile = buildProfile([...a.video, ...a.article].filter((i) => i.label !== null), { groupLabels: a.groups });
    const client = makeClient();
    const rows = await featurize(client, items, profile.text, a.groups, { gateOnlyKeys: new Set(items.map((i) => i.key)) });
    for (const it of items) {
      const r = rows.get(it.key)!;
      const feats = Object.entries(r.features).map(([k, v]) => `${k}=${v.toFixed(2)}`).join(" ");
      console.log(`[${it.type} label=${it.label}] ${it.title.slice(0, 70)}\n   gateOnly=${r.gateOnly?.toFixed(2) ?? "—"} cat=${r.category?.pick ?? "—"}(${r.category?.confidence?.toFixed(2) ?? "—"}) ${feats}${r.errors.length ? `\n   ERR ${r.errors.join(" | ")}` : ""}`);
    }
    console.log(`\n${client.meter()} — ${items.length} items, $${(client.totalCost / Math.max(1, items.length)).toFixed(6)}/item, ${Math.round(client.inputTokens / Math.max(1, client.liveCalls))} input tokens/call`);
    record("probe", client);
    return;
  }

  if (cmd === "bench") {
    const client = makeClient();
    const types = (arg("types", "video,article,entity")!.split(",") as ItemType[]).filter((t) => ITEM_TYPES.includes(t));
    const limit = arg("limit");
    const res = await runBench(client, {
      dbPath,
      seed: Number(arg("seed", "42")),
      testFrac: Number(arg("test-frac", "0.3")),
      targetPrecision: {
        video: Number(arg("target-precision-video", "0.9")),
        article: Number(arg("target-precision-article", "0.9")),
        entity: 0.95,
      },
      limitPerType: limit ? Number(limit) : null,
      types,
      outDir: "data/relevance-bench",
      titleOnlyArm: arg("title-only", "1") !== "0",
    });
    record("bench", client);
    console.log(`${client.meter()}\nwrote ${res.jsonPath}\nwrote ${res.mdPath}`);
    return;
  }

  if (cmd === "retrain") {
    // The self-learning step: rebuild the profile from ALL current labels,
    // featurize labeled items (content battery cached; profile battery
    // recomputed if the profile changed), refit per-type models, save.
    const a = loadAll(dbPath);
    const labeled = [...a.video, ...a.article].filter((i) => i.label !== null);
    const profile = buildProfile(labeled, { groupLabels: a.groups });
    const exemplars = new Set(profile.exemplarKeys);
    const client = makeClient();
    const model: RelevanceModel = {
      version: 1,
      trainedAt: new Date().toISOString(),
      jevModel: client.model,
      profile: { text: profile.text, hash: profile.hash },
      groups: a.groups,
      types: {},
    };
    for (const t of ["video", "article", "entity"] as const) {
      // Videos train PU-style: chosen (1) vs discovery-found unlabeled (0).
      const pool = a[t].filter((i) => !exemplars.has(i.key) && (t === "video" || i.label !== null));
      const rows = await featurize(client, pool, profile.text, a.groups);
      const names = featureNames(t);
      const data = pool
        .map((i) => ({ y: i.label === 1 ? 1 : 0, x: vectorize(rows.get(i.key)!, names) }))
        .filter((d): d is { y: number; x: number[] } => d.x !== null);
      const fit = fitTypeModel(t, data.map((d) => d.x), data.map((d) => d.y), {
        targetPrecision: t === "entity" ? 0.95 : 0.9,
      });
      model.types[t] = fit.model;
      console.error(`${t}: n=${data.length} ${fit.model.note} thr=${fit.model.threshold.toFixed(3)} ${client.meter()}`);
    }
    saveModel(model);
    record("retrain", client);
    console.log(`saved data/relevance/model.json (profile ${profile.hash})`);
    return;
  }

  if (cmd === "score") {
    const model = loadModel();
    if (!model) throw new Error("No data/relevance/model.json — run `retrain` first");
    const t = (arg("type", "video") as ItemType);
    const n = Number(arg("n", "10"));
    const a = loadAll(dbPath);
    const pool = t === "article"
      ? (() => { const db = openReadonly(dbPath); const x = loadArticles(db, true); db.close(); return x; })()
      : a[t];
    const items = pool.filter((i) => i.label === null).slice(-n);
    const client = makeClient();
    const scored = await scoreItems(client, model, items);
    for (const s of scored) console.log(`${s.decision.padEnd(12)} p=${s.pRelevant?.toFixed(3) ?? "—"} cat=${s.category?.pick ?? "—"}  ${s.title.slice(0, 90)}`);
    record("score", client);
    console.error(client.meter());
    return;
  }

  if (cmd === "categorize" || cmd === "taxonomy" || cmd === "search" || cmd === "cat-sample") {
    await taxonomyCommands(cmd, dbPath);
    return;
  }

  if (cmd === "triage-discover") {
    await triageDiscoverCommand(dbPath);
    return;
  }

  console.log(readFileSync(new URL(import.meta.url).pathname, "utf-8").split("*/")[0]);
}

// ─── Discover auto-triage (src/relevance/discover-triage.ts) ────────────────

async function triageDiscoverCommand(dbPath: string): Promise<void> {
  const undo = arg("undo");
  if (undo) {
    const db = new Database(dbPath);
    db.exec("PRAGMA busy_timeout = 5000");
    console.log(`removed ${undoTriage(db, undo)} triage row(s) for ${undo}`);
    db.close();
    return;
  }
  if (process.argv.includes("--status")) {
    const db = new Database(dbPath, { readonly: true });
    for (const r of triageCounts(db)) console.log(`${r.run_id}  ${r.decision.padEnd(7)} ${r.n}`);
    db.close();
    return;
  }
  const dryRun = process.argv.includes("--dry-run");
  const limit = arg("limit") ? Number(arg("limit")) : null;
  const thresholds = {
    hide: Number(arg("hide-threshold", String(DEFAULT_THRESHOLDS.hide))),
    pick: Number(arg("pick-threshold", String(DEFAULT_THRESHOLDS.pick))),
    guard: Number(arg("guard", String(DEFAULT_THRESHOLDS.guard))),
    hideSaved: Number(arg("hide-threshold-saved", String(DEFAULT_THRESHOLDS.hideSaved))),
    pickKnownChannel: Number(arg("pick-threshold-channel", String(DEFAULT_THRESHOLDS.pickKnownChannel))),
    pickNews: Number(arg("pick-threshold-news", String(DEFAULT_THRESHOLDS.pickNews))),
  };
  const db = dryRun ? new Database(dbPath, { readonly: true }) : new Database(dbPath);
  if (!dryRun) db.exec("PRAGMA busy_timeout = 5000");
  const client = makeClient();
  const res = await triageDiscover(db, client, {
    dryRun,
    limit,
    thresholds,
    groups: arg("groups")?.split(",").map((x) => x.trim()) ?? null,
    sources: arg("sources")?.split(",").map((x) => x.trim()) ?? null,
    chosenSample: Number(arg("chosen-sample", "40")),
    retriageChannels: process.argv.includes("--retriage-news") ? NEWS_CHANNEL_RE : arg("retriage-channels") ? new RegExp(arg("retriage-channels")!, "i") : null,
    onProgress: (d, t) => process.stderr.write(`\r  ${d}/${t} ${client.meter()}   `),
  });
  process.stderr.write("\n");
  const out = arg("out");
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, res.triaged.map((r) => JSON.stringify({
      id: r.item.atlasId, source: r.item.source, group: r.item.topicGroup, by: r.item.by, title: r.item.title, chosen_from_channel: r.item.chosenFromChannel ?? 0,
      was: res.previous.get(r.item.atlasId), decision: r.decision, p_not: r.probs.pNot, p_interest: r.probs.pInterest, p_protected: r.probs.pProtected, reason: r.reason,
    })).join("\n") + "\n");
  }
  if (dryRun || (limit !== null && limit <= 100)) {
    for (const r of res.triaged) {
      const p = r.probs;
      console.log(`${r.decision.padEnd(6)} not=${p.pNot.toFixed(2)} int=${p.pInterest.toFixed(2)} prot=${p.pProtected.toFixed(2)} [${r.item.source}] ${r.item.title.slice(0, 80)}\n       ${r.reason}`);
    }
  }
  const n = (d: string) => res.triaged.filter((r) => r.decision === d).length;
  console.log(
    `\nrun ${res.runId}${dryRun ? " (dry run, nothing written)" : ""}: rubric ${res.rubric.interested} interested / ${res.rubric.notInterested} not + ${res.rubric.chosenSample} of ${res.rubric.chosenTotal} chosen videos; ` +
      `channel prior ${res.rubric.knownChannels} channels (${res.rubric.newsChannelsExcluded} mainstream news channels excluded)\n` +
      `todo ${res.considered}, triaged ${res.triaged.length} → hide ${n("hide")}, pick ${n("pick")}, unsure ${n("unsure")}; ` +
      `written ${res.written}, errors ${res.errors.length}${res.budgetHit ? ", BUDGET HIT" : ""}\n` +
      `thresholds ${JSON.stringify(thresholds)}\n${client.meter()}`,
  );
  if (res.previous.size) {
    const flips: Record<string, number> = {};
    for (const r of res.triaged) {
      const was = res.previous.get(r.item.atlasId);
      if (was !== undefined) flips[`${was}→${r.decision}`] = (flips[`${was}→${r.decision}`] ?? 0) + 1;
    }
    console.log(`re-triaged ${res.previous.size}: ${JSON.stringify(flips)}`);
  }
  for (const e of res.errors.slice(0, 5)) console.error(`  ERR ${e.atlasId}: ${e.error}`);
  record(dryRun ? "triage-discover-dry" : "triage-discover", client);
  db.close();
}

// ─── library taxonomy (docs/plans/2026-09-25-jev-taxonomy.md) ───────────────

async function taxonomyCommands(cmd: string, dbPath: string): Promise<void> {
  const tax = loadTaxonomy(arg("taxonomy", "data/relevance/taxonomy.json")!);

  if (cmd === "taxonomy") {
    const db = new Database(dbPath, { readonly: true });
    const counts = tableExists(db, "item_categories") ? categoryCounts(db) : [];
    db.close();
    console.log(`taxonomy ${tax.version}: ${tax.roots.length} top-level, ${tax.byId.size} nodes, ${leaves(tax).length} leaves\n`);
    console.log(renderTree(tax, counts));
    return;
  }

  if (cmd === "categorize") {
    const kindArg = arg("kind", "all")!;
    const kinds = kindArg === "all" ? LIB_KINDS : (kindArg.split(",") as LibKind[]).filter((k) => LIB_KINDS.includes(k));
    const dryRun = process.argv.includes("--dry-run");
    const force = process.argv.includes("--force");
    const limit = arg("limit") ? Number(arg("limit")) : null;
    const threshold = Number(arg("threshold", String(DEFAULT_STOP_THRESHOLD)));
    const db = dryRun ? new Database(dbPath, { readonly: true }) : new Database(dbPath);
    if (!dryRun) db.exec("PRAGMA busy_timeout = 5000");
    let items = loadLibrary(db, kinds);
    if (arg("sample")) items = shuffleInPlace(items, mulberry32(Number(arg("seed", "7")))).slice(0, Number(arg("sample")));
    const client = makeClient();
    const res = await categorize(db, client, tax, items, {
      force,
      limit,
      dryRun,
      threshold,
      onProgress: (d, t) => process.stderr.write(`\r  ${d}/${t} ${client.meter()}   `),
    });
    process.stderr.write("\n");
    if (dryRun || (limit !== null && limit <= 50)) {
      for (const { item, cls } of res.classified) {
        const lv = cls.levels.map((l) => l.p.toFixed(2)).join("›");
        const alt = cls.beam.slice(1).map((b) => `${b.leaf}(${b.score.toFixed(2)})`).join(", ");
        console.log(`[${item.kind}] ${item.title.slice(0, 90)}\n   → ${cls.path}  conf=${cls.confidence.toFixed(2)} levels=${lv}${cls.stoppedEarly ? ` (stopped; best leaf ${cls.leaf})` : ""}${cls.greedyLeaf !== cls.leaf ? `  GREEDY=${cls.greedyLeaf}` : ""}\n     alt: ${alt}`);
      }
    }
    const byKind: Record<string, number> = {};
    for (const c of res.classified) byKind[c.item.kind] = (byKind[c.item.kind] ?? 0) + 1;
    const disagree = res.classified.filter((c) => c.cls.greedyLeaf !== c.cls.leaf).length;
    const stopped = res.classified.filter((c) => c.cls.stoppedEarly).length;
    console.log(
      `\ntaxonomy ${tax.version}: considered ${res.considered}, skipped (current) ${res.skippedCurrent}, classified ${res.classified.length} ${JSON.stringify(byKind)}, ` +
        `written ${res.written}${dryRun ? " (dry run)" : ""}, overrides kept ${res.overridden}, errors ${res.errors.length}${res.budgetHit ? ", BUDGET HIT" : ""}\n` +
        `greedy≠beam leaf: ${disagree}/${res.classified.length}; stopped at a parent: ${stopped}/${res.classified.length}\n` +
        `${client.meter()} — $${(client.totalCost / Math.max(1, client.liveCalls)).toFixed(6)}/live call, ${Math.round(client.inputTokens / Math.max(1, client.liveCalls))} input tokens/call`,
    );
    for (const e of res.errors.slice(0, 5)) console.error(`  ERR ${e.key}: ${e.error}`);
    record(dryRun ? "categorize-dry" : "categorize", client);
    db.close();
    return;
  }

  if (cmd === "cat-sample") {
    // Hand-check helper: random stored categories, stratified by kind.
    const n = Number(arg("n", "40"));
    const db = new Database(dbPath, { readonly: true });
    const titles = new Map(loadLibrary(db).map((i) => [i.key, i.title]));
    const rows = db
      .query<{ item_key: string; kind: string; path: string; leaf: string; confidence: number; alt_json: string }, []>(
        `SELECT item_key, kind, path, leaf, confidence, alt_json FROM item_categories`,
      )
      .all();
    const rng = mulberry32(Number(arg("seed", "11")));
    const kinds = [...new Set(rows.map((r) => r.kind))];
    const per = Math.ceil(n / Math.max(1, kinds.length));
    const pick = kinds.flatMap((k) => shuffleInPlace(rows.filter((r) => r.kind === k), rng).slice(0, per)).slice(0, n);
    pick.forEach((r, i) => {
      const alt = JSON.parse(r.alt_json ?? "{}");
      console.log(`${String(i + 1).padStart(2)}. [${r.kind}] ${(titles.get(r.item_key) ?? r.item_key).slice(0, 100)}\n    → ${r.path} (${r.confidence.toFixed(2)})${r.leaf !== r.path ? ` best leaf ${r.leaf}` : ""}  alt: ${(alt.alternatives ?? []).map((a: { leaf: string }) => a.leaf).join(", ")}`);
    });
    const dis = rows.filter((r) => {
      const a = JSON.parse(r.alt_json ?? "{}");
      return a.greedy_leaf && a.best_leaf && a.greedy_leaf !== a.best_leaf;
    }).length;
    const stopped = rows.filter((r) => JSON.parse(r.alt_json ?? "{}").stopped_early).length;
    console.log(`\n${rows.length} stored; greedy≠beam leaf ${dis} (${((100 * dis) / Math.max(1, rows.length)).toFixed(1)}%); stopped at parent ${stopped} (${((100 * stopped) / Math.max(1, rows.length)).toFixed(1)}%)`);
    db.close();
    return;
  }

  if (cmd === "search") {
    const query = process.argv.slice(3).find((a, i, all) => !a.startsWith("--") && !(i > 0 && all[i - 1].startsWith("--")));
    if (!query) throw new Error('usage: search "<query>" [--limit 20]');
    const db = new Database(dbPath, { readonly: true });
    const client = makeClient();
    // --keys-file: newline-separated item keys that pass the caller's filters (vivaldi-home /library date, site, topic…).
    const keysFile = arg("keys-file");
    const onlyKeys = keysFile ? new Set(readFileSync(keysFile, "utf8").split("\n").filter(Boolean)) : undefined;
    const res = await searchLibrary(db, query, { client, taxonomy: tax, limit: Number(arg("limit", "15")), mode: arg("mode") === "full" ? "full" : "lean", onlyKeys });
    if (process.argv.includes("--json")) {
      // Machine output for vivaldi-home's /library smart search.
      console.log(JSON.stringify(res));
      record("search", client);
      db.close();
      return;
    }
    console.log(`query: ${res.query}\nsubtrees: ${res.subtrees.map((s) => `${s.path} (${s.score})`).join(", ") || "—"}\n`);
    for (const h of res.hits) {
      console.log(`${h.relevance.toFixed(2)}  bm25=${h.bm25.toFixed(1).padStart(5)} ${h.in_subtree ? "  " : "* "}[${h.kind}] ${h.title.slice(0, 90)}  — ${h.path ?? "uncategorised"}`);
    }
    console.log(`\n${res.jevCalls} Jev calls, $${res.costUsd.toFixed(6)} (${client.meter()}); * = outside the routed subtrees`);
    record("search", client);
    db.close();
    return;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : String(err));
  process.exit(1);
});

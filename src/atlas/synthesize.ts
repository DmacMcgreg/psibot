import { query, createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import Database from "bun:sqlite";
import { getDb } from "../db/index.ts";
import { createLogger } from "../shared/logger.ts";
import { MemorySystem } from "../memory/index.ts";

const log = createLogger("atlas:synth");

import { getConfig, getBackendEnv } from "../config.ts";

const SONNET = () => {
  const cfg = getConfig();
  return cfg.DEFAULT_BACKEND === "glm" ? cfg.GLM_SONNET_MODEL : "claude-sonnet-4-5-20250929";
};
const OPUS = () => {
  const cfg = getConfig();
  return cfg.DEFAULT_BACKEND === "glm" ? cfg.GLM_OPUS_MODEL : "claude-opus-4-7";
};
const HAIKU = () => {
  const cfg = getConfig();
  return cfg.DEFAULT_BACKEND === "glm" ? cfg.GLM_HAIKU_MODEL : "claude-haiku-4-5-20251001";
};

const KNOWLEDGE_DIR = resolve(process.cwd(), "knowledge");
const WEEKLY_DIR = join(KNOWLEDGE_DIR, "weekly");
const MEMORY_DIR = join(KNOWLEDGE_DIR, "memory");
const TRADING_DIR = join(KNOWLEDGE_DIR, "trading");
const SCAN_DIR = join(TRADING_DIR, "scans");

interface DailyBucket {
  kind: string;
  items: Array<{ id: number; title: string; snippet: string; url: string | null }>;
}

interface ClaudeMemSession {
  project: string;
  request: string;
  learned: string;
  completed: string;
  created_at: string;
}

interface ClaudeMemObservation {
  project: string;
  type: string;
  title: string;
  narrative: string;
}

interface DailyContext {
  date: string;
  buckets: DailyBucket[];
  autonomyChanges: Array<{ rule: string; direction: string; at: string }>;
  researchDone: Array<{ title: string; summary: string; url: string | null; at: string }>;
  signalCount: number;
  claudeMemSessions: ClaudeMemSession[];
  claudeMemObservations: ClaudeMemObservation[];
}

function isoDateOnly(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

function hhmm(d = new Date()): string {
  return d.toISOString().slice(11, 16);
}

const CLAUDE_MEM_DB_PATH = join(homedir(), ".claude-mem", "claude-mem.db");

/** Pull session summaries and observations from the claude-mem plugin DB.
 *  @param sinceEpochMs — millisecond epoch (claude-mem uses ms epochs). */
function gatherClaudeMemContext(sinceEpochMs: number): {
  sessions: ClaudeMemSession[];
  observations: ClaudeMemObservation[];
} {
  const empty = { sessions: [] as ClaudeMemSession[], observations: [] as ClaudeMemObservation[] };
  if (!existsSync(CLAUDE_MEM_DB_PATH)) {
    log.debug("claude-mem DB not found, skipping", { path: CLAUDE_MEM_DB_PATH });
    return empty;
  }

  try {
    const cmDb = new Database(CLAUDE_MEM_DB_PATH, { readonly: true });

    const sessions = cmDb
      .prepare<
        { project: string; request: string | null; learned: string | null; completed: string | null; created_at: string },
        [number]
      >(
        `SELECT project, request, learned, completed, created_at
         FROM session_summaries
         WHERE created_at_epoch >= ?
         ORDER BY created_at_epoch DESC
         LIMIT 20`,
      )
      .all(sinceEpochMs)
      .map((r) => ({
        project: r.project,
        request: (r.request ?? "").slice(0, 300),
        learned: (r.learned ?? "").slice(0, 300),
        completed: (r.completed ?? "").slice(0, 300),
        created_at: r.created_at,
      }));

    const observations = cmDb
      .prepare<
        { project: string; type: string; title: string | null; narrative: string | null },
        [number]
      >(
        `SELECT project, type, title, narrative
         FROM observations
         WHERE created_at_epoch >= ?
           AND type IN ('decision', 'discovery', 'bugfix')
         ORDER BY created_at_epoch DESC
         LIMIT 15`,
      )
      .all(sinceEpochMs)
      .map((r) => ({
        project: r.project,
        type: r.type,
        title: (r.title ?? "").slice(0, 120),
        narrative: (r.narrative ?? "").slice(0, 200),
      }));

    cmDb.close();
    return { sessions, observations };
  } catch (err) {
    log.warn("Failed to read claude-mem DB", { error: String(err) });
    return empty;
  }
}

/** Pull a 24h slice of atlas items grouped by kind, with light snippets. */
export function gatherDailyContext(windowHours = 24): DailyContext {
  const db = getDb();
  const since = new Date(Date.now() - windowHours * 3600_000).toISOString();

  const rows = db
    .prepare<
      {
        id: number;
        kind: string;
        title: string;
        body: string;
        url: string | null;
      },
      [string]
    >(
      `SELECT id, kind, title, body, url
       FROM atlas_items
       WHERE captured_at >= ?
       ORDER BY captured_at DESC`,
    )
    .all(since);

  const byKind = new Map<string, DailyBucket>();
  for (const row of rows) {
    if (!byKind.has(row.kind)) byKind.set(row.kind, { kind: row.kind, items: [] });
    const bucket = byKind.get(row.kind)!;
    if (bucket.items.length >= 15) continue;
    bucket.items.push({
      id: row.id,
      title: row.title,
      snippet: (row.body ?? "").replace(/\s+/g, " ").trim().slice(0, 220),
      url: row.url,
    });
  }

  const autonomy = db
    .prepare<
      { rule_key: string; level: string; updated_at: string },
      [string]
    >(
      `SELECT rule_key, level, updated_at FROM autonomy_rules
       WHERE updated_at >= ? ORDER BY updated_at DESC LIMIT 20`,
    )
    .all(since)
    .map((r) => ({ rule: r.rule_key, direction: r.level, at: r.updated_at }));

  const research = db
    .prepare<
      { title: string | null; summary: string | null; url: string | null; at: string },
      [string]
    >(
      `SELECT title, quick_scan_summary AS summary, url, updated_at AS at
       FROM pending_items
       WHERE auto_decision IN ('deep_research_done','quick_research_done')
         AND updated_at >= ?
       ORDER BY updated_at DESC LIMIT 20`,
    )
    .all(since)
    .map((r) => ({
      title: r.title ?? "(untitled)",
      summary: (r.summary ?? "").slice(0, 400),
      url: r.url,
      at: r.at,
    }));

  const signalCount = (db
    .prepare<{ n: number }, [string]>(
      `SELECT COUNT(*) AS n FROM atlas_items WHERE kind = 'signal' AND captured_at >= ?`,
    )
    .get(since) ?? { n: 0 }).n;

  // Pull from claude-mem plugin (sessions + observations from all projects)
  // claude-mem uses millisecond epochs
  const sinceEpochMs = Date.now() - windowHours * 3600_000;
  const claudeMem = gatherClaudeMemContext(sinceEpochMs);

  return {
    date: isoDateOnly(),
    buckets: Array.from(byKind.values()),
    autonomyChanges: autonomy,
    researchDone: research,
    signalCount,
    claudeMemSessions: claudeMem.sessions,
    claudeMemObservations: claudeMem.observations,
  };
}

function buildDailyPrompt(ctx: DailyContext): string {
  const lines: string[] = [];
  lines.push(`You are a narrative synthesizer. Write a 200-400 word daily narrative for ${ctx.date}.`);
  lines.push("");
  lines.push("Rules:");
  lines.push("- Name specific tickers, people, technologies, frameworks. No vague summaries.");
  lines.push("- Cross-source observations are the lede. If the same entity shows up in multiple kinds, lead with that.");
  lines.push("- Plain prose. No bullet dumps. No markdown headings beyond the date line.");
  lines.push("- End with a single line: `Open thread: <the most important unfinished question raised today>`.");
  lines.push("- If the day is thin, be honest. Do not pad.");
  lines.push("");
  lines.push("## Source material");
  lines.push("");

  for (const bucket of ctx.buckets) {
    lines.push(`### ${bucket.kind} (${bucket.items.length})`);
    for (const item of bucket.items) {
      lines.push(`- [${item.id}] ${item.title}`);
      if (item.snippet) lines.push(`    ${item.snippet}`);
    }
    lines.push("");
  }

  if (ctx.researchDone.length > 0) {
    lines.push(`### research completed (${ctx.researchDone.length})`);
    for (const r of ctx.researchDone) {
      lines.push(`- ${r.title}`);
      if (r.summary) lines.push(`    ${r.summary}`);
    }
    lines.push("");
  }

  if (ctx.autonomyChanges.length > 0) {
    lines.push("### autonomy rule changes");
    for (const a of ctx.autonomyChanges) {
      lines.push(`- ${a.rule} — ${a.direction} at ${a.at}`);
    }
    lines.push("");
  }

  if (ctx.claudeMemSessions.length > 0) {
    lines.push(`### claude-mem sessions (${ctx.claudeMemSessions.length})`);
    for (const s of ctx.claudeMemSessions) {
      lines.push(`- [${s.project}] ${s.request}`);
      if (s.learned) lines.push(`    Learned: ${s.learned}`);
      if (s.completed) lines.push(`    Completed: ${s.completed}`);
    }
    lines.push("");
  }

  if (ctx.claudeMemObservations.length > 0) {
    lines.push(`### claude-mem observations (${ctx.claudeMemObservations.length})`);
    for (const o of ctx.claudeMemObservations) {
      lines.push(`- [${o.project}/${o.type}] ${o.title}`);
      if (o.narrative) lines.push(`    ${o.narrative}`);
    }
    lines.push("");
  }

  lines.push(`Signal volume today: ${ctx.signalCount} trading signals captured.`);
  lines.push("");
  lines.push("Now write the narrative.");
  return lines.join("\n");
}

/** Call Sonnet to render the narrative. Returns empty string if generation fails. */
async function generateText(prompt: string, model: string): Promise<string> {
  let response = "";
  try {
    for await (const msg of query({
      prompt,
      options: {
        model,
        maxTurns: 1,
        permissionMode: "bypassPermissions",
        ...(getBackendEnv() ? { env: getBackendEnv() } : {}),
      },
    })) {
      if (msg.type === "assistant" && msg.message) {
        response += msg.message.content
          .map((block: { type: string; text?: string }) =>
            block.type === "text" ? (block.text ?? "") : "",
          )
          .join("");
      } else if (msg.type === "result") {
        log.info("Synthesis complete", {
          model,
          turns: msg.num_turns,
          durationMs: msg.duration_ms,
          cost: msg.total_cost_usd?.toFixed(6),
        });
      }
    }
  } catch (err) {
    log.error("Synthesis generation failed", { model, error: String(err) });
    return "";
  }
  return response.trim();
}

export interface DailyNarrativeResult {
  date: string;
  text: string;
  written: boolean;
  itemCount: number;
}

export async function synthesizeDailyNarrative(memory: MemorySystem): Promise<DailyNarrativeResult> {
  const ctx = gatherDailyContext(24);
  const itemCount = ctx.buckets.reduce((n, b) => n + b.items.length, 0);
  const totalSources = itemCount + ctx.researchDone.length + ctx.autonomyChanges.length
    + ctx.claudeMemSessions.length + ctx.claudeMemObservations.length;
  if (totalSources === 0) {
    return { date: ctx.date, text: "", written: false, itemCount: 0 };
  }

  const prompt = buildDailyPrompt(ctx);
  const text = await generateText(prompt, SONNET());
  if (!text) return { date: ctx.date, text: "", written: false, itemCount };

  const header = `## ${hhmm()} — Daily narrative`;
  memory.appendDailyLog(`${header}\n\n${text}`);

  return { date: ctx.date, text, written: true, itemCount };
}

// ----------------------------- WEEKLY -----------------------------

function isoWeek(d = new Date()): string {
  const dt = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = dt.getUTCDay() || 7;
  dt.setUTCDate(dt.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(dt.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil((((dt.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return `${dt.getUTCFullYear()}-W${String(weekNum).padStart(2, "0")}`;
}

function readDailyLogsForWindow(days: number): { date: string; content: string }[] {
  const out: { date: string; content: string }[] = [];
  if (!existsSync(MEMORY_DIR)) return out;
  const now = Date.now();
  const cutoff = now - days * 86400_000;
  for (const entry of readdirSync(MEMORY_DIR)) {
    if (!entry.endsWith(".md")) continue;
    const date = entry.replace(/\.md$/, "");
    const full = join(MEMORY_DIR, entry);
    const st = statSync(full);
    if (st.mtimeMs < cutoff) continue;
    out.push({ date, content: readFileSync(full, "utf-8") });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

interface WeeklyContext {
  week: string;
  dailyLogs: { date: string; content: string }[];
  topEdges: Array<{ a: string; b: string; weight: number }>;
  topMentions: Array<{ entity: string; kind: string; count: number }>;
}

export function gatherWeeklyContext(): WeeklyContext {
  const db = getDb();
  const since = new Date(Date.now() - 7 * 86400_000).toISOString();

  const hasEntities = (db
    .prepare<{ n: number }, [string]>(
      "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name = ?",
    )
    .get("atlas_entity_cooccur") ?? { n: 0 }).n > 0;

  const topEdges = hasEntities
    ? db
        .prepare<
          { a: string; b: string; weight: number },
          [string]
        >(
          `SELECT ea.display_name AS a, eb.display_name AS b, c.weight
           FROM atlas_entity_cooccur c
           JOIN atlas_entities ea ON ea.id = c.entity_a
           JOIN atlas_entities eb ON eb.id = c.entity_b
           WHERE c.last_seen >= ?
           ORDER BY c.weight DESC
           LIMIT 15`,
        )
        .all(since)
    : [];

  const topMentions = hasEntities
    ? db
        .prepare<
          { entity: string; kind: string; count: number },
          [string]
        >(
          `SELECT e.display_name AS entity, e.kind, COUNT(*) AS count
           FROM atlas_entity_mentions m
           JOIN atlas_entities e ON e.id = m.entity_id
           WHERE m.created_at >= ?
           GROUP BY e.id
           ORDER BY count DESC
           LIMIT 20`,
        )
        .all(since)
    : [];

  return {
    week: isoWeek(),
    dailyLogs: readDailyLogsForWindow(7),
    topEdges,
    topMentions,
  };
}

function buildWeeklyPrompt(ctx: WeeklyContext): string {
  const lines: string[] = [];
  lines.push(`You are a weekly synthesizer. Write a weekly themes report for ${ctx.week}.`);
  lines.push("");
  lines.push("Rules:");
  lines.push("- Lead with entities that show up across multiple sources. That is the story.");
  lines.push("- 3-6 named themes. Each theme: a short heading, 2-4 sentences citing specific items/dates.");
  lines.push("- End with 'Open threads' section listing 2-4 concrete unresolved questions from the week.");
  lines.push("- Markdown. Use ## for theme headings and ## Open threads for the tail.");
  lines.push("");
  lines.push(`## Daily logs (${ctx.dailyLogs.length})`);
  for (const d of ctx.dailyLogs) {
    lines.push(`### ${d.date}`);
    lines.push(d.content.slice(0, 1800));
    lines.push("");
  }
  if (ctx.topMentions.length > 0) {
    lines.push(`## Top entity mentions this week`);
    for (const m of ctx.topMentions) {
      lines.push(`- ${m.kind}: ${m.entity} (${m.count})`);
    }
    lines.push("");
  }
  if (ctx.topEdges.length > 0) {
    lines.push(`## Strongest co-occurrences`);
    for (const e of ctx.topEdges) {
      lines.push(`- ${e.a} \u2194 ${e.b} (w=${e.weight})`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

export interface WeeklyThemesResult {
  week: string;
  text: string;
  path: string | null;
  written: boolean;
}

export async function synthesizeWeeklyThemes(): Promise<WeeklyThemesResult> {
  const ctx = gatherWeeklyContext();
  if (ctx.dailyLogs.length === 0 && ctx.topMentions.length === 0) {
    return { week: ctx.week, text: "", path: null, written: false };
  }

  const prompt = buildWeeklyPrompt(ctx);
  const text = await generateText(prompt, SONNET());
  if (!text) return { week: ctx.week, text: "", path: null, written: false };

  if (!existsSync(WEEKLY_DIR)) mkdirSync(WEEKLY_DIR, { recursive: true });
  const filePath = join(WEEKLY_DIR, `${ctx.week}.md`);
  const header = `# Weekly themes — ${ctx.week}\n\n_generated ${new Date().toISOString()}_\n\n`;
  writeFileSync(filePath, header + text + "\n");
  return { week: ctx.week, text, path: filePath, written: true };
}

// --------------------------- MONTHLY SCAN MAP-REDUCE ---------------------------

interface ScanExtraction {
  scan_path: string;
  setups: string[];
  indicators: string[];
  regime: string | null;
  hypotheses: string[];
}

async function extractOneScan(filePath: string, content: string): Promise<ScanExtraction | null> {
  const capture: { data: ScanExtraction | null } = { data: null };
  const scanServer = createSdkMcpServer({
    name: "scan-extraction",
    version: "1.0.0",
    tools: [
      tool(
        "record_scan_extraction",
        "Record structured extraction from one market scan file. Call exactly once.",
        {
          setups_found: z.array(z.string()).max(10).describe("Specific trade setups described (e.g. 'bull-flag breakout on GDX')."),
          indicators_used: z.array(z.string()).max(15).describe("Technical indicators/factors cited (e.g. 'MTF score', 'VWAP', 'RSI divergence')."),
          regime_observed: z.string().describe("One short phrase describing the regime the scan identified (e.g. 'risk-off escalation', 'stagflation core', 'bullish momentum')."),
          hypotheses_raised: z.array(z.string()).max(8).describe("Specific testable hypotheses the scan raised."),
        },
        async (args) => {
          capture.data = {
            scan_path: filePath,
            setups: args.setups_found,
            indicators: args.indicators_used,
            regime: args.regime_observed || null,
            hypotheses: args.hypotheses_raised,
          };
          return {
            content: [{ type: "text" as const, text: "recorded" }],
          };
        },
      ),
    ],
  });

  const snippet = content.slice(0, 6000);
  const prompt = `Extract structured trading metadata from this market scan.
Call record_scan_extraction exactly once.

Scan file: ${filePath}

<scan>
${snippet}
</scan>

Call record_scan_extraction now.`;

  try {
    for await (const msg of query({
      prompt,
      options: {
        model: SONNET(),
        maxTurns: 3,
        permissionMode: "bypassPermissions",
        ...(getBackendEnv() ? { env: getBackendEnv() } : {}),
        mcpServers: { scan: scanServer },
        allowedTools: ["mcp__scan__record_scan_extraction"],
      },
    })) {
      if (msg.type === "result") {
        log.info("Scan extraction", {
          filePath,
          turns: msg.num_turns,
          cost: msg.total_cost_usd?.toFixed(6),
        });
      }
    }
  } catch (err) {
    log.error("Scan extraction failed", { filePath, error: String(err) });
    return null;
  }
  return capture.data;
}

/** Map phase: process any scan files not yet in atlas_scan_extractions. */
export async function mapScanExtractions(limit = 10): Promise<number> {
  if (!existsSync(SCAN_DIR)) return 0;
  const db = getDb();
  const existing = new Set(
    db
      .prepare<{ scan_path: string }, []>("SELECT scan_path FROM atlas_scan_extractions")
      .all()
      .map((r) => r.scan_path),
  );

  const entries = readdirSync(SCAN_DIR).filter((e) => e.endsWith(".md"));
  const toDo: string[] = [];
  for (const e of entries) {
    const rel = `knowledge/trading/scans/${e}`;
    if (!existing.has(rel)) toDo.push(rel);
    if (toDo.length >= limit) break;
  }

  const insert = db.prepare(
    `INSERT OR REPLACE INTO atlas_scan_extractions
     (scan_path, setups_json, indicators_json, regime, hypotheses_json, extracted_at)
     VALUES (?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))`,
  );

  let count = 0;
  for (const rel of toDo) {
    const abs = join(process.cwd(), rel);
    if (!existsSync(abs)) continue;
    const content = readFileSync(abs, "utf-8");
    const ext = await extractOneScan(rel, content);
    if (!ext) continue;
    insert.run(
      rel,
      JSON.stringify(ext.setups),
      JSON.stringify(ext.indicators),
      ext.regime,
      JSON.stringify(ext.hypotheses),
    );
    count++;
  }
  return count;
}

interface ReduceBundle {
  extractions: Array<ScanExtraction & { extracted_at: string }>;
}

function gatherReduceBundle(sinceIso: string): ReduceBundle {
  const db = getDb();
  const rows = db
    .prepare<
      {
        scan_path: string;
        setups_json: string;
        indicators_json: string;
        regime: string | null;
        hypotheses_json: string;
        extracted_at: string;
      },
      [string]
    >(
      `SELECT scan_path, setups_json, indicators_json, regime, hypotheses_json, extracted_at
       FROM atlas_scan_extractions
       WHERE extracted_at >= ?
       ORDER BY extracted_at DESC`,
    )
    .all(sinceIso);

  const extractions = rows.map((r) => ({
    scan_path: r.scan_path,
    setups: safeParseArray(r.setups_json),
    indicators: safeParseArray(r.indicators_json),
    regime: r.regime,
    hypotheses: safeParseArray(r.hypotheses_json),
    extracted_at: r.extracted_at,
  }));
  return { extractions };
}

function safeParseArray(raw: string): string[] {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

interface ReduceOutput {
  playbook_appends: string[];
  lessons_appends: string[];
  models_appends: string[];
  research_appends: string[];
}

async function runReduce(bundle: ReduceBundle): Promise<ReduceOutput | null> {
  if (bundle.extractions.length === 0) return null;

  const capture: { data: ReduceOutput | null } = { data: null };
  const reduceServer = createSdkMcpServer({
    name: "reduce-scan",
    version: "1.0.0",
    tools: [
      tool(
        "record_monthly_synthesis",
        "Emit appended lines for the trading knowledge files. Call exactly once.",
        {
          playbook_appends: z.array(z.string()).max(10).describe("New setups to append to PLAYBOOK.md — each a single-line markdown bullet."),
          lessons_appends: z.array(z.string()).max(10).describe("Failed setups / lessons for LESSONS.md — single-line bullets."),
          models_appends: z.array(z.string()).max(10).describe("Consistent indicator combinations for MODELS.md — single-line bullets."),
          research_appends: z.array(z.string()).max(10).describe("Open hypotheses worth testing for RESEARCH.md — single-line bullets."),
        },
        async (args) => {
          capture.data = {
            playbook_appends: args.playbook_appends,
            lessons_appends: args.lessons_appends,
            models_appends: args.models_appends,
            research_appends: args.research_appends,
          };
          return { content: [{ type: "text" as const, text: "recorded" }] };
        },
      ),
    ],
  });

  const summary = bundle.extractions
    .map(
      (e) =>
        `- ${e.scan_path} [regime: ${e.regime ?? "-"}]\n  setups: ${e.setups.join(", ")}\n  indicators: ${e.indicators.join(", ")}\n  hypotheses: ${e.hypotheses.join(" | ")}`,
    )
    .join("\n");

  const prompt = `You are reducing ${bundle.extractions.length} monthly scan extractions into append-only knowledge updates.

Rules:
- playbook_appends: setups that recurred across >=3 scans. Each line names the setup + at least one example scan date.
- lessons_appends: setups that failed or didn't resolve as expected in >=2 scans. Each line names the pattern + the failure mode.
- models_appends: indicator combinations the scans used consistently (e.g. "MTF + VWAP + sentiment score"). Only truly new patterns.
- research_appends: hypotheses raised in the scans that haven't been resolved — each phrased as a testable claim.
- Every appended line is a single-line markdown bullet starting with "- ".
- If a category is empty, return [].
- Dates are April 2026. Cite specific scan files when possible.

## Extractions
${summary}

Call record_monthly_synthesis now.`;

  try {
    for await (const msg of query({
      prompt,
      options: {
        model: OPUS(),
        maxTurns: 3,
        permissionMode: "bypassPermissions",
        ...(getBackendEnv() ? { env: getBackendEnv() } : {}),
        mcpServers: { reduce: reduceServer },
        allowedTools: ["mcp__reduce__record_monthly_synthesis"],
      },
    })) {
      if (msg.type === "result") {
        log.info("Monthly reduce complete", {
          turns: msg.num_turns,
          cost: msg.total_cost_usd?.toFixed(6),
        });
      }
    }
  } catch (err) {
    log.error("Monthly reduce failed", { error: String(err) });
    return null;
  }
  return capture.data;
}

function appendLines(filePath: string, heading: string, lines: string[]): void {
  if (lines.length === 0) return;
  const stamp = isoDateOnly();
  const block = `\n## ${heading} — appended ${stamp}\n${lines.map((l) => (l.startsWith("- ") ? l : `- ${l}`)).join("\n")}\n`;
  const existing = existsSync(filePath) ? readFileSync(filePath, "utf-8") : `# ${heading}\n`;
  writeFileSync(filePath, existing.trimEnd() + "\n" + block);
}

export interface MonthlySynthResult {
  mapped: number;
  reduced: boolean;
  appendedTo: string[];
}

export async function synthesizeMonthly(): Promise<MonthlySynthResult> {
  const mapped = await mapScanExtractions(30);
  const since = new Date(Date.now() - 35 * 86400_000).toISOString();
  const bundle = gatherReduceBundle(since);
  const reduce = await runReduce(bundle);
  if (!reduce) return { mapped, reduced: false, appendedTo: [] };

  const appendedTo: string[] = [];
  const files = [
    { file: join(TRADING_DIR, "PLAYBOOK.md"), heading: "monthly additions (setups)", lines: reduce.playbook_appends },
    { file: join(TRADING_DIR, "LESSONS.md"), heading: "monthly additions (failures)", lines: reduce.lessons_appends },
    { file: join(TRADING_DIR, "MODELS.md"), heading: "monthly additions (indicator combos)", lines: reduce.models_appends },
    { file: join(TRADING_DIR, "RESEARCH.md"), heading: "monthly additions (open hypotheses)", lines: reduce.research_appends },
  ];
  for (const f of files) {
    if (f.lines.length > 0) {
      appendLines(f.file, f.heading, f.lines);
      appendedTo.push(f.file);
    }
  }
  return { mapped, reduced: true, appendedTo };
}

// Unused imports kept for future expansion
void HAIKU;

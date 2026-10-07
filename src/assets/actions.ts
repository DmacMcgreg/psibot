/**
 * What happens when David acts on an asset. Status actions (queue, adopt, done,
 * dismiss, outcome) only change the registry. Filing actions (get, download,
 * add_to_skill, send_to_design_kit, pursue) also write the asset into its home
 * on disk (see homes.ts) and record that path as `home_path`.
 *
 * Filing is idempotent: a second call finds its own marker (the asset id) and
 * reports the existing home instead of appending a duplicate. Existing files
 * David may have edited (CARD.md, an opportunity file) are never overwritten.
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, openSync, closeSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { createLogger } from "../shared/logger.ts";
import { getAsset, setAssetStatus, setAssetHome, addAssetEvent, slug } from "./store.ts";
import type { AssetDetails, AssetKind, AssetRow, AssetSourceRow, AssetStatus } from "./types.ts";
import {
  HOMES, CATALOG_FILE, NEW_SKILLS_FILE, INTAKE_FILE, OPPORTUNITIES_DIR, FIELD_NOTES, MAX_DOWNLOAD_BYTES,
  assertInsideHomes, datasetDir, mediaDriveMounted, resolveSkillHome, type SkillHome,
} from "./homes.ts";

const log = createLogger("assets-actions");

export const ASSET_ACTIONS = [
  "queue", "adopt", "done", "dismiss", "get", "download", "add_to_skill", "send_to_design_kit", "pursue", "outcome",
] as const;
export type AssetAction = (typeof ASSET_ACTIONS)[number];

export const DISMISS_REASONS = ["irrelevant", "low_quality", "already_have", "not_now"] as const;
export const OUTCOMES = ["used", "installed", "applied", "won", "earned"] as const;

/** Which kinds each filing action accepts. Status actions accept every kind. */
const FILING_KINDS: Partial<Record<AssetAction, AssetKind[]>> = {
  get: ["dataset"],
  download: ["dataset"],
  add_to_skill: ["technique", "prompt"],
  send_to_design_kit: ["design_ref"],
  pursue: ["opportunity"],
};

export class ActionError extends Error {
  constructor(public status: 400 | 404 | 409 | 503, message: string) {
    super(message);
  }
}

type FullAsset = NonNullable<ReturnType<typeof getAsset>>;

export interface ActionResult {
  ok: true;
  asset: FullAsset;
  home_path?: string;
  message: string;
}

export interface ActionInput {
  note?: string | null;
  outcome?: string | null;
}

// --- side-effect seams (tests replace these) ---

export interface DownloadHandle { pid: number | null; exited: Promise<number> }

export const actionHooks = {
  /** Bytes in the repo's main revision, or null when unknown. `repoType` picks the matching HF API (models vs datasets). */
  async datasetBytes(repoId: string, repoType: "dataset" | "model" = "dataset"): Promise<number | null> {
    const enc = repoId.split("/").map(encodeURIComponent).join("/");
    const api = repoType === "model" ? "models" : "datasets";
    try {
      const r = await fetch(`https://huggingface.co/api/${api}/${enc}/treesize/main`, { signal: AbortSignal.timeout(15_000) });
      if (r.ok) {
        const j = (await r.json()) as { size?: number };
        if (typeof j.size === "number") return j.size;
      }
      const u = await fetch(`https://huggingface.co/api/${api}/${enc}?expand%5B%5D=usedStorage`, { signal: AbortSignal.timeout(15_000) });
      if (u.ok) {
        const j = (await u.json()) as { usedStorage?: number };
        if (typeof j.usedStorage === "number") return j.usedStorage;
      }
    } catch (e) {
      log.warn("HF size lookup failed", { repoId, repoType, error: String(e) });
    }
    return null;
  },
  /** Start `cmd` detached, appending stdout+stderr to `logPath`. */
  spawn(cmd: string[], logPath: string, env: Record<string, string>): DownloadHandle {
    const fd = openSync(logPath, "a");
    try {
      const proc = Bun.spawn(cmd, { stdout: fd, stderr: fd, stdin: "ignore", env: { ...process.env, ...env } as Record<string, string> });
      proc.unref();
      return { pid: proc.pid, exited: proc.exited };
    } finally {
      closeSync(fd);
    }
  },
  /** The hf CLI, or the uvx fallback when it isn't installed. */
  hfCommand(): string[] {
    const PATH = [process.env.PATH, join(homedir(), ".local/bin"), "/opt/homebrew/bin", "/usr/local/bin"].filter(Boolean).join(":");
    const hf = Bun.which("hf", { PATH });
    if (hf) return [hf];
    const uvx = Bun.which("uvx", { PATH });
    if (uvx) return [uvx, "--from", "huggingface_hub", "hf"];
    throw new ActionError(503, "Neither `hf` nor `uvx` is installed, so the download can't start. Install uv (brew install uv) and retry.");
  },
};

// --- helpers ---

const today = () => new Date().toISOString().slice(0, 10);
const stamp = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

function details(a: AssetRow): AssetDetails {
  try {
    return JSON.parse(a.details_json || "{}") as AssetDetails;
  } catch {
    return {};
  }
}

function load(id: number): FullAsset {
  const a = getAsset(id);
  if (!a) throw new ActionError(404, `No asset with id ${id}.`);
  return a;
}

function requireKind(a: AssetRow, action: AssetAction): void {
  const kinds = FILING_KINDS[action];
  if (kinds && !kinds.includes(a.kind)) {
    throw new ActionError(400, `"${action}" works on ${kinds.join(" or ")} assets; #${a.id} is a ${a.kind}.`);
  }
}

function write(path: string, body: string, extraRoots: string[] = []): void {
  assertInsideHomes(path, extraRoots);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
}

function append(path: string, body: string, extraRoots: string[] = []): void {
  assertInsideHomes(path, extraRoots);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, body);
}

function fileHas(path: string, needle: string): boolean {
  return existsSync(path) && readFileSync(path, "utf-8").includes(needle);
}

function jsonlHasAsset(path: string, id: number): boolean {
  if (!existsSync(path)) return false;
  return readFileSync(path, "utf-8").split("\n").some((l) => {
    if (!l.trim()) return false;
    try {
      return (JSON.parse(l) as { asset_id?: number }).asset_id === id;
    } catch {
      return false;
    }
  });
}

const marker = (id: number) => `<!-- asset:${id} -->`;

function bestSource(a: FullAsset): AssetSourceRow | undefined {
  return a.sources.find((s) => s.evidence) ?? a.sources[0];
}

function sourceLinks(a: FullAsset): string[] {
  const links = new Map<string, string>();
  if (a.url) links.set(a.url, a.title);
  for (const s of a.sources) if (s.source_url) links.set(s.source_url, s.source_title ?? s.source_kind);
  return [...links].map(([url, title]) => `- [${title.replace(/[[\]]/g, "")}](${url})`);
}

function sourcesJson(a: FullAsset) {
  return a.sources.map((s) => ({ kind: s.source_kind, ref: s.source_ref, url: s.source_url, title: s.source_title, evidence: s.evidence }));
}

function fmtBytes(n: number): string {
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)} ${u[i]}`;
}

/** "12 GB", "1.5TB", "300 MB" → bytes; row counts and prose → null. */
export function parseSize(s: string | undefined): number | null {
  const m = s?.match(/([\d.]+)\s*(TB|GB|MB|KB|TiB|GiB|MiB|KiB|B)\b/i);
  if (!m) return null;
  const pow = { B: 0, KB: 1, KIB: 1, MB: 2, MIB: 2, GB: 3, GIB: 3, TB: 4, TIB: 4 }[m[2].toUpperCase()] ?? 0;
  return Number(m[1]) * 1024 ** pow;
}

// --- dataset: get / download ---

type HfRepoType = "dataset" | "model" | "space";
interface DatasetId { host: string; repoId: string | null; name: string; repoType: HfRepoType | null }

/**
 * A Hugging Face URL's repo type and id. `/datasets/<id>` and `/spaces/<id>`
 * carry their type in the path; anything else under huggingface.co is a bare
 * model URL (`huggingface.co/<owner>/<name>`). Matching the prefix first
 * (before falling back to the bare form) keeps `spaces/o/n` from being
 * misread as owner `spaces`, repo `o`.
 */
function detectHfRepo(url: string): { repoType: HfRepoType; repoId: string } | null {
  const prefixed = url.match(/huggingface\.co\/(datasets|spaces)\/([\w.-]+\/[\w.-]+)/i);
  if (prefixed) return { repoType: prefixed[1].toLowerCase() === "datasets" ? "dataset" : "space", repoId: prefixed[2] };
  const bare = url.match(/huggingface\.co\/([\w.-]+\/[\w.-]+)/i);
  return bare ? { repoType: "model", repoId: bare[1] } : null;
}

function datasetId(a: AssetRow): DatasetId {
  const d = details(a);
  const hf = detectHfRepo(a.url ?? "");
  const repoId = (d.repo_id as string | undefined) ?? (hf ? hf.repoId : null);
  // Only the URL states the real repo type; a repo_id with no URL is assumed a dataset (the extractor's convention).
  const repoType: HfRepoType | null = hf ? hf.repoType : d.repo_id ? "dataset" : null;
  const host = (d.host as string | undefined) ?? (hf || d.repo_id ? "huggingface" : (() => {
    try { return new URL(a.url ?? "").hostname.replace(/^www\./, "") || "other"; } catch { return "other"; }
  })());
  return { host, repoId, name: repoId ?? slug(a.title), repoType };
}

function requireDrive(): void {
  if (!mediaDriveMounted()) {
    throw new ActionError(503, `The external drive isn't mounted (${HOMES.mediaDrive}). Plug it in, then retry.`);
  }
}

function cardBody(a: FullAsset, id: DatasetId): string {
  const d = details(a);
  const src = bestSource(a);
  return [
    `# ${a.title}`,
    "",
    `${a.summary}`,
    "",
    "| Field | Value |",
    "|---|---|",
    `| Host | ${id.host} |`,
    `| Repo | ${id.repoId ?? "—"} |`,
    `| License | ${d.license ?? "not stated — check before use"} |`,
    `| Size | ${d.size ?? "unknown"} |`,
    `| Track | ${a.track} |`,
    `| Asset | #${a.id} (score ${a.value_score}) |`,
    `| Filed | ${today()} |`,
    "",
    "## Contents",
    "",
    d.contents ?? "Not stated by the source.",
    "",
    "## Why it matters",
    "",
    a.value_reason || "—",
    "",
    "## Next action",
    "",
    a.next_action || "—",
    "",
    ...(id.repoId && id.host === "huggingface" && id.repoType !== "space"
      ? ["## Download", "", "PsiBot's **Download** action runs this into `./data` (size-checked, refused over 50 GB without `force`):", "", "```sh", `hf download --repo-type ${id.repoType === "model" ? "model" : "dataset"} ${id.repoId} --local-dir ./data`, "```", ""]
      : []),
    "## Sources",
    "",
    ...sourceLinks(a),
    ...(src?.evidence ? ["", `> ${src.evidence.replace(/\n+/g, " ")}`] : []),
    "",
  ].join("\n");
}

function fileDataset(a: FullAsset): { dir: string; card: string; created: boolean; cataloged: boolean } {
  requireDrive();
  const id = datasetId(a);
  const dir = datasetDir(id.host, id.name);
  const card = join(dir, "CARD.md");
  const created = !existsSync(card);
  if (created) write(card, cardBody(a, id));
  const catalog = CATALOG_FILE();
  let cataloged = false;
  if (!jsonlHasAsset(catalog, a.id)) {
    const d = details(a);
    append(catalog, JSON.stringify({
      asset_id: a.id, key: a.key, title: a.title, host: id.host, repo_id: id.repoId, url: a.url,
      license: d.license ?? null, size: d.size ?? null, contents: d.contents ?? null, track: a.track,
      tracks: JSON.parse(a.tracks_json || "[]"), why: a.value_reason, next_action: a.next_action,
      path: dir, card, filed_at: stamp(), downloaded: false,
    }) + "\n");
    cataloged = true;
  }
  return { dir, card, created, cataloged };
}

async function actGet(a: FullAsset): Promise<{ home: string; message: string; status: AssetStatus }> {
  const f = fileDataset(a);
  const what = f.created ? "Wrote CARD.md" : "CARD.md already existed";
  const cat = f.cataloged ? " and added it to Databases/CATALOG.jsonl" : "";
  return { home: f.card, status: "in_use", message: `${what} in ${f.dir}${cat}.` };
}

async function actDownload(a: FullAsset, note: string): Promise<{ home: string; message: string; status: AssetStatus }> {
  const id = datasetId(a);
  if (id.host !== "huggingface" || !id.repoId) {
    throw new ActionError(400, `Download only handles Hugging Face datasets and models; #${a.id} has no Hugging Face repo id. Use Get to file a card instead.`);
  }
  if (id.repoType === "space") {
    throw new ActionError(400, `#${a.id} (${id.repoId}) is a Hugging Face Space, not a dataset or model — there's nothing for Download to fetch. Open ${a.url ?? "its page"} instead.`);
  }
  requireDrive();
  const repoType: "dataset" | "model" = id.repoType === "model" ? "model" : "dataset";
  const force = /\bforce\b/i.test(note);
  let bytes = await actionHooks.datasetBytes(id.repoId, repoType);
  if (bytes == null) bytes = parseSize(details(a).size as string | undefined);
  if (bytes == null && !force) {
    throw new ActionError(409, `Couldn't find the size of ${id.repoId}. Add "force" to the note to download anyway.`);
  }
  if (bytes != null && bytes > MAX_DOWNLOAD_BYTES && !force) {
    throw new ActionError(409, `${id.repoId} is ${fmtBytes(bytes)}, over the 50 GB limit. Add "force" to the note to download anyway.`);
  }
  const f = fileDataset(a);
  const dataDir = join(f.dir, "data");
  const logPath = join(f.dir, "download.log");
  assertInsideHomes(dataDir);
  mkdirSync(dataDir, { recursive: true });
  const cmd = [...actionHooks.hfCommand(), "download", "--repo-type", repoType, id.repoId, "--local-dir", dataDir];
  append(logPath, `\n[${stamp()}] ${cmd.join(" ")}\n`);
  // Keep xet chunk caches on the drive too; the internal disk is 91% full.
  const h = actionHooks.spawn(cmd, logPath, { HF_XET_CACHE: join(HOMES.databasesDir, ".hf-xet-cache"), HF_HUB_DISABLE_TELEMETRY: "1" });
  const size = bytes != null ? fmtBytes(bytes) : "unknown size";
  addAssetEvent(a.id, "download_started", `pid ${h.pid ?? "?"}, ${size}, log ${logPath}`);
  h.exited.then((code) => {
    try {
      addAssetEvent(a.id, code === 0 ? "download_done" : "download_failed", `exit ${code}; log ${logPath}`);
      append(logPath, `[${stamp()}] exit ${code}\n`);
    } catch (e) {
      log.warn("Could not record download exit", { id: a.id, error: String(e) });
    }
  }).catch(() => {});
  log.info("Dataset download started", { id: a.id, repo: id.repoId, size, pid: h.pid });
  return { home: dataDir, status: "in_use", message: `Downloading ${id.repoId} (${size}) into ${dataDir}. Progress is logged to ${logPath}.` };
}

// --- technique / prompt: add_to_skill ---

function noteEntry(a: FullAsset, heading: "##" | "###"): string {
  const d = details(a);
  const src = bestSource(a);
  const url = src?.source_url ?? a.url;
  const at = d.timestamp ? ` at ${d.timestamp}` : "";
  const steps = Array.isArray(d.steps) && d.steps.length
    ? d.steps.map((s, i) => `${i + 1}. ${String(s).trim()}`)
    : [`1. ${a.next_action || a.summary}`];
  return [
    `${heading} ${today()} · ${a.title} ${marker(a.id)}`,
    "",
    a.summary,
    "",
    ...steps,
    "",
    `- Source: ${url ? `[${(src?.source_title ?? a.title).replace(/[[\]]/g, "")}](${url})` : "no link"}${at}`,
    ...(src?.evidence ? [`- Evidence: "${src.evidence.replace(/\s+/g, " ").trim()}"`] : []),
    `- Why: ${a.value_reason}`,
    `- Asset: #${a.id} (${a.kind}, track ${a.track}, score ${a.value_score})`,
    "",
  ].join("\n");
}

const FIELD_NOTES_HEADER = (skill: string) => `# Field notes: ${skill}

Dated techniques filed from PsiBot's asset registry when David chose **Add to skill**.
Each entry has the steps, the source link, the evidence and the asset id. The weekly
skill forge (PsiBot, Sundays 18:00) reads new entries and drafts proposed SKILL.md
edits into \`telegram-claude-code/knowledge/skill-forge/\`. Nothing edits SKILL.md
automatically: review a proposal, then apply it by hand.

`;

const NEW_SKILLS_HEADER = `# New-skill candidates

Techniques and prompts filed with **Add to skill** that have no existing skill to go to,
grouped by goal track. When a track collects 3 or more entries, the weekly skill forge
drafts a new-skill proposal next to this file.

`;

/** Insert `entry` at the end of the `## track: <id>` section, creating it if needed. */
export function insertUnderTrack(doc: string, track: string, entry: string): string {
  const head = `## track: ${track}`;
  const lines = doc.split("\n");
  const start = lines.findIndex((l) => l.trim() === head);
  if (start < 0) return `${doc.replace(/\n*$/, "\n\n")}${head}\n\n${entry}`;
  let end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  if (end < 0) end = lines.length;
  const before = lines.slice(0, end).join("\n").replace(/\n*$/, "\n\n");
  const after = lines.slice(end).join("\n");
  return `${before}${entry}${after ? `\n${after}` : ""}`;
}

async function actAddToSkill(a: FullAsset): Promise<{ home: string; message: string; status: AssetStatus }> {
  const target = details(a).target_skill as string | undefined;
  const home: SkillHome | null = resolveSkillHome(target);
  if (home) {
    const path = join(home.dir, FIELD_NOTES);
    if (fileHas(path, marker(a.id))) {
      return { home: path, status: "done", message: `Already in ${home.name}'s field notes (${path}).` };
    }
    const prefix = existsSync(path) ? "" : FIELD_NOTES_HEADER(home.name);
    append(path, prefix + (prefix ? "" : "\n") + noteEntry(a, "##"), [home.dir]);
    return { home: path, status: "done", message: `Added to ${home.name}'s field notes (${home.owner} source of truth: ${path}). The Sunday skill forge will draft a SKILL.md proposal.` };
  }
  const path = NEW_SKILLS_FILE();
  if (fileHas(path, marker(a.id))) {
    return { home: path, status: "done", message: `Already listed as a new-skill candidate (${path}).` };
  }
  const doc = existsSync(path) ? readFileSync(path, "utf-8") : NEW_SKILLS_HEADER;
  const why = target ? `No skill named "${target}" exists, so it` : "It has no target skill, so it";
  write(path, insertUnderTrack(doc, a.track, noteEntry(a, "###")));
  return { home: path, status: "done", message: `${why} went to new-skills.md under track ${a.track}.` };
}

// --- design_ref: send_to_design_kit ---

const INTAKE_README = `# Intake inbox

\`inbox.jsonl\` receives design references that David sent from PsiBot's asset registry
(**Send to design-kit** on the vivaldi-home Assets page or in Telegram). PsiBot only
appends; it never edits or removes lines. One JSON object per line:

| Field | Meaning |
|---|---|
| \`asset_id\` | PsiBot asset id (\`GET http://127.0.0.1:3141/api/assets/<id>\` has the full record) |
| \`key\` | PsiBot's dedupe key (canonical URL or repo id) |
| \`title\`, \`url\` | What to look at |
| \`summary\` | What it is |
| \`why\` | Why it scored for David's goals |
| \`next_action\` | The suggested next step |
| \`track\` | Goal track from \`telegram-claude-code/knowledge/GOALS.md\` |
| \`license\`, \`repo\` | When the source stated them |
| \`details\` | Every other extracted field |
| \`sources\` | Where it was seen: kind, url, title, evidence |
| \`filed_at\` | ISO timestamp |

## Processing a line

Pick the route by what the reference is (see \`packages/ui-reproductions/README.md\`
for the licence rules — only MIT, Apache-2.0 and BSD sources are reproducible):

- An app or site screen: \`bun run mobbin sites|apps …\`, or a written analysis in \`docs/mobbin-analysis/<slug>.md\`.
- A component library: add it to the bookmark set \`catalog/tools/collect-libraries.ts\` reads.
- A paid or closed design: save a screenshot under \`catalog/.cache/reference/<source>/\` and write a spec with the \`describe-reference\` skill.
- A whole marketing site: the \`website-reproduction\` skill and \`apps/reprokit\`.

Leave processed lines in place; record the result on the asset with PsiBot's
\`outcome\` action (\`POST /api/assets/<id>/action {"action":"outcome","outcome":"applied"}\`).
`;

async function actSendToDesignKit(a: FullAsset): Promise<{ home: string; message: string; status: AssetStatus }> {
  const inbox = INTAKE_FILE();
  const readme = join(HOMES.designKitIntakeDir, "README.md");
  if (!existsSync(readme)) write(readme, INTAKE_README);
  if (jsonlHasAsset(inbox, a.id)) return { home: inbox, status: "done", message: `Already in the design-kit intake inbox (${inbox}).` };
  const d = details(a);
  append(inbox, JSON.stringify({
    asset_id: a.id, key: a.key, title: a.title, url: a.url, summary: a.summary, why: a.value_reason,
    next_action: a.next_action, track: a.track, license: d.license ?? null, repo: d.repo ?? null,
    details: d, sources: sourcesJson(a), filed_at: stamp(),
  }) + "\n");
  return { home: inbox, status: "done", message: `Sent to the design-kit intake inbox (${inbox}).` };
}

// --- opportunity: pursue ---

const CLOUD_NEXUS_README = `# Cloud Nexus Solutions

Business folder for Cloud Nexus Solutions (trade name of 11046357 Canada Corp.).

## opportunities/

One Markdown file per tender, RFP, grant, program or lead David decided to pursue,
named \`<deadline>-<slug>.md\` so the folder sorts by deadline. PsiBot's research system
creates each file when David chooses **Pursue** on an opportunity asset (vivaldi-home
Assets page or Telegram). The frontmatter carries source, org, reference, deadline,
amount, categories and \`status\`; the body is a bid/no-bid checklist sized for a
1–3 person shop, the requirements to confirm, next steps and links.

Edit these files freely: PsiBot never overwrites an existing one. When a bid
resolves, set \`status:\` to \`submitted\`, \`won\`, \`lost\` or \`no-bid\`, and record the
result on the asset (\`POST http://127.0.0.1:3141/api/assets/<id>/action\` with
\`{"action":"outcome","outcome":"won"}\`) so the ranking learns what pays.
`;

const yaml = (v: unknown): string => {
  if (v == null || v === "") return '""';
  if (Array.isArray(v)) return `[${v.map((x) => JSON.stringify(String(x))).join(", ")}]`;
  return JSON.stringify(String(v));
};

function opportunityBody(a: FullAsset): string {
  const d = details(a);
  const kinds = [...new Set(a.sources.map((s) => s.source_kind))];
  const fm = [
    "---",
    `title: ${yaml(a.title)}`,
    `source: ${yaml(kinds.join(", ") || "unknown")}`,
    `org: ${yaml(d.org)}`,
    `type: ${yaml(d.opportunity_type)}`,
    `reference: ${yaml(d.reference)}`,
    `deadline: ${yaml(a.deadline)}`,
    `amount: ${yaml(a.amount)}`,
    `categories: ${yaml(Array.isArray(d.categories) ? d.categories : [])}`,
    `region: ${yaml(d.region)}`,
    `url: ${yaml(a.url)}`,
    `asset_id: ${a.id}`,
    `track: ${yaml(a.track)}`,
    `status: pursuing`,
    `created: ${today()}`,
    "---",
  ];
  const days = a.deadline ? Math.ceil((Date.parse(a.deadline) - Date.now()) / 86_400_000) : null;
  return [
    ...fm,
    "",
    `# ${a.title}`,
    "",
    a.summary,
    "",
    `**Why it scored:** ${a.value_reason}`,
    "",
    `**Deadline:** ${a.deadline ?? "not stated"}${days != null ? ` (${days} days from ${today()})` : ""} · **Amount:** ${a.amount ?? "not stated"} · **Org:** ${d.org ?? "not stated"}`,
    "",
    "## Bid / no-bid (1–3 person shop)",
    "",
    "Answer each before spending more than an hour. Any hard **no** means no-bid.",
    "",
    "- [ ] **Eligibility:** we meet every mandatory requirement (incorporation, location, Canadian ownership, years in business).",
    "- [ ] **No clearance or bonding:** no security clearance, surety bond or large insurance minimums we can't carry.",
    "- [ ] **Team size:** the scope fits 1–3 people (David, Sarunas, one subcontractor) in the delivery window.",
    "- [ ] **Capability match:** it maps to an existing offer (marketing sites, AI automation, WCAG audits, video) or an asset we already have.",
    "- [ ] **Evaluation basis:** lowest price vs best value is known, and our rate ($85/hr) is competitive for it.",
    "- [ ] **References:** we can name the past projects or references the solicitation asks for.",
    "- [ ] **Effort vs value:** bid prep time (usually 8–20 h) is justified by the amount and our realistic win odds.",
    "- [ ] **Cash flow:** payment terms (net 30/60, milestone, reimbursement grants) are survivable.",
    "- [ ] **Incumbent:** no obvious incumbent or wired spec.",
    "- [ ] **Deadline:** there's time to ask questions before the Q&A cutoff and submit two working days early.",
    "",
    "**Decision:** ☐ bid ☐ no-bid — reason:",
    "",
    "## Requirements to confirm",
    "",
    `- Eligibility as stated: ${d.eligibility ?? "not stated in the source — read the solicitation"}.`,
    `- Reference / solicitation number: ${d.reference ?? "—"}.`,
    `- Categories: ${Array.isArray(d.categories) && d.categories.length ? d.categories.join(", ") : "—"}.`,
    "- Mandatory forms, certifications and registrations (SAP Ariba / CanadaBuys supplier registration, PBN, WSIB, insurance).",
    "- Q&A deadline and how questions are submitted.",
    "- Submission format, page limits and where to submit.",
    "- Pricing format (fixed price, per diem, ceiling) and whether travel is included.",
    "- Matching funds or cost-share (grants and programs).",
    "",
    "## Next steps",
    "",
    `1. ${a.next_action || "Read the full solicitation."}`,
    "2. Download the full solicitation and any amendments into this folder.",
    "3. Fill in the bid/no-bid checklist and record the decision above.",
    "4. If bidding: register as a supplier, draft the compliance matrix, then the technical and price responses.",
    "5. Record the result on the asset (`outcome`: won / earned) and set `status:` above.",
    "",
    "## Links",
    "",
    ...sourceLinks(a),
    "",
  ].join("\n");
}

/**
 * The opportunity file that already carries asset `id`'s frontmatter marker
 * (`asset_id: N`), if one exists — idempotency keyed on the asset, not on a
 * filename built from its (possibly since-amended) title and deadline.
 */
function findOpportunityFile(id: number): string | null {
  const dir = OPPORTUNITIES_DIR();
  if (!existsSync(dir)) return null;
  const marker = new RegExp(`^asset_id: ${id}$`, "m");
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".md")) continue;
    try {
      if (marker.test(readFileSync(join(dir, name), "utf-8"))) return join(dir, name);
    } catch {
      /* unreadable: skip */
    }
  }
  return null;
}

/** A placeholder deadline (e.g. "2099-11-22" on a supply-arrangement refresh notice) carries no real urgency. */
function isPlaceholderDeadline(deadline: string | null): boolean {
  const year = Number(deadline?.slice(0, 4));
  return Number.isFinite(year) && year >= 2090;
}

async function actPursue(a: FullAsset): Promise<{ home: string; message: string; status: AssetStatus }> {
  const readme = join(HOMES.cloudNexusDir, "README.md");
  if (!existsSync(readme)) write(readme, CLOUD_NEXUS_README);
  const existing = findOpportunityFile(a.id);
  if (existing) return { home: existing, status: "in_use", message: `Already pursuing: ${existing}.` };
  const stem = isPlaceholderDeadline(a.deadline) ? "rolling" : (a.deadline?.slice(0, 10) ?? "no-deadline");
  const name = `${stem}-${slug(a.title).slice(0, 60) || `asset-${a.id}`}.md`;
  let path = join(OPPORTUNITIES_DIR(), name);
  // A different asset's file happens to slug to the same name: disambiguate rather than overwrite it.
  if (existsSync(path)) path = join(OPPORTUNITIES_DIR(), `asset-${a.id}-${name}`);
  write(path, opportunityBody(a));
  return { home: path, status: "in_use", message: `Created ${path} with a bid/no-bid checklist.` };
}

/**
 * Close an opportunity whose notice disappeared from its feed (cancelled,
 * withdrawn, or awarded before its stated deadline) — called by feeds, not by
 * a user action, so it goes through the same status primitives `runAssetAction`
 * itself uses rather than raw SQL. Never moves an asset backwards: one already
 * `done` or `dismissed` (by David, or by an earlier sweep) is left alone.
 */
export function closeStaleOpportunity(id: number, note: string): void {
  const a = getAsset(id);
  if (!a || a.status === "done" || a.status === "dismissed") return;
  setAssetStatus(id, "done", "feed_closed", note, "closed_or_cancelled");
}

// --- dispatcher ---

function normalizeOutcome(input: ActionInput): string {
  const raw = (input.outcome ?? input.note?.trim().split(/[\s:,.-]+/)[0] ?? "").toLowerCase();
  if (!(OUTCOMES as readonly string[]).includes(raw)) {
    throw new ActionError(400, `outcome must be one of ${OUTCOMES.join(", ")}.`);
  }
  return raw;
}

function dismissReason(note: string): string {
  const first = note.trim().toLowerCase().split(/[\s:,.]+/)[0]?.replace(/-/g, "_") ?? "";
  return (DISMISS_REASONS as readonly string[]).includes(first) ? first : note.trim() ? "other" : "unspecified";
}

/**
 * Run one action on asset `id`. Throws ActionError (with an HTTP status) when
 * the action doesn't fit the asset or its home is unavailable.
 */
export async function runAssetAction(id: number, action: string, input: ActionInput = {}): Promise<ActionResult> {
  if (!(ASSET_ACTIONS as readonly string[]).includes(action)) {
    throw new ActionError(400, `Unknown action "${action}". Use one of: ${ASSET_ACTIONS.join(", ")}.`);
  }
  const act = action as AssetAction;
  const a = load(id);
  requireKind(a, act);
  const note = input.note?.trim() ?? "";

  let status: AssetStatus;
  let outcome: string | null = null;
  let home: string | undefined;
  let message: string;

  switch (act) {
    case "queue":
      status = "queued";
      message = `Queued "${a.title}".`;
      break;
    case "adopt": {
      status = "in_use";
      const install = details(a).install as string | undefined;
      message = install
        ? `Marked "${a.title}" in use. Install it yourself when ready: ${install} (nothing is auto-installed; 14-day dependency cooldown).`
        : `Marked "${a.title}" in use.`;
      break;
    }
    case "done":
      status = "done";
      message = `Marked "${a.title}" done.`;
      break;
    case "dismiss": {
      status = "dismissed";
      const reason = dismissReason(note);
      outcome = `dismissed:${reason}`;
      message = `Dismissed "${a.title}" (${reason.replace(/_/g, " ")}).`;
      break;
    }
    case "outcome": {
      outcome = normalizeOutcome(input);
      status = (a.kind === "tool" || a.kind === "skill") && (outcome === "used" || outcome === "installed") ? "in_use" : "done";
      message = `Recorded outcome "${outcome}" for "${a.title}".`;
      break;
    }
    default: {
      const r =
        act === "get" ? await actGet(a)
        : act === "download" ? await actDownload(a, note)
        : act === "add_to_skill" ? await actAddToSkill(a)
        : act === "send_to_design_kit" ? await actSendToDesignKit(a)
        : await actPursue(a);
      status = r.status;
      home = r.home;
      message = r.message;
      setAssetHome(a.id, home);
    }
  }

  // Filing an asset that is already further along never moves it backwards.
  if (home && (a.status === "done" || (a.status === "in_use" && status !== "done"))) status = a.status;
  setAssetStatus(a.id, status, act, note || (home ? home : null), outcome);
  log.info("Asset action", { id: a.id, action: act, status, home });
  return { ok: true, asset: load(a.id), ...(home ? { home_path: home } : {}), message };
}

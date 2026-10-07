/**
 * "Already have" filter: is this asset something David already owns?
 *
 * Owned means one of:
 * - an installed agent skill (~/.agents/skills, ~/.claude/skills, the skills
 *   CLI lock file) or Claude Code plugin (installed_plugins.json, plugin cache);
 * - a component library design-kit already catalogs (libraries.json);
 * - his own stack (agent-native, claude-mem, PsiBot, Jev, HyperFrames, vaultd),
 *   any repo under github.com/DmacMcgreg, or a repo cloned into
 *   ~/Documents/2_Code/2026.
 *
 * Matching is exact, never fuzzy: the asset's GitHub repo, npm package, named
 * skill or plugin, or site must equal a known one. A skill called "seo" does
 * not make every SEO repo owned. Two refinements keep it precise:
 * - A repo that ships many skills or plugins (mattpocock/skills, a plugin
 *   marketplace) is owned as a whole, but an asset that names specific skills
 *   in it is owned only when those skills are installed.
 * - A design-kit library's site is owned, but a page that names one specific
 *   block is not: GOALS.md says a named block may still be worth reproducing.
 *
 * Techniques and prompts are knowledge, not installs, so they count as owned
 * only when they come from David's own repos. Opportunities never do.
 *
 * The index is rebuilt at most every INDEX_TTL_MS, so a skill installed today
 * is seen within minutes. Feeds can use markOwned() and dismissIfOwned() too.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { installedSkills } from "./feeds/skills-sh.ts";
import { runAssetAction } from "./actions.ts";
import { getAsset } from "./store.ts";
import type { AssetInput } from "./types.ts";

export interface OwnedResult {
  owned: boolean;
  reason: string | null;
}

export type OwnedAsset = Pick<AssetInput, "kind" | "url" | "details"> & { title?: string };

interface RepoEntry {
  reason: string;
  /** Ships several skills or plugins: an asset naming some of them is owned only if they are installed. */
  pack: boolean;
}

interface SiteEntry {
  /** Path the site entry covers ("" = the whole host). */
  base: string;
  reason: string;
  /** design-kit library: a page naming a specific block is not owned. */
  library: boolean;
  /** Plain string prefix (own-stack model ids such as /typesafe/jev*) instead of whole path segments. */
  loose: boolean;
}

export interface OwnedIndex {
  /** Installed skill and plugin names → why. */
  names: Map<string, string>;
  /** "owner/repo" (lowercase) → why. */
  repos: Map<string, RepoEntry>;
  /** GitHub owners whose every repo is David's. */
  owners: Map<string, string>;
  /** GitHub owner → skill and plugin names installed from that owner's repos. */
  ownerNames: Map<string, Set<string>>;
  /** Host without www. → site entries. */
  sites: Map<string, SiteEntry[]>;
  /** npm package → why. */
  packages: Map<string, string>;
}

export interface OwnedPaths {
  skillDirs: string[];
  skillLock: string;
  /** ~/.claude/plugins (installed_plugins.json, known_marketplaces.json, cache/). */
  pluginsDir: string;
  /** design-kit catalog/libraries.json. */
  catalog: string;
  /** Folders whose child git repos count as cloned. */
  cloneRoots: string[];
}

const HOME = homedir();
const CODE = join(HOME, "Documents/2_Code/2026");

export const DEFAULT_OWNED_PATHS: OwnedPaths = {
  skillDirs: [join(HOME, ".claude/skills"), join(HOME, ".agents/skills")],
  skillLock: join(HOME, ".agents/.skill-lock.json"),
  pluginsDir: join(HOME, ".claude/plugins"),
  catalog: join(CODE, "design-kit/packages/ui-reproductions/catalog/libraries.json"),
  cloneRoots: [CODE],
};

/** GitHub accounts whose every repo is David's. */
export const OWN_GITHUB_OWNERS = ["dmacmcgreg"];

/** David's own stack: these repos, sites and packages are "already have" whatever the source says. */
export const OWN_STACK: { name: string; why: string; repos?: string[]; sites?: string[]; packages?: string[] }[] = [
  {
    name: "agent-native", why: "fleet-native is built on @agent-native/core",
    repos: ["builderio/agent-native"], sites: ["agent-native.com"], packages: ["@agent-native/core", "agent-native"],
  },
  { name: "claude-mem", why: "the claude-mem plugin is installed", repos: ["thedotmack/claude-mem"], packages: ["claude-mem"] },
  { name: "PsiBot", why: "this is PsiBot itself", repos: ["dmacmcgreg/psibot", "dmacmcgreg/telegram-claude-code"] },
  { name: "Jev", why: "Jev (TypeSafe System One) already runs PsiBot's relevance engine", sites: ["openrouter.ai/typesafe/jev"] },
  {
    name: "HyperFrames", why: "the HyperFrames skills are installed",
    repos: ["heygen-com/hyperframes"], sites: ["hyperframes.heygen.com"], packages: ["hyperframes"],
  },
  { name: "vaultd", why: "David's own credential broker", repos: ["dmacmcgreg/vaultd"] },
];

/** Hosts shared by many unrelated projects: never owned by host alone. */
const SHARED_HOSTS = new Set([
  "github.com", "gitlab.com", "npmjs.com", "huggingface.co", "x.com", "twitter.com", "youtube.com", "youtu.be",
  "reddit.com", "medium.com", "dev.to", "vercel.app", "netlify.app", "codepen.io", "dribbble.com", "figma.com",
]);

/** Listing and landing pages of a library site; any other path names a specific block or page. */
const GENERIC_PAGES = new Set([
  "blocks", "components", "component", "templates", "template", "docs", "documentation", "ui", "pro", "pricing",
  "examples", "showcase", "library", "r", "registry", "registry.json", "preview", "free", "premium", "getting-started",
  "get-started", "installation", "introduction", "changelog", "about", "themes", "kits", "sections", "pages", "all",
  "react", "vue", "home", "index",
]);

// --- identifiers -----------------------------------------------------------

const REPO_RE = /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/;

/** "Owner/Repo", a GitHub URL or "owner/repo.git" → "owner/repo"; null when it isn't a clean repo id. */
export function normRepo(s: string | null | undefined): string | null {
  const t = (s ?? "").trim().toLowerCase()
    .replace(/^(https?:\/\/)?(www\.)?github\.com\//, "").replace(/^git@github\.com:/, "")
    .replace(/[?#].*$/, "").replace(/\/+$/, "").replace(/\.git$/, "");
  return REPO_RE.test(t) ? t : null;
}

const cleanName = (s: string) => s.toLowerCase().replace(/\.md$/, "").trim();

/** "@scope/pkg@1.2" or "pkg@latest" → the bare package name. */
const bareName = (p: string) => p.replace(/(.)@[^/@]*$/, "$1").toLowerCase();

export interface AssetIds {
  repos: string[];
  /** Skill or plugin names the asset names explicitly (install flags, /skills/<name> paths). */
  names: string[];
  packages: string[];
  host: string | null;
  path: string;
}

/** Everything an asset says about what it is: repos, named skills, packages, site. */
export function assetIds(asset: OwnedAsset): AssetIds {
  const repos = new Set<string>();
  const names = new Set<string>();
  const packages = new Set<string>();
  let host: string | null = null;
  let path = "";
  if (asset.url) {
    try {
      const u = new URL(asset.url);
      host = u.hostname.toLowerCase().replace(/^www\./, "");
      path = u.pathname.replace(/\/+$/, "");
      const seg = path.split("/").filter(Boolean);
      if (host === "github.com") {
        const r = normRepo(seg.slice(0, 2).join("/"));
        if (r) repos.add(r);
        // github.com/<o>/<r>/tree/<branch>/skills/<name> or …/plugins/<name>
        const i = seg.findIndex((s, k) => k >= 2 && (s === "skills" || s === "plugins"));
        if (i > 0 && seg[i + 1]) names.add(cleanName(seg[i + 1]));
      } else if (host === "npmjs.com" && seg[0] === "package" && seg[1]) {
        packages.add(bareName(seg[1].startsWith("@") && seg[2] ? `${seg[1]}/${seg[2]}` : seg[1]));
      }
    } catch { /* not a URL */ }
  }
  const d = (asset.details ?? {}) as Record<string, unknown>;
  const repo = normRepo(typeof d.repo === "string" ? d.repo : null);
  if (repo) repos.add(repo);
  const install = typeof d.install === "string" ? d.install : "";
  if (install) {
    for (const m of install.matchAll(/(?:skills add|plugin marketplace add|plugin (?:add|install)|git clone)\s+(?:https?:\/\/(?:www\.)?github\.com\/)?([\w.-]+\/[\w.-]+)/gi)) {
      const r = normRepo(m[1]);
      if (r) repos.add(r);
    }
    for (const m of install.matchAll(/github\.com\/([\w.-]+\/[\w.-]+)/gi)) {
      const r = normRepo(m[1]);
      if (r) repos.add(r);
    }
    // "--skill a b c --global": names up to the next flag or line end.
    for (const m of install.matchAll(/--skill[ \t]+((?:[a-z0-9_][\w.-]*[ \t,]*)+)/gi)) {
      for (const n of m[1].split(/[ \t,]+/)) if (n) names.add(cleanName(n));
    }
    for (const m of install.matchAll(/plugin install\s+([\w.-]+)@/gi)) names.add(cleanName(m[1]));
    for (const m of install.matchAll(/\b(?:npx|bunx|pnpm dlx|npm (?:i|install)|pnpm add|bun add|yarn add)\s+(?:(?:-y|--yes|-g|--global)\s+)*(@?[\w.-]+(?:\/[\w.-]+)?(?:@[\w.-]+)?)/gi)) {
      packages.add(bareName(m[1]));
    }
  }
  return { repos: [...repos], names: [...names], packages: [...packages], host, path };
}

// --- index -------------------------------------------------------------------

function readJson<T>(path: string): T | null {
  try { return JSON.parse(readFileSync(path, "utf-8")) as T; } catch { return null; }
}

function listDir(path: string): string[] {
  try { return readdirSync(path).filter((n) => !n.startsWith(".")); } catch { return []; }
}

function addOwnerName(index: OwnedIndex, repo: string, name: string): void {
  const owner = repo.split("/")[0];
  let set = index.ownerNames.get(owner);
  if (!set) index.ownerNames.set(owner, (set = new Set()));
  set.add(name);
}

function addRepo(index: OwnedIndex, repo: string | null, entry: RepoEntry): void {
  if (repo && !index.repos.has(repo)) index.repos.set(repo, entry);
}

function addSite(index: OwnedIndex, raw: string, entry: Omit<SiteEntry, "base">): void {
  let host: string;
  let base: string;
  try {
    const u = new URL(/^https?:\/\//.test(raw) ? raw : `https://${raw}`);
    host = u.hostname.toLowerCase().replace(/^www\./, "");
    base = u.pathname.replace(/\/+$/, "").toLowerCase();
  } catch {
    return;
  }
  if (SHARED_HOSTS.has(host)) return;
  // A library listed at one generic page (…/blocks, …/docs) is the whole site.
  const seg = base.split("/").filter(Boolean);
  if (entry.library && seg.length === 1 && GENERIC_PAGES.has(seg[0])) base = "";
  const list = index.sites.get(host) ?? [];
  list.push({ ...entry, base });
  index.sites.set(host, list);
}

/** Build the index from disk. Missing files are skipped; nothing here throws. */
export function buildOwnedIndex(paths: OwnedPaths = DEFAULT_OWNED_PATHS): OwnedIndex {
  const index: OwnedIndex = {
    names: new Map(), repos: new Map(), owners: new Map(), ownerNames: new Map(), sites: new Map(), packages: new Map(),
  };

  // David's own stack first, so its reasons win.
  for (const o of OWN_GITHUB_OWNERS) index.owners.set(o, "David's own GitHub repo");
  for (const s of OWN_STACK) {
    for (const r of s.repos ?? []) addRepo(index, normRepo(r), { reason: `${s.name}: ${s.why}`, pack: false });
    for (const site of s.sites ?? []) addSite(index, site, { reason: `${s.name}: ${s.why}`, library: false, loose: true });
    for (const p of s.packages ?? []) index.packages.set(p.toLowerCase(), `${s.name}: ${s.why}`);
  }

  // Skills: the skills CLI lock file knows each skill's source repo.
  const lock = readJson<{ skills?: Record<string, { source?: string; sourceType?: string }> }>(paths.skillLock);
  const bySource = new Map<string, string[]>();
  for (const [name, s] of Object.entries(lock?.skills ?? {})) {
    const repo = s?.sourceType === "github" ? normRepo(s.source) : null;
    const n = cleanName(name);
    index.names.set(n, repo ? `skill ${n} is installed from ${repo}` : `skill ${n} is installed`);
    if (repo) {
      bySource.set(repo, [...(bySource.get(repo) ?? []), n]);
      addOwnerName(index, repo, n);
    }
  }
  for (const [repo, ns] of bySource) {
    addRepo(index, repo, { reason: `skills installed from it (${ns.slice(0, 4).join(", ")}${ns.length > 4 ? `, +${ns.length - 4}` : ""})`, pack: true });
  }
  for (const n of installedSkills(paths.skillDirs)) {
    if (!n.startsWith(".") && !index.names.has(n)) index.names.set(n, `skill ${n} is installed`);
  }

  // Plugins: installed_plugins.json keys are "<plugin>@<marketplace>"; marketplaces map to repos.
  const installed = readJson<{ plugins?: Record<string, { installPath?: string }[]> }>(join(paths.pluginsDir, "installed_plugins.json"));
  const markets = readJson<Record<string, { source?: { source?: string; repo?: string } }>>(join(paths.pluginsDir, "known_marketplaces.json")) ?? {};
  const byMarket = new Map<string, string[]>();
  for (const [key, installs] of Object.entries(installed?.plugins ?? {})) {
    const [plugin, market] = key.split("@");
    if (!plugin) continue;
    const n = cleanName(plugin);
    const src = market ? markets[market]?.source : undefined;
    const repo = src?.source === "github" ? normRepo(src.repo) : null;
    index.names.set(n, `plugin ${key} is installed`);
    if (market) byMarket.set(market, [...(byMarket.get(market) ?? []), n]);
    if (repo) addOwnerName(index, repo, n);
    // Skills bundled inside the plugin are installed too.
    for (const inst of Array.isArray(installs) ? installs : []) {
      if (!inst?.installPath) continue;
      for (const s of listDir(join(inst.installPath, "skills"))) {
        const sn = cleanName(s);
        if (!index.names.has(sn)) index.names.set(sn, `skill ${sn} ships with installed plugin ${key}`);
        if (repo) addOwnerName(index, repo, sn);
      }
    }
  }
  for (const [market, ns] of byMarket) {
    const src = markets[market]?.source;
    const repo = src?.source === "github" ? normRepo(src.repo) : null;
    addRepo(index, repo, { reason: `plugin marketplace ${market} is added (installed: ${ns.join(", ")})`, pack: true });
  }
  for (const market of listDir(join(paths.pluginsDir, "cache"))) {
    for (const plugin of listDir(join(paths.pluginsDir, "cache", market))) {
      const n = cleanName(plugin);
      if (!index.names.has(n)) index.names.set(n, `plugin ${n} is in the plugin cache`);
    }
  }

  // design-kit's catalog of component libraries.
  const libs = readJson<{ name?: string; url?: string; repo?: string | null }[]>(paths.catalog) ?? [];
  for (const lib of Array.isArray(libs) ? libs : []) {
    const reason = `design-kit already catalogs ${lib.name ?? "this library"}`;
    addRepo(index, normRepo(lib.repo ?? null), { reason, pack: false });
    if (!lib.url) continue;
    const npm = lib.url.match(/npmjs\.com\/package\/((?:@[\w.-]+\/)?[\w.-]+)/i);
    if (npm) index.packages.set(npm[1].toLowerCase(), reason);
    else addSite(index, lib.url, { reason, library: true, loose: false });
  }

  // Repos cloned into the code folder (his own and third-party ones he works from).
  for (const root of paths.cloneRoots) {
    for (const dir of listDir(root)) {
      const cfg = join(root, dir, ".git/config");
      let text = "";
      try {
        if (!statSync(cfg).isFile()) continue;
        text = readFileSync(cfg, "utf-8");
      } catch {
        continue;
      }
      for (const m of text.matchAll(/^\s*url\s*=\s*(\S+)/gm)) {
        const repo = m[1].includes("github.com") ? normRepo(m[1]) : null;
        addRepo(index, repo, { reason: `cloned at ${join(root, dir).replace(HOME, "~")}`, pack: false });
      }
    }
  }
  return index;
}

export const INDEX_TTL_MS = 10 * 60_000;
let cache: { at: number; index: OwnedIndex } | null = null;

/** The cached index (rebuilt when older than INDEX_TTL_MS). */
export function ownedIndex(now = Date.now()): OwnedIndex {
  if (!cache || now - cache.at >= INDEX_TTL_MS) cache = { at: now, index: buildOwnedIndex() };
  return cache.index;
}

/** Test hook: forget the cached index. */
export function resetOwnedCache(): void {
  cache = null;
}

// --- matching ----------------------------------------------------------------

export const NOT_OWNED: OwnedResult = { owned: false, reason: null };
const owned = (reason: string): OwnedResult => ({ owned: true, reason });

/** Path after the site entry's base, or null when the path is outside it. */
function pathUnder(path: string, e: SiteEntry): string | null {
  const p = path.toLowerCase();
  if (e.loose) return p.startsWith(e.base) ? p.slice(e.base.length) : null;
  if (!e.base) return p;
  return p === e.base || p.startsWith(`${e.base}/`) ? p.slice(e.base.length) : null;
}

function namesSpecificPage(rest: string): boolean {
  const seg = rest.split("/").filter(Boolean);
  return seg.length > 1 || (seg.length === 1 && !GENERIC_PAGES.has(seg[0]));
}

/** Does David already have this asset? Exact repo, package, skill-name or site equality only. */
export function ownedMatch(asset: OwnedAsset, index: OwnedIndex = ownedIndex()): OwnedResult {
  if (asset.kind === "opportunity") return NOT_OWNED;
  const ids = assetIds(asset);

  for (const r of ids.repos) {
    const why = index.owners.get(r.split("/")[0]);
    if (why) return owned(`${r}: ${why}`);
  }
  // A technique or prompt about a tool he has is still new knowledge.
  if (asset.kind === "technique" || asset.kind === "prompt") return NOT_OWNED;

  for (const r of ids.repos) {
    const hit = index.repos.get(r);
    if (!hit) continue;
    if (hit.pack && ids.names.length) {
      if (ids.names.every((n) => index.names.has(n))) return owned(`${r}: ${ids.names.join(", ")} already installed`);
      continue; // names a skill or plugin from that repo he doesn't have yet
    }
    return owned(`${r}: ${hit.reason}`);
  }
  // The same skill published in another repo of the same owner (anthropics/skills vs anthropics/claude-code).
  if (ids.names.length) {
    for (const r of ids.repos) {
      const have = index.ownerNames.get(r.split("/")[0]);
      if (have && ids.names.every((n) => have.has(n))) return owned(`${ids.names.join(", ")} already installed from ${r.split("/")[0]}'s repos`);
    }
  }
  for (const p of ids.packages) {
    const why = index.packages.get(p);
    if (why) return owned(`${p}: ${why}`);
  }
  if (ids.host) {
    for (const e of index.sites.get(ids.host) ?? []) {
      const rest = pathUnder(ids.path, e);
      if (rest === null) continue;
      if (e.library && namesSpecificPage(rest)) continue;
      return owned(`${ids.host}${e.base}: ${e.reason}`);
    }
  }
  return NOT_OWNED;
}

/** The asset with details.owned_reason set when David already has it (the same object otherwise). */
export function markOwned<T extends OwnedAsset>(asset: T, match: (a: OwnedAsset) => OwnedResult = ownedMatch): T {
  const m = match(asset);
  if (!m.owned || !m.reason) return asset;
  return { ...asset, details: { ...(asset.details ?? {}), owned_reason: m.reason } };
}

/**
 * Call after upsertAsset: dismiss an asset marked owned (details.owned_reason)
 * as "already_have", recorded the way a Dismiss click is. Leaves it alone when
 * David has already acted on it. Returns true when it dismissed.
 */
export async function dismissIfOwned(id: number, asset: Pick<AssetInput, "details">): Promise<boolean> {
  const reason = asset.details?.owned_reason;
  if (typeof reason !== "string" || !reason) return false;
  const row = getAsset(id);
  if (!row || row.status !== "new") return false;
  await runAssetAction(id, "dismiss", { note: `already_have: ${reason}` });
  return true;
}

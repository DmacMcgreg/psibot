/**
 * Where "act" files each asset kind (the Homes table in
 * vivaldi-home/research/revamp-design.md). Every path an action may write is
 * derived from HOMES; tests repoint it at temp dirs with setHomesForTesting().
 *
 * Skill ownership is split three ways (see revamp-audit-assets.md §1):
 * design-kit owns its `.claude/skills`, local-mcp-hub owns the skills listed in
 * `~/.agents/skills/.hub-managed.json`, and everything else lives in
 * `~/.agents/skills` itself. Writing to a hub-managed skill's derived copy in
 * `~/.agents/skills` would make the hub installer abort, so field notes always
 * go to the source of truth.
 */

import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

const HOME = homedir();
const CODE = join(HOME, "Documents/2_Code/2026");
const REPO = dirname(dirname(dirname(import.meta.path)));

export interface Homes {
  /** External media drive; datasets land here, never on the internal disk. */
  mediaDrive: string;
  /** `<mediaDrive>/Databases`: one folder per dataset plus CATALOG.jsonl. */
  databasesDir: string;
  hubSkillsDir: string;
  hubManagedManifest: string;
  designKitSkillsDir: string;
  agentsSkillsDir: string;
  /** Harness skill dir: mostly symlinks into agentsSkillsDir, plus a few real dirs. */
  claudeSkillsDir: string;
  /** Skill-forge proposals and new-skills.md (inside this repo's knowledge/). */
  forgeDir: string;
  designKitIntakeDir: string;
  cloudNexusDir: string;
}

const DEFAULT_HOMES: Homes = {
  mediaDrive: "/Volumes/CT4000P3 PSSD8 Media",
  databasesDir: "/Volumes/CT4000P3 PSSD8 Media/Databases",
  hubSkillsDir: join(CODE, "local-mcp-hub/skills"),
  hubManagedManifest: join(HOME, ".agents/skills/.hub-managed.json"),
  designKitSkillsDir: join(CODE, "design-kit/.claude/skills"),
  agentsSkillsDir: join(HOME, ".agents/skills"),
  claudeSkillsDir: join(HOME, ".claude/skills"),
  forgeDir: join(REPO, "knowledge/skill-forge"),
  designKitIntakeDir: join(CODE, "design-kit/packages/ui-reproductions/catalog/intake"),
  cloudNexusDir: join(CODE, "cloud-nexus"),
};

/** Live paths. Read through this object so test overrides take effect. */
export const HOMES: Homes = { ...DEFAULT_HOMES };

export const CATALOG_FILE = () => join(HOMES.databasesDir, "CATALOG.jsonl");
export const NEW_SKILLS_FILE = () => join(HOMES.forgeDir, "new-skills.md");
export const INTAKE_FILE = () => join(HOMES.designKitIntakeDir, "inbox.jsonl");
export const OPPORTUNITIES_DIR = () => join(HOMES.cloudNexusDir, "opportunities");
export const FIELD_NOTES = "references/field-notes.md";

/** Refuse downloads bigger than this unless the note says "force". */
export const MAX_DOWNLOAD_BYTES = 50 * 1024 ** 3;

export function setHomesForTesting(overrides: Partial<Homes>): void {
  Object.assign(HOMES, overrides);
}

export function resetHomes(): void {
  Object.assign(HOMES, DEFAULT_HOMES);
}

/** Directory roots an action may write under. */
function writableRoots(): string[] {
  return [
    HOMES.databasesDir, HOMES.hubSkillsDir, HOMES.designKitSkillsDir, HOMES.agentsSkillsDir,
    HOMES.claudeSkillsDir, HOMES.forgeDir, HOMES.designKitIntakeDir, HOMES.cloudNexusDir,
  ].map((p) => resolve(p));
}

/**
 * Throw unless `path` sits under one of the homes. A skill dir reached through
 * a symlink is also allowed once resolved, because that target is the skill's
 * real source of truth.
 */
export function assertInsideHomes(path: string, extraRoots: string[] = []): string {
  const abs = resolve(path);
  const ok = [...writableRoots(), ...extraRoots.map((r) => resolve(r))].some((root) => abs === root || abs.startsWith(root + sep));
  if (!ok) throw new Error(`refusing to write outside the asset homes: ${abs}`);
  return abs;
}

// --- skills ---

export type SkillOwner = "design-kit" | "hub" | "agents";

export interface SkillHome {
  name: string;
  owner: SkillOwner;
  /** Real directory to write in (symlinks resolved for `agents`). */
  dir: string;
}

const SKILL_NAME = /^[a-z0-9][a-z0-9._-]{0,80}$/i;

export function isValidSkillName(name: string): boolean {
  return SKILL_NAME.test(name) && !name.includes("..");
}

export function hubManagedSkills(): Set<string> {
  try {
    const j = JSON.parse(readFileSync(HOMES.hubManagedManifest, "utf-8")) as { skills?: unknown };
    return new Set(Array.isArray(j.skills) ? j.skills.filter((s): s is string => typeof s === "string") : []);
  } catch {
    return new Set();
  }
}

function isSkillDir(dir: string): boolean {
  try {
    return statSync(dir).isDirectory() && existsSync(join(dir, "SKILL.md"));
  } catch {
    return false;
  }
}

/**
 * Where a skill's source of truth lives, or null when no such skill exists.
 * Order: design-kit (it is canonical for design/flow/ui-patterns even though
 * the hub also vendors them), then hub-managed, then ~/.agents/skills and
 * ~/.claude/skills with symlinks resolved.
 */
export function resolveSkillHome(name: string | null | undefined): SkillHome | null {
  if (!name || !isValidSkillName(name)) return null;
  const dk = join(HOMES.designKitSkillsDir, name);
  if (isSkillDir(dk)) return { name, owner: "design-kit", dir: dk };
  if (hubManagedSkills().has(name)) {
    const hub = join(HOMES.hubSkillsDir, name);
    if (isSkillDir(hub)) return { name, owner: "hub", dir: hub };
  }
  for (const root of [HOMES.agentsSkillsDir, HOMES.claudeSkillsDir]) {
    const p = join(root, name);
    if (!existsSync(p)) continue;
    try {
      const real = realpathSync(p);
      if (isSkillDir(real)) return { name, owner: "agents", dir: real };
    } catch {
      /* dangling symlink */
    }
  }
  return null;
}

// --- datasets ---

/** `<databasesDir>/<host>/<owner__name>` for a dataset asset. */
export function datasetDir(host: string, name: string): string {
  const clean = (s: string) => s.replace(/\//g, "__").replace(/[^\w.@-]+/g, "-").replace(/^[-.]+/, "").slice(0, 120) || "unnamed";
  return join(HOMES.databasesDir, clean(host.toLowerCase()), clean(name));
}

/** True when the external drive is mounted. */
export function mediaDriveMounted(): boolean {
  try {
    return statSync(HOMES.mediaDrive).isDirectory();
  } catch {
    return false;
  }
}

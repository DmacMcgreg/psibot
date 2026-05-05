import { getDb } from "../db/index.ts";
import { createLogger } from "../shared/logger.ts";

const log = createLogger("atlas:alias-producer");

const CORP_SUFFIXES = new Set([
  "inc",
  "pbc",
  "corp",
  "corporation",
  "ltd",
  "llc",
  "co",
  "company",
  "platforms",
  "holdings",
  "group",
]);

const MAX_PROPOSALS_PER_RUN = 20;
const MIN_MENTIONS = 2;

interface EntityCandidate {
  id: number;
  kind: string;
  name_norm: string;
  mention_count: number;
}

export interface Proposal {
  entity_id: number;
  alias_norm: string;
  reason: string;
}

export interface ProposeAliasesResult {
  proposed: number;
  skippedExistingAlias: number;
  skippedExistingProposal: number;
}

export interface AliasProposalBatch {
  batch: Proposal[];
  skippedExistingAlias: number;
  skippedExistingProposal: number;
  candidates: number;
}

function stripPunct(s: string): string {
  return s.replace(/[^a-z0-9]/gi, "");
}

function tokenize(s: string): string[] {
  return s.split(/\s+/).filter(Boolean);
}

function endsWithTokens(long: string[], tail: string[]): boolean {
  if (tail.length === 0 || tail.length >= long.length) return false;
  const offset = long.length - tail.length;
  for (let i = 0; i < tail.length; i++) {
    if (long[offset + i] !== tail[i]) return false;
  }
  return true;
}

function stripCorpSuffix(t: string[]): string[] {
  if (t.length > 1 && CORP_SUFFIXES.has(t[t.length - 1])) return t.slice(0, -1);
  return t;
}

function evaluatePair(a: EntityCandidate, b: EntityCandidate): Proposal | null {
  const defaultWinner = a.mention_count >= b.mention_count ? a : b;
  const defaultLoser = defaultWinner === a ? b : a;

  if (
    stripPunct(a.name_norm) === stripPunct(b.name_norm) &&
    a.name_norm !== b.name_norm
  ) {
    return {
      entity_id: defaultWinner.id,
      alias_norm: defaultLoser.name_norm,
      reason: "punctuation variant",
    };
  }

  if (a.name_norm + "s" === b.name_norm || b.name_norm + "s" === a.name_norm) {
    return {
      entity_id: defaultWinner.id,
      alias_norm: defaultLoser.name_norm,
      reason: "plural variant",
    };
  }

  if (a.kind !== "name") return null;

  const aTokens = tokenize(a.name_norm);
  const bTokens = tokenize(b.name_norm);
  const aStripped = stripCorpSuffix(aTokens).join(" ");
  const bStripped = stripCorpSuffix(bTokens).join(" ");

  if (
    aStripped &&
    bStripped &&
    aStripped === bStripped &&
    a.name_norm !== b.name_norm
  ) {
    return {
      entity_id: defaultWinner.id,
      alias_norm: defaultLoser.name_norm,
      reason: "corporate suffix",
    };
  }

  const shortIsA = aTokens.length < bTokens.length;
  const shortEnt = shortIsA ? a : b;
  const longEnt = shortIsA ? b : a;
  const shortTokens = shortIsA ? aTokens : bTokens;
  const longTokens = shortIsA ? bTokens : aTokens;

  if (
    shortTokens.length >= 1 &&
    shortTokens.length <= 2 &&
    endsWithTokens(longTokens, shortTokens)
  ) {
    return {
      entity_id: longEnt.id,
      alias_norm: shortEnt.name_norm,
      reason: `tail token of "${longEnt.name_norm}"`,
    };
  }

  return null;
}

/**
 * Build the batch of proposals without writing. Pure w.r.t. `atlas_alias_proposals` —
 * reads existing aliases and pending proposals to deduplicate, but produces no inserts.
 * Useful for smoke tests and dry-run admin commands.
 */
export function computeAliasProposals(): AliasProposalBatch {
  const db = getDb();

  const candidates = db
    .prepare<EntityCandidate, [number]>(
      `SELECT id, kind, name_norm, mention_count
       FROM atlas_entities
       WHERE mention_count >= ?
       ORDER BY kind, mention_count DESC`,
    )
    .all(MIN_MENTIONS);

  const existingAliases = new Set<string>();
  db.prepare<{ alias_norm: string; kind: string }, []>(
    `SELECT a.alias_norm, e.kind
     FROM atlas_entity_aliases a
     JOIN atlas_entities e ON e.id = a.entity_id`,
  )
    .all()
    .forEach((r) => existingAliases.add(`${r.kind}:${r.alias_norm}`));

  const pendingProposals = new Set<string>();
  db.prepare<{ entity_id: number; alias_norm: string }, []>(
    `SELECT entity_id, alias_norm FROM atlas_alias_proposals WHERE status = 'pending'`,
  )
    .all()
    .forEach((r) => pendingProposals.add(`${r.entity_id}:${r.alias_norm}`));

  const byKind = new Map<string, EntityCandidate[]>();
  for (const c of candidates) {
    if (!byKind.has(c.kind)) byKind.set(c.kind, []);
    byKind.get(c.kind)!.push(c);
  }

  const batch: Proposal[] = [];
  let skippedExistingAlias = 0;
  let skippedExistingProposal = 0;

  outer: for (const [kind, ents] of byKind) {
    for (let i = 0; i < ents.length; i++) {
      if (batch.length >= MAX_PROPOSALS_PER_RUN) break outer;
      const a = ents[i];
      for (let j = i + 1; j < ents.length; j++) {
        if (batch.length >= MAX_PROPOSALS_PER_RUN) break outer;
        const b = ents[j];
        const result = evaluatePair(a, b);
        if (!result) continue;

        if (existingAliases.has(`${kind}:${result.alias_norm}`)) {
          skippedExistingAlias++;
          continue;
        }
        const key = `${result.entity_id}:${result.alias_norm}`;
        if (pendingProposals.has(key)) {
          skippedExistingProposal++;
          continue;
        }

        batch.push(result);
        pendingProposals.add(key);
      }
    }
  }

  return {
    batch,
    skippedExistingAlias,
    skippedExistingProposal,
    candidates: candidates.length,
  };
}

export function proposeAliases(): ProposeAliasesResult {
  const db = getDb();
  const { batch, skippedExistingAlias, skippedExistingProposal, candidates } =
    computeAliasProposals();

  const insert = db.prepare(
    `INSERT INTO atlas_alias_proposals (entity_id, alias_norm, reason) VALUES (?, ?, ?)`,
  );
  const tx = db.transaction((rows: Proposal[]) => {
    for (const p of rows) insert.run(p.entity_id, p.alias_norm, p.reason);
  });
  tx(batch);

  log.info("Alias proposals written", {
    count: batch.length,
    skippedExistingAlias,
    skippedExistingProposal,
    candidates,
  });

  return {
    proposed: batch.length,
    skippedExistingAlias,
    skippedExistingProposal,
  };
}

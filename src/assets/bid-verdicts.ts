/**
 * Bid-desk verdicts: the go/no-go memos in `cloud-nexus/bid-desk/*.md`. Each
 * memo's frontmatter carries `asset_id`, `verdict` (GO | MAYBE | NO-GO) and
 * `confidence`. The digest reads them so a NO-GO tender stops resurfacing and a
 * GO or MAYBE shows its verdict next to the deadline.
 *
 * Memos are few and small, so this re-reads the folder whenever its listing or
 * any memo's mtime changes, and otherwise serves the cached map.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { HOMES } from "./homes.ts";

export type BidVerdict = "GO" | "MAYBE" | "NO-GO";

export interface BidMemo {
  assetId: number;
  verdict: BidVerdict;
  confidence: string | null;
  path: string;
}

export const BID_DESK_DIR = () => join(HOMES.cloudNexusDir, "bid-desk");

let cache: { stamp: string; memos: Map<number, BidMemo> } | null = null;

/** Top-level `key: value` pairs of a leading `---` frontmatter block. */
export function frontmatter(text: string): Record<string, string> {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return {};
  const out: Record<string, string> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (kv) out[kv[1]!] = kv[2]!.trim().replace(/^"(.*)"$/, "$1");
  }
  return out;
}

export function parseVerdict(raw: string | undefined): BidVerdict | null {
  const v = (raw ?? "").toUpperCase().replace(/[\s_]+/g, "-");
  if (v === "GO" || v === "MAYBE" || v === "NO-GO") return v;
  if (v === "NOGO") return "NO-GO";
  return null;
}

/** asset id → memo, for every memo with a numeric `asset_id` and a known verdict. */
export function bidMemos(dir = BID_DESK_DIR()): Map<number, BidMemo> {
  if (!existsSync(dir)) return new Map();
  const files = readdirSync(dir).filter((f) => f.endsWith(".md") && f !== "README.md").sort();
  const stamp = files.map((f) => `${f}:${statSync(join(dir, f)).mtimeMs}`).join("|");
  if (cache && cache.stamp === `${dir}#${stamp}`) return cache.memos;

  const memos = new Map<number, BidMemo>();
  for (const f of files) {
    const path = join(dir, f);
    const fm = frontmatter(readFileSync(path, "utf8"));
    const assetId = Number.parseInt(fm.asset_id ?? "", 10);
    const verdict = parseVerdict(fm.verdict);
    if (!Number.isFinite(assetId) || !verdict) continue;
    memos.set(assetId, { assetId, verdict, confidence: fm.confidence ?? null, path });
  }
  cache = { stamp: `${dir}#${stamp}`, memos };
  return memos;
}

export function bidVerdictOf(assetId: number): BidMemo | null {
  return bidMemos().get(assetId) ?? null;
}

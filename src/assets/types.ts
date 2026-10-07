/**
 * Asset registry types. An asset is a concrete, reusable thing David can act on
 * this week (a dataset, tool, technique, bid…), pulled out of any source and
 * scored against knowledge/GOALS.md. Summaries of content are not assets.
 */

export const ASSET_KINDS = ["dataset", "tool", "skill", "technique", "design_ref", "prompt", "opportunity"] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];

export const ASSET_STATUSES = ["new", "queued", "in_use", "done", "dismissed"] as const;
export type AssetStatus = (typeof ASSET_STATUSES)[number];

export type Effort = "S" | "M" | "L";

/**
 * Kind-specific fields, stored as details_json. All optional: the extractor
 * fills what the source states and never guesses.
 */
export interface AssetDetails {
  // dataset
  host?: string;            // "huggingface", "kaggle", "github", …
  repo_id?: string;         // e.g. "owner/name" on Hugging Face
  license?: string;
  size?: string;            // "12 GB", "1.2M rows"
  contents?: string;        // what the rows/files are
  // tool / skill
  install?: string;         // exact command, e.g. "npx skills add owner/repo"
  pricing?: string;
  repo?: string;            // github owner/name
  // technique / prompt
  steps?: string[];         // concrete steps, in order
  timestamp?: string;       // "12:34" in the source video
  target_skill?: string;    // existing skill it should improve, e.g. "drone-video-editing"
  // opportunity
  opportunity_type?: "tender" | "rfp" | "grant" | "program" | "lead";
  org?: string;             // issuing organisation
  eligibility?: string;
  reference?: string;       // solicitation number
  categories?: string[];    // GSIN/UNSPSC codes or program categories
  region?: string;
  [k: string]: unknown;
}

/** What an extractor or feed hands to the store. */
export interface AssetInput {
  kind: AssetKind;
  title: string;
  url?: string | null;
  summary: string;              // one or two sentences: what it IS
  track: string;                // primary track id from GOALS.md
  tracks?: string[];            // all matching track ids
  value_score: number;          // 0–100, value to David's goals this week
  value_reason: string;         // one sentence: why that score
  next_action: string;          // one imperative sentence David (or an agent) can do
  effort?: Effort | null;
  details?: AssetDetails;
  deadline?: string | null;     // ISO date (opportunities)
  amount?: string | null;       // "$25,000", "up to $50K"
  published_at?: string | null;
  extractor?: string;           // "extract:v1:glm-5.3", "feed:canadabuys", …
}

/** Where the asset was seen. */
export interface AssetSourceInput {
  source_kind: string;          // youtube | tab | github | inbox | research | hf | canadabuys | …
  source_ref: string;           // stable id within that source (video id, tab id, url…)
  source_url?: string | null;
  source_title?: string | null;
  evidence?: string | null;     // short quote or timestamp supporting the asset
}

export interface AssetRow {
  id: number;
  key: string;
  kind: AssetKind;
  title: string;
  url: string | null;
  summary: string;
  track: string;
  tracks_json: string;
  value_score: number;
  value_reason: string;
  next_action: string;
  effort: Effort | null;
  details_json: string;
  deadline: string | null;
  amount: string | null;
  status: AssetStatus;
  outcome: string | null;
  home_path: string | null;
  published_at: string | null;
  first_seen_at: string;
  updated_at: string;
  acted_at: string | null;
  surfaced_at: string | null;
  extractor: string | null;
}

export interface AssetSourceRow {
  id: number;
  asset_id: number;
  source_kind: string;
  source_ref: string;
  source_url: string | null;
  source_title: string | null;
  evidence: string | null;
  seen_at: string;
}

export type ExtractionStatus = "done" | "empty" | "gated" | "failed";

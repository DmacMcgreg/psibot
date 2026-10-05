/**
 * Pure decision layer for the Discover triage: Jev probabilities →
 * hide / pick / unsure, plus David's mainstream-news rule (2026-09-26)
 * that overrides the channel prior. No DB, no Jev client.
 */

// ─── thresholds (pure) ──────────────────────────────────────────────────────

export type Decision = "hide" | "pick" | "unsure";

export interface Thresholds {
  /** Minimum P(not interested) to hide. */
  hide: number;
  /** Minimum P(interested) to pick. */
  pick: number;
  /** P(protected interest) at or above which an item is never hidden. */
  guard: number;
  /**
   * Minimum P(not interested) to hide an item David saved himself (Watch
   * Later, GitHub star, Reddit save). All of his ratings so far are on
   * discovery-found videos, so the rubric is extrapolated for these.
   */
  hideSaved: number;
  /**
   * Minimum P(interested) to pick an item from a channel David has chosen
   * videos from. The lean toward pick mostly rides in the Jev state
   * (`david_chose_videos_from_this_channel`); calibration on 2026-09-26 found
   * 0 of 3 channel-prior picks below 0.8 correct, so the default equals `pick`.
   */
  pickKnownChannel: number;
  /** Minimum P(interested) to pick a mainstream news item that passes David's news rule. */
  pickNews: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = { hide: 0.85, pick: 0.8, guard: 0.5, hideSaved: 0.95, pickKnownChannel: 0.8, pickNews: 0.6 };

// ─── mainstream news (David's news rule, 2026-09-26) ────────────────────────

/**
 * Mainstream news outlets. Their channel says little about a clip, so they get
 * no channel prior; a topic rule decides instead (NEWS_RULE).
 */
export const NEWS_CHANNEL_RE =
  /^(ctv\b.*|cbc\b.*|global news.*|citynews.*|cp24|ottawa citizen|cpac|dw news|newsnation|ms now|msnbc|bloomberg (television|podcasts|tech|originals|quicktake)|reuters|associated press|pbs newshour|nbc news|cbs news|abc news.*|fox news.*|fox business|cnbc.*|cnn.*|sky news.*|al jazeera.*|bbc news.*|times now|news24|wion|c-span|arizona’s family.*|v6 news.*|the globe and mail|toronto star)$/i;

export const isNewsChannel = (by: string | null | undefined): boolean => !!by && NEWS_CHANNEL_RE.test(by.trim());

/** David's own words, given to Jev with every mainstream-news item. */
export const NEWS_RULE =
  "David lives in Ottawa. From mainstream news channels he wants: Ottawa hyper-local news, Ontario news, and Canadian " +
  "politics or policy of general importance (plus major world geopolitics as short highlights). He does not want generic " +
  "local filler from elsewhere: crime, crashes, weather, fires, sports and human-interest stories from other cities or " +
  "provinces, or full-length market shows.";

export const NEWS_QUESTION =
  "Is this news item Ottawa-local news, Ontario news, or Canadian politics or policy of general importance — the kind David's news rule says to keep?";

export interface DecideContext {
  /** Watch Later, GitHub star or Reddit save: David saved it himself. */
  savedByDavid?: boolean;
  /** Its channel appears among David's chosen videos (never true for a mainstream news channel). */
  knownChannel?: boolean;
  /**
   * Mainstream news item only: P(it is Ottawa-local, Ontario or Canadian
   * politics/policy of general importance) — David's news rule. At or above
   * `guard` it is never hidden and leans pick.
   */
  pCanadianNews?: number;
}

export interface Probs {
  pNot: number;
  pInterest: number;
  pProtected: number;
}

/**
 * Map Jev's probabilities to a decision. Hide wins only when it clears its
 * threshold AND the protected-interest guard is below its bar; the two
 * thresholds are both > 0.5 in practice, so hide and pick cannot both fire,
 * but if a caller sets them low enough to overlap the item stays unsure.
 */
export function decide(p: Probs, t: Thresholds = DEFAULT_THRESHOLDS, ctx: DecideContext = {}): Decision {
  const hideBar = ctx.savedByDavid ? Math.max(t.hide, t.hideSaved) : t.hide;
  // Channel prior: a channel David chose videos from is never hidden, and leans pick.
  const relevantNews = (ctx.pCanadianNews ?? 0) >= t.guard;
  const wantsHide = !ctx.knownChannel && !relevantNews && p.pNot >= hideBar && p.pProtected < t.guard;
  const pickBar = relevantNews ? Math.min(t.pick, t.pickNews) : ctx.knownChannel ? Math.min(t.pick, t.pickKnownChannel) : t.pick;
  const wantsPick = p.pInterest >= pickBar;
  if (wantsHide && wantsPick) return "unsure";
  if (wantsHide) return "hide";
  if (wantsPick) return "pick";
  return "unsure";
}

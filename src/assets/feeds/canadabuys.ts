/**
 * CanadaBuys tenders → `opportunity` assets (opportunity_type "tender").
 *
 * Source: the open-data CSVs (no API exists). The "open" file is the full
 * refresh; the "new" file catches today's notices early. Rows are filtered by
 * UNSPSC code (IT, web, marketing, advertising, video, training, AI), with a
 * legacy-GSIN fallback and a narrow title fallback, then by hard disqualifiers
 * (non-open tenderStatus, closed, construction-only, advance award notices,
 * supply-arrangement call-ups David is not qualified for). Survivors are
 * fit-scored by the model.
 *
 * Lifecycle: each run also reconciles the "open" file against previously
 * surfaced canadabuys opportunities still `new`/`queued`/`in_use` — one whose
 * notice has left the file (closed, cancelled, or awarded early) is marked
 * `done` with outcome `closed_or_cancelled`, guarded so a partial download
 * (the open file usually has ~900 rows) can't close everything at once.
 */

import type { Candidate, FeedSpec, FeedStats, Judgment } from "./common.ts";
import { clip, fetchWithTimeout, isoDate, parseCsv, pickEffort, pickTrack, runFeed, shortHash, textOr, toIsoDate } from "./common.ts";
import { getDb } from "../../db/index.ts";
import { closeStaleOpportunity } from "../actions.ts";

export const FEED = "canadabuys";
const BASE = "https://canadabuys.canada.ca/opendata/pub/";
export const FILES = {
  open: BASE + "openTenderNotice-ouvertAvisAppelOffres.csv",
  new: BASE + "newTenderNotice-nouvelAvisAppelOffres.csv",
};

// UNSPSC codes observed in real 2026-27 notices (see revamp-sources.md).
export const UNSPSC_EXACT = new Set([
  // IT / web / AI
  "80101507", "80101508", "81112100", "81112103", "81112106", "81162302", "81162303", "43232200",
  // marketing / comms / advertising
  "80141500", "80141600", "80141607", "80171602", "80172000",
  "82101600", "82101800", "82111500", "82111800", "82121505",
  // video / photo / drone / design
  "82131600", "82131601", "82131603", "82141502", "82141505",
  // training / e-learning
  "86101601", "86132000", "86132100", "86132201", "86132204", "81162308", "43232502", "43232505",
]);
export const UNSPSC_PREFIX = ["811115", "811116", "811117", "811121", "811620", "801715", "801718", "801716"];
export const GSIN_PREFIX = ["D302", "D307", "D308", "D317E", "T000C", "T001", "T002", "T003", "T004K", "T005", "T009", "T012", "T014N", "U008", "U009", "U099A"];

/** Titles that clearly fit even when the coding is odd. Used only as a fallback. */
const TITLE_FIT = /\b(web ?site|web (design|development|content)|wordpress|drupal|social media|digital (marketing|strategy|campaign)|advertis\w*|marketing|public awareness|communications? (campaign|strategy|plan)|video(graph\w*| production)?|photograph\w*|drone|aerial imag\w*|e-?learning|curriculum|instructional design|artificial intelligence|\bAI\b|machine learning|chatbot|generative|user experience|\bUX\b|accessibility|WCAG)\b/i;
/** Titles that are never David's work, whatever the code says. */
const TITLE_EXCLUDE = /\b(construction|roof\w*|sewer|paving|hvac|firefight\w*|military training|forklift|vehicle|furniture|apparel|janitorial|snow removal|dredg\w*|asbestos|demolition|firearm|ammunition|aircraft|vessel|pharmac\w*|laboratory equipment)\b/i;
/** Call-ups against methods of supply David is not qualified on. */
const SA_CALLUP = /\b(TBIPS|SBIPS|TSPS|ProServices|PSPC Professional Services|Solutions-Based Informatics|Task-Based (Informatics|Professional))\b/i;

export type TenderRow = Record<string, string>;

const col = {
  title: "title-titre-eng",
  ref: "referenceNumber-numeroReference",
  amendment: "amendmentNumber-numeroModification",
  solicitation: "solicitationNumber-numeroSollicitation",
  published: "publicationDate-datePublication",
  closing: "tenderClosingDate-appelOffresDateCloture",
  status: "tenderStatus-appelOffresStatut-eng",
  gsin: "gsin-nibs",
  unspsc: "unspsc",
  unspscDesc: "unspscDescription-eng",
  category: "procurementCategory-categorieApprovisionnement",
  noticeType: "noticeType-avisType-eng",
  method: "procurementMethod-methodeApprovisionnement-eng",
  selection: "selectionCriteria-criteresSelection-eng",
  regionsDelivery: "regionsOfDelivery-regionsLivraison-eng",
  regionsOpp: "regionsOfOpportunity-regionAppelOffres-eng",
  org: "contractingEntityName-nomEntitContractante-eng",
  endUser: "endUserEntitiesName-nomEntitesUtilisateurFinal-eng",
  email: "contactInfoEmail-informationsContactCourriel",
  noticeUrl: "noticeURL-URLavis-eng",
  description: "tenderDescription-descriptionAppelOffres-eng",
  expStart: "expectedContractStartDate-dateDebutContratPrevue",
  expEnd: "expectedContractEndDate-dateFinContratPrevue",
} as const;

/** Split a multi-value cell ("*a\n*b") into clean values. */
export function multi(cell: string | undefined): string[] {
  return (cell ?? "").split(/\n/).map((v) => v.replace(/^\s*\*\s*/, "").trim()).filter(Boolean);
}

export function unspscCodes(r: TenderRow): string[] {
  return (r[col.unspsc] ?? "").match(/\d{8}/g) ?? [];
}

export function codeMatch(r: TenderRow): boolean {
  if (unspscCodes(r).some((c) => UNSPSC_EXACT.has(c) || UNSPSC_PREFIX.some((p) => c.startsWith(p)))) return true;
  return multi(r[col.gsin]).some((g) => GSIN_PREFIX.some((p) => g.startsWith(p)));
}

/** The public CanadaBuys notice page, always reachable (noticeURL is empty on about half the rows). */
export function canadaBuysUrl(ref: string): string {
  return `https://canadabuys.canada.ca/en/tender-opportunities/tender-notice/${ref.toLowerCase().replace(/[^a-z0-9-]/g, "")}`;
}

export type RuleVerdict = { pass: true; prior: number } | { pass: false; why: string };

/** Rules-first filter. `today` is YYYY-MM-DD. */
export function tenderRule(r: TenderRow, today: string): RuleVerdict {
  const title = r[col.title] ?? "";
  const closing = (r[col.closing] ?? "").slice(0, 10);
  if (!r[col.ref]) return { pass: false, why: "no reference" };
  // A blank status is common on older rows and isn't itself disqualifying; only an explicit non-open value is.
  const status = (r[col.status] ?? "").trim().toLowerCase();
  if (status && status !== "open") return { pass: false, why: `not open (${status})` };
  if (!closing || closing < today) return { pass: false, why: "closed" };
  // Less than 3 days left is not enough time to write a bid.
  if ((Date.parse(closing) - Date.parse(today)) / 86_400_000 < 3) return { pass: false, why: "closing too soon" };
  if (/advance contract award|directed contract/i.test(`${r[col.noticeType]} ${r[col.method]}`)) return { pass: false, why: "pre-awarded" };
  if (/non-competitive/i.test(r[col.method] ?? "")) return { pass: false, why: "non-competitive" };
  const cats = multi(r[col.category]);
  if (cats.length && cats.every((c) => /CNST/.test(c))) return { pass: false, why: "construction" };
  if (TITLE_EXCLUDE.test(title)) return { pass: false, why: "excluded title" };
  if (/RFP against Supply Arrangement/i.test(r[col.noticeType] ?? "") || (SA_CALLUP.test(title) && !/Request for Supply Arrangement/i.test(r[col.noticeType] ?? ""))) {
    return { pass: false, why: "supply-arrangement call-up" };
  }
  const coded = codeMatch(r);
  const titled = TITLE_FIT.test(title);
  if (!coded && !titled) return { pass: false, why: "no matching code" };
  let prior = (coded ? 2 : 0) + (titled ? 1 : 0);
  if (/Request for Proposal|Request for Quotation|Invitation to Tender/i.test(r[col.noticeType] ?? "")) prior += 1;
  return { pass: true, prior };
}

export function tenderBrief(r: TenderRow): Record<string, unknown> {
  const codes = multi(r[col.unspscDesc]).slice(0, 4);
  return {
    title: clip(r[col.title], 160),
    org: clip(r[col.org], 90),
    end_user: clip(r[col.endUser], 90) || undefined,
    notice_type: r[col.noticeType] || undefined,
    method: r[col.method] || undefined,
    closes: (r[col.closing] ?? "").slice(0, 10),
    codes: codes.length ? codes : multi(r[col.gsin]).slice(0, 3),
    delivery: clip(multi(r[col.regionsDelivery]).join(", "), 80) || undefined,
    selection: clip(r[col.selection], 60) || undefined,
    description: clip(r[col.description], 900),
  };
}

const INSTRUCTIONS = `Items are Canadian federal tender notices (CanadaBuys). David's shop is 1–3 people (Cloud Nexus Solutions, Ottawa): AI, web, marketing, video/drone, training.
Reward: work his shop can realistically win and deliver (websites, digital/social campaigns, creative/video/photo/drone production, e-learning and training design, communications, AI/automation pilots, UX/accessibility), small-to-mid value, open competition.
Score below 20 (disqualifiers): needs Secret/Top Secret or higher security clearance (Reliability status alone is fine), bonding or large insurance, large-firm experience minimums (e.g. 50+ staff, many similar $1M+ contracts), construction or goods supply, on-site work far from Ottawa for months, pure IT infrastructure/licences/hardware, staffing-augmentation resource contracts, French-only delivery he cannot staff.
Requests for Information: at most 45 unless they are clearly a precursor to a contract he fits. Supply-arrangement refresh notices (qualifying onto a method of supply): score on whether qualifying is realistic for a tiny firm.
Extra fields to return for kept items: "amount" (only if the notice states a value or budget, e.g. "$120,000"; else null), "eligibility" (one sentence: key mandatory requirements or disqualifier risk), "track" is usually "bids" unless another fits better; list every matching track in "tracks".`;

export interface CanadaBuysDeps {
  fetchCsv?: (url: string) => Promise<string>;
  today?: string;
}

// No conditional GET: deferred candidates must be re-seen on the next run even
// when the file has not changed, and 6.6 MB four times a day is cheap.
const defaultFetchCsv = async (url: string) => {
  const res = await fetchWithTimeout(url, { timeoutMs: 90_000 });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
};

/** PSPC/DND file numbers that tie sibling notices together, e.g. "EP361-261511", "W8476-145075". */
const FILE_NO = /\b([A-Z]{1,2}\d{3,4}-\d{2}[A-Z0-9]{2,6}(?:\/[A-Z0-9]+)?)\b/;
const NOTICE_WORDS = /\b(rfsa|rfso|rfp|rfq|rfi|itq|reissuance|amendment|request for (supply arrangement|standing offer|proposals?|information|quotations?)|invitation to qualify)\b/gi;

export interface TenderGroup {
  /** Stable id for the group: the file number, else the solicitation number, else the reference number. */
  groupRef: string;
  lead: TenderRow;
  rows: TenderRow[];
}

function titleKey(r: TenderRow): string {
  const t = (r[col.title] ?? "").replace(/\([^)]*\)/g, " ").replace(NOTICE_WORDS, " ").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return t ? `t:${t}|${(r[col.closing] ?? "").slice(0, 10)}` : "";
}

/**
 * One group per solicitation. Sibling notices (an RFSA and an RFSO for the same
 * file number, re-posts, per-region copies) share a file number in the title,
 * a solicitation number, or a normalised title plus closing date.
 */
export function groupTenders(rows: TenderRow[]): TenderGroup[] {
  const parent = new Map<string, string>();
  const find = (k: string): string => { let p = parent.get(k) ?? k; if (p !== k) { p = find(p); parent.set(k, p); } return p; };
  const union = (a: string, b: string) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(rb, ra); };
  const keysOf = (r: TenderRow) => {
    const f = (r[col.title] ?? "").match(FILE_NO)?.[1];
    const sol = (r[col.solicitation] ?? "").trim().toUpperCase();
    return [`r:${r[col.ref]}`, f ? `f:${f}` : "", sol ? `s:${sol}` : "", titleKey(r)].filter(Boolean);
  };
  for (const r of rows) { const ks = keysOf(r); for (const k of ks) union(ks[0], k); }
  const groups = new Map<string, TenderRow[]>();
  for (const r of rows) {
    const root = find(`r:${r[col.ref]}`);
    groups.set(root, [...(groups.get(root) ?? []), r]);
  }
  return [...groups.values()].map((rs) => {
    rs.sort((a, b) => (a[col.published] ?? "").localeCompare(b[col.published] ?? "") || a[col.ref].localeCompare(b[col.ref]));
    const lead = rs[0];
    const file = rs.map((r) => (r[col.title] ?? "").match(FILE_NO)?.[1]).find(Boolean);
    const groupRef = file ?? ((lead[col.solicitation] ?? "").trim() || lead[col.ref]);
    return { groupRef, lead, rows: rs };
  });
}

/** URL of an existing asset for any notice in the group, so re-runs and siblings merge into it. */
function existingUrl(g: TenderGroup): string | null {
  const refs = [...new Set([g.groupRef, ...g.rows.flatMap((r) => [r[col.ref], r[col.solicitation]]).filter(Boolean)])];
  if (!refs.length) return null;
  const ph = refs.map(() => "?").join(",");
  try {
    const row = getDb().prepare<{ url: string }, string[]>(
      `SELECT url FROM assets WHERE kind = 'opportunity' AND extractor LIKE 'feed:canadabuys%' AND url IS NOT NULL AND (
         json_extract(details_json, '$.reference') IN (${ph})
         OR json_extract(details_json, '$.canadabuys_ref') IN (${ph})
         OR EXISTS (SELECT 1 FROM json_each(details_json, '$.canadabuys_refs') WHERE value IN (${ph})))
       ORDER BY value_score DESC LIMIT 1`,
    ).get(...refs, ...refs, ...refs);
    return row?.url ?? null;
  } catch {
    return null;
  }
}

/** Below this, a partial or broken download can't be trusted to say what's still open. */
const MIN_OPEN_ROWS_TO_TRUST = 200;

/**
 * Mark previously-surfaced CanadaBuys opportunities "done" (outcome
 * `closed_or_cancelled`) once their notice no longer appears in the "open"
 * file: closed, cancelled, or awarded early. Guarded on a sane row count so a
 * broken or partial download can never read as "everything closed".
 */
function closeStaleOpportunities(openRefs: Set<string>, stats: FeedStats): void {
  if (openRefs.size <= MIN_OPEN_ROWS_TO_TRUST) return;
  try {
    const rows = getDb().prepare<{ id: number; details_json: string }, []>(
      `SELECT id, details_json FROM assets WHERE kind = 'opportunity' AND extractor LIKE 'feed:canadabuys%' AND status IN ('new','queued','in_use')`,
    ).all();
    let closed = 0;
    for (const row of rows) {
      let refs: string[] = [];
      try {
        const d = JSON.parse(row.details_json || "{}") as { canadabuys_ref?: string; canadabuys_refs?: string[] };
        refs = d.canadabuys_refs?.length ? d.canadabuys_refs : d.canadabuys_ref ? [d.canadabuys_ref] : [];
      } catch {
        continue; // malformed details_json: leave this row alone
      }
      if (refs.length && !refs.some((r) => openRefs.has(r))) {
        closeStaleOpportunity(row.id, "canadabuys: notice no longer in the open file (closed, cancelled, or awarded early)");
        closed++;
      }
    }
    if (closed) stats.notes.push(`closed ${closed} stale canadabuys ${closed === 1 ? "opportunity" : "opportunities"} (notice left the open file)`);
  } catch (e) {
    stats.notes.push(`stale-opportunity sweep failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export function canadaBuysSpec(deps: CanadaBuysDeps = {}): FeedSpec<TenderGroup> {
  const fetchCsv = deps.fetchCsv ?? defaultFetchCsv;
  return {
    name: FEED,
    sourceKind: "canadabuys",
    instructions: INSTRUCTIONS,
    maxScore: 90,
    async collect(stats: FeedStats): Promise<Candidate<TenderGroup>[]> {
      const today = deps.today ?? isoDate(new Date());
      const rows = new Map<string, TenderRow>();
      let openRefs: Set<string> | null = null;
      for (const [name, url] of Object.entries(FILES)) {
        try {
          const parsed = parseCsv(await fetchCsv(url));
          if (name === "open") openRefs = new Set(parsed.map((r) => r[col.ref]).filter(Boolean));
          for (const r of parsed) if (r[col.ref]) rows.set(r[col.ref], r);
        } catch (e) {
          stats.errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      stats.seen = rows.size;
      // Independent of scoring this run's candidates: reconcile what the feed no longer sees as open.
      if (openRefs) closeStaleOpportunities(openRefs, stats);
      const why: Record<string, number> = {};
      const passing: TenderRow[] = [];
      const prior = new Map<string, number>();
      for (const r of rows.values()) {
        const v = tenderRule(r, today);
        if (!v.pass) { why[v.why] = (why[v.why] ?? 0) + 1; continue; }
        passing.push(r);
        prior.set(r[col.ref], v.prior);
      }
      const groups = groupTenders(passing);
      if (groups.length < passing.length) why["sibling notice merged"] = passing.length - groups.length;
      stats.notes.push(`rule drops: ${JSON.stringify(why)}`);
      return groups.map((g) => {
        const brief = tenderBrief(g.lead);
        if (g.rows.length > 1) brief.sibling_notices = g.rows.slice(1).map((r) => `${r[col.noticeType] || "notice"}: ${clip(r[col.title], 90)}`);
        return {
          ref: `cb:${g.groupRef}`,
          version: shortHash(g.rows.map((r) => `${r[col.ref]}#${r[col.amendment] || "0"}`).sort().join(",")),
          prior: Math.max(...g.rows.map((r) => prior.get(r[col.ref]) ?? 0)),
          brief,
          raw: g,
        };
      });
    },
    toAsset(c: Candidate<TenderGroup>, j: Judgment) {
      const g = c.raw;
      const r = g.lead;
      const { track, tracks } = pickTrack(j, "bids");
      const cbUrl = existingUrl(g) ?? canadaBuysUrl(r[col.ref]);
      const noticeUrl = (r[col.noticeUrl] ?? "").trim() || null;
      const codes = unspscCodes(r);
      const descs = multi(r[col.unspscDesc]);
      const closing = g.rows.map((x) => (x[col.closing] ?? "").slice(0, 10)).filter(Boolean).sort()[0] ?? null;
      return {
        asset: {
          kind: "opportunity",
          title: textOr(r[col.title], j.title ?? "CanadaBuys tender"),
          url: cbUrl,
          summary: textOr(j.summary, clip(r[col.description], 240)),
          track,
          tracks: [...new Set([...tracks, "bids"])],
          value_score: j.score,
          value_reason: textOr(j.reason, "Fits the bids track."),
          next_action: textOr(j.next_action, "Read the solicitation documents and decide bid or no-bid."),
          effort: pickEffort(j.effort) ?? "M",
          deadline: closing,
          amount: j.amount || null,
          published_at: toIsoDate(r[col.published]),
          extractor: "feed:canadabuys:v1",
          details: {
            opportunity_type: "tender",
            org: r[col.org] || undefined,
            reference: g.groupRef,
            solicitation: r[col.solicitation] || undefined,
            categories: codes.map((code, i) => (descs[i] ? `${code} ${descs[i]}` : code)).concat(codes.length ? [] : multi(r[col.gsin])),
            region: multi(r[col.regionsDelivery]).join(", ") || undefined,
            notice_type: g.rows.map((x) => x[col.noticeType]).filter(Boolean).join(" + ") || undefined,
            procurement_method: r[col.method] || undefined,
            eligibility: j.eligibility || undefined,
            bid_portal_url: noticeUrl ?? undefined,
            contact_email: r[col.email] || undefined,
            canadabuys_ref: r[col.ref],
            canadabuys_refs: g.rows.map((x) => x[col.ref]),
            notices: g.rows.length > 1 ? g.rows.map((x) => ({ title: x[col.title], type: x[col.noticeType], url: canadaBuysUrl(x[col.ref]) })) : undefined,
          },
        },
        source: { source_kind: "canadabuys", source_ref: c.ref, source_url: noticeUrl ?? cbUrl, source_title: r[col.title] },
      };
    },
  };
}

export const runCanadaBuys = (deps?: CanadaBuysDeps) => runFeed(canadaBuysSpec(deps));

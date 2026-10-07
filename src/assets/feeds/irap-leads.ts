/**
 * NRC grant agreements (IRAP, CanExport) for Ottawa-area firms → `opportunity`
 * assets with opportunity_type "lead".
 *
 * Source: the federal Grants and Contributions proactive-disclosure datastore,
 * filtered to NRC agreements in Ontario and matched to Ottawa-area cities
 * locally. A firm that just got R&D or export money is a warm prospect for
 * Cloud Nexus web, AI and video work. Disclosure lags about a quarter, so
 * "recent" means within 90 days of the newest disclosed agreement start date,
 * not of today. One asset per company.
 *
 * next_action names a concrete pitch (an actual Cloud Nexus offer, the
 * funding program and amount), and a company's own disclosure text is
 * checked for a stated website (see extractWebsite) — the datastore has no
 * dedicated field for one, so most leads still just say "find the website".
 * Never scraped, never guessed from the company name: company-level public
 * disclosure data only.
 */

import type { Candidate, FeedSpec, FeedStats, Judgment } from "./common.ts";
import { clip, fetchJson, pickEffort, pickTrack, runFeed, shortHash, textOr } from "./common.ts";

export const FEED = "irap-leads";
const RESOURCE = "1d15a62f-5656-49ad-8c88-f40ce689d831";
export const OTTAWA_AREA = /\b(ottawa|kanata|nepean|orl[eé]ans|gloucester|stittsville|barrhaven|carp|manotick|vanier|cumberland|greely|richmond|dunrobin)\b/i;
const WINDOW_DAYS = 90;

export interface GrantRecord {
  ref_number: string;
  recipient_legal_name: string | null;
  recipient_operating_name: string | null;
  recipient_business_number: string | null;
  recipient_type: string | null;
  recipient_city: string | null;
  recipient_postal_code: string | null;
  prog_name_en: string | null;
  agreement_title_en: string | null;
  agreement_value: string | null;
  agreement_start_date: string | null;
  description_en: string | null;
  additional_information_en: string | null;
  naics_identifier: string | null;
}

/**
 * A URL the company stated itself in its own public-disclosure text — never
 * guessed from its name, never fetched from anywhere else. The datastore has
 * no dedicated website field, so this finds one only on the rare record whose
 * description or additional-information text happens to include a link.
 */
export function extractWebsite(r: Pick<GrantRecord, "description_en" | "additional_information_en">): string | null {
  const text = `${r.description_en ?? ""} ${r.additional_information_en ?? ""}`;
  const m = text.match(/\bhttps?:\/\/[^\s)>\]"']+/i) ?? text.match(/\bwww\.[a-z0-9-]+(?:\.[a-z0-9-]+)+\b(?:\/[^\s)>\]"']*)?/i);
  if (!m) return null;
  const cleaned = m[0].replace(/[.,;:)]+$/, "");
  try {
    return new URL(/^https?:\/\//i.test(cleaned) ? cleaned : `https://${cleaned}`).toString();
  } catch {
    return null;
  }
}

export interface Company {
  key: string;
  name: string;
  operating_name: string | null;
  city: string;
  programs: string[];
  total_value: number;
  latest_start: string;
  naics: string | null;
  /** From `extractWebsite`, when one of the company's disclosure records happened to state one. */
  website: string | null;
  projects: { title: string; description: string; value: number; start: string }[];
  refs: string[];
}

export function grantsUrl(limit = 1000): string {
  const q = new URLSearchParams({
    resource_id: RESOURCE,
    limit: String(limit),
    sort: "agreement_start_date desc",
    filters: JSON.stringify({ recipient_province: "ON", owner_org: "nrc-cnrc" }),
    fields: "ref_number,recipient_legal_name,recipient_operating_name,recipient_business_number,recipient_type,recipient_city,recipient_postal_code,prog_name_en,agreement_title_en,agreement_value,agreement_start_date,description_en,additional_information_en,naics_identifier",
  });
  return `https://open.canada.ca/data/api/action/datastore_search?${q}`;
}

export function normName(s: string): string {
  return s.toLowerCase().replace(/[.,]/g, " ").replace(/\b(inc|incorporated|corp|corporation|ltd|limited|ltee|ltée|co|company|canada)\b/g, " ").replace(/\s+/g, " ").trim();
}

/** Ottawa-area for-profit recipients within WINDOW_DAYS of the newest start date, grouped per company. */
export function groupCompanies(records: GrantRecord[]): { companies: Company[]; windowStart: string | null; ottawa: number } {
  const local = records.filter((r) => OTTAWA_AREA.test(r.recipient_city ?? "") && r.recipient_legal_name && r.agreement_start_date);
  // Only for-profit firms ("F") are prospects; skip universities, non-profits, individuals.
  const firms = local.filter((r) => !r.recipient_type || r.recipient_type === "F");
  const newest = firms.map((r) => r.agreement_start_date!).sort().at(-1) ?? null;
  if (!newest) return { companies: [], windowStart: null, ottawa: local.length };
  const windowStart = new Date(Date.parse(newest) - WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10);
  const byKey = new Map<string, Company>();
  for (const r of firms) {
    if (r.agreement_start_date! < windowStart) continue;
    const key = r.recipient_business_number?.trim() || normName(r.recipient_legal_name!);
    const value = Number(r.agreement_value) || 0;
    let c = byKey.get(key);
    if (!c) {
      c = {
        key, name: r.recipient_legal_name!.trim(), operating_name: r.recipient_operating_name?.trim() || null,
        city: (r.recipient_city ?? "").split("|")[0], programs: [], total_value: 0, latest_start: r.agreement_start_date!,
        naics: r.naics_identifier, website: null, projects: [], refs: [],
      };
      byKey.set(key, c);
    }
    const prog = (r.prog_name_en ?? "").replace(/\s+–.*$/, "").trim();
    if (prog && !c.programs.includes(prog)) c.programs.push(prog);
    c.total_value += value;
    if (r.agreement_start_date! > c.latest_start) c.latest_start = r.agreement_start_date!;
    if (!c.website) c.website = extractWebsite(r);
    c.projects.push({ title: r.agreement_title_en ?? "", description: r.description_en ?? "", value, start: r.agreement_start_date! });
    c.refs.push(r.ref_number);
  }
  return { companies: [...byKey.values()], windowStart, ottawa: local.length };
}

export const money = (n: number) => `$${Math.round(n).toLocaleString("en-CA")}`;

export function companySearchUrl(c: Company): string {
  return `https://search.open.canada.ca/grants/?search_text=${encodeURIComponent(c.name)}`;
}

const INSTRUCTIONS = `Items are Ottawa-area companies that recently received NRC funding (IRAP R&D contributions, IRAP youth hires, or CanExport export-marketing money). They are sales LEADS for Cloud Nexus (David's tiny AI/web/marketing/video consultancy), not opportunities to apply for.
Score how warm and winnable each lead is for Cloud Nexus services: marketing websites, product/launch video and drone footage, AI automation, marketing and positioning work.
- Strong (60–80): funded to commercialise or export a product that clearly needs a market-facing website, demo video, launch marketing or AI workflow help; CanExport recipients (export marketing is eligible spend); software/hardware startups at go-to-market.
- Medium (40–59): plausible need, but deep-tech/biotech/lab work where marketing needs are distant, or large funding suggesting an in-house team.
- Below 40: pure research/lab/biochem with no go-to-market signal, youth-hire-only agreements with no product context, large established firms, anything with no angle for web/AI/video.
Rarely exceed 80: these are cold-ish prospects. track is usually "client-sites", "ai-services" or "marketing"; "bids" only for funding angles.
next_action must name a concrete step using the company's own numbers and one of Cloud Nexus's actual offers (the $2,260 fixed-price website package, a WCAG accessibility audit, or $85/hr automation work — see "Who I am and what I sell" above), e.g. "Find the marketing contact at Acme Robotics; pitch the $2,260 website package because they just received IRAP funding of $75,000." When "website" is given below, name it instead of guessing a contact route, e.g. "Find the marketing contact on acme.com; pitch a WCAG audit because they just received CanExport funding of $12,000." Never say "email the founder" — David rarely has a personal contact, only the company name and the public funding record.`;

export interface IrapDeps { fetchRecords?: () => Promise<GrantRecord[]> }

export function irapSpec(deps: IrapDeps = {}): FeedSpec<Company> {
  const fetchRecords = deps.fetchRecords ?? (async () => {
    const r = await fetchJson<{ success: boolean; result?: { records?: GrantRecord[] } }>(grantsUrl(), { timeoutMs: 90_000 });
    if (!r.success) throw new Error("datastore_search returned success=false");
    return r.result?.records ?? [];
  });
  return {
    name: FEED,
    sourceKind: "irap",
    instructions: INSTRUCTIONS,
    // Cold leads: only the warm half is worth David's attention.
    keepScore: 50,
    maxScore: 120,
    async collect(stats: FeedStats): Promise<Candidate<Company>[]> {
      const records = await fetchRecords();
      stats.seen = records.length;
      const { companies, windowStart, ottawa } = groupCompanies(records);
      stats.notes.push(`${ottawa} Ottawa-area agreements; window from ${windowStart ?? "?"}; ${companies.length} companies`);
      return companies.map((c) => ({
        ref: `irap:${c.key}`,
        version: shortHash(c.refs.sort().join(",")),
        prior: c.programs.some((p) => /CanExport/i.test(p)) ? 2 : 1,
        brief: {
          company: c.name,
          operating_name: c.operating_name ?? undefined,
          city: c.city,
          programs: c.programs,
          total_funding: money(c.total_value),
          latest_start: c.latest_start,
          naics: c.naics ?? undefined,
          website: c.website ?? undefined,
          projects: c.projects.slice(0, 2).map((p) => ({ title: clip(p.title, 120), what: clip(p.description, 380) })),
        },
        raw: c,
      }));
    },
    toAsset(c: Candidate<Company>, j: Judgment) {
      const co = c.raw;
      const { track, tracks } = pickTrack(j, "client-sites");
      const display = co.operating_name && normName(co.operating_name) !== normName(co.name) ? `${co.operating_name} (${co.name})` : co.name;
      const program = co.programs[0] ?? "IRAP";
      const pitch = `pitch the $2,260 website package or a WCAG audit because they just received ${program} funding of ${money(co.total_value)}`;
      const fallbackNextAction = co.website ? `Find the marketing contact on ${co.website}; ${pitch}.` : `Find ${display}'s website and marketing contact; ${pitch}.`;
      return {
        asset: {
          kind: "opportunity",
          title: `Lead: ${display}`,
          url: companySearchUrl(co),
          summary: textOr(j.summary, `${co.city} firm funded by ${co.programs.join(", ")} (${money(co.total_value)}).`),
          track,
          tracks,
          value_score: Math.min(j.score, 85),
          value_reason: textOr(j.reason, "Recently funded Ottawa-area firm."),
          next_action: textOr(j.next_action, fallbackNextAction),
          effort: pickEffort(j.effort) ?? "S",
          published_at: co.latest_start,
          extractor: "feed:irap-leads:v1",
          details: {
            opportunity_type: "lead",
            org: co.name,
            region: co.city,
            categories: co.programs,
            funding: money(co.total_value),
            naics: co.naics ?? undefined,
            website: co.website ?? undefined,
            projects: co.projects.slice(0, 3).map((p) => `${p.start} ${money(p.value)}: ${clip(p.title, 140)}`),
            reference: co.refs[0],
          },
        },
        source: { source_kind: "irap", source_ref: c.ref, source_url: companySearchUrl(co), source_title: co.name, evidence: clip(co.projects[0]?.description, 280) },
      };
    },
  };
}

export const runIrapLeads = (deps?: IrapDeps) => runFeed(irapSpec(deps));

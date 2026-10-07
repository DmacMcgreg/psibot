/**
 * Ontario "Available funding opportunities" page → `opportunity` assets
 * (opportunity_type "grant" or "program").
 *
 * The page lists every open provincial program with a `Status:` badge and a
 * `Deadline` block. The feed parses each program, diffs it against the last
 * snapshot (ops_state), and sends only new programs and status or deadline
 * changes to the scorer. Most programs target municipalities or non-profits,
 * so the scorer drops the majority; the diff itself is kept either way.
 */

import type { Candidate, FeedSpec, FeedStats, Judgment } from "./common.ts";
import { clip, decodeEntities, fetchText, getFeedMemo, pickEffort, pickTrack, runFeed, setFeedMemo, shortHash, stripHtml, textOr } from "./common.ts";
import { slug } from "../store.ts";

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

/** Every date in `text`, normalised to ISO (YYYY-MM-DD), in the order found. */
function allIsoDates(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\b(20\d\d)-(\d\d)-(\d\d)(?!\d)/g)) out.push(`${m[1]}-${m[2]}-${m[3]}`);
  for (const m of text.matchAll(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(20\d\d)\b/gi)) {
    out.push(`${m[3]}-${String(MONTHS.indexOf(m[1].toLowerCase()) + 1).padStart(2, "0")}-${m[2].padStart(2, "0")}`);
  }
  return out;
}

/**
 * ISO date for a deadline block. `toIsoDate` (feeds/common.ts) takes the
 * FIRST date it states, which drops an open program when a block lists
 * several intake dates and the earliest has already passed (e.g. "Intake 1
 * closed March 5, 2026; intake 2 closes Nov 30, 2026"). This instead picks
 * the latest date that is still in the future, falling back to the latest
 * date overall when none are, so a single-date block parses exactly as
 * `toIsoDate` would.
 */
export function latestDeadlineDate(text: string, today: Date = new Date()): string | null {
  const dates = [...new Set(allIsoDates(text))].sort();
  if (!dates.length) return null;
  const todayIso = today.toISOString().slice(0, 10);
  const future = dates.filter((d) => d >= todayIso);
  return future.length ? future[future.length - 1] : dates[dates.length - 1];
}

export const FEED = "ontario-funding";
export const PAGE_URL = "https://www.ontario.ca/page/available-funding-opportunities-ontario-government";

export interface OntarioProgram {
  title: string;
  status: string;          // "OPEN", "Open", "RESTRICTED"
  ministry: string | null;
  deadline_text: string;   // the Deadline block, verbatim
  deadline: string | null; // ISO date when the block names one
  note: string | null;
  description: string;
  eligibility: string;
  link: string | null;     // program guidelines / form link, if any
}

const SECTIONS = /^(deadline|description|eligibility|program guidelines|contacts?|how to apply|funding|intake periods?)$/i;

interface Block { level: number; title: string; html: string }

/** Split HTML into heading blocks: each h2–h4 with the markup up to the next heading. */
function headingBlocks(html: string): Block[] {
  const re = /<h([2-4])[^>]*>([\s\S]*?)<\/h\1>/gi;
  const heads = [...html.matchAll(re)];
  return heads.map((m, i) => ({
    level: Number(m[1]),
    title: stripHtml(m[2]).replace(/\s+\(\s*/g, " (").replace(/\s+\)/g, ")").trim(),
    html: html.slice(m.index! + m[0].length, i + 1 < heads.length ? heads[i + 1].index : html.length),
  }));
}

/**
 * Parse every program: a heading whose own block carries a "Status:" line.
 * Programs can be h2 (most) or h3 under a grouping h2 (the Regional
 * Development Program lists its funds that way); their Deadline, Description
 * and Eligibility sections are the following h3/h4 blocks.
 */
export function parseOntarioPage(html: string): { updated: string | null; programs: OntarioProgram[] } {
  const updated = html.match(/Updated:\s*(?:<[^>]+>\s*)*([A-Z][a-z]+ \d{1,2}, \d{4})/)?.[1] ?? null;
  const startIdx = html.indexOf("<h2>Overview");
  const body = startIdx >= 0 ? html.slice(startIdx) : html;
  const blocks = headingBlocks(body);
  const programs: OntarioProgram[] = [];
  const usedLinks = new Set<string>();
  let parentIntro = "";
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (SECTIONS.test(b.title)) continue;
    const status = b.html.match(/Status:\s*(?:<[^>]+>\s*)*([^<]+)/i)?.[1]?.trim();
    if (!status) {
      if (b.level === 2) parentIntro = stripHtml(b.html);
      continue;
    }
    if (b.level === 2) parentIntro = "";
    const sections: Record<string, string> = {};
    for (let k = i + 1; k < blocks.length && SECTIONS.test(blocks[k].title); k++) {
      sections[blocks[k].title.toLowerCase()] = blocks[k].html;
    }
    const paras = [...b.html.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)].map((m) => stripHtml(m[1])).filter(Boolean);
    const note = paras.find((p) => /^Note:/i.test(p))?.replace(/^Note:\s*/i, "") ?? null;
    const ministry = paras.find((p) => /^(Ministry|Office|Treasury|Cabinet|Ontario )/i.test(p)) ?? null;
    const deadlineText = stripHtml(sections["deadline"] ?? "");
    const all = [b.html, ...Object.values(sections)].join(" ");
    const links = [...all.matchAll(/href="([^"#][^"]*)(#[^"]*)?"/gi)].map((m) => m[1])
      .filter((h) => !/get-funding-ontario-government|^mailto:|^tel:/i.test(h));
    const guideline = sections["program guidelines"]?.match(/href="([^"]+)"/i)?.[1] ?? null;
    // One link per program: a link another program already uses would merge the two assets.
    const link = [guideline, ...links].map((h) => h && h.replace(/#.*$/, "")).find((h) => h && !usedLinks.has(h)) ?? null;
    if (link) usedLinks.add(link);
    const description = stripHtml(sections["description"] ?? "") || parentIntro;
    programs.push({
      title: b.title,
      status,
      ministry,
      deadline_text: deadlineText,
      deadline: latestDeadlineDate(deadlineText),
      note,
      description,
      eligibility: stripHtml(sections["eligibility"] ?? ""),
      link: link ? new URL(decodeEntities(link), "https://www.ontario.ca").toString() : null,
    });
  }
  return { updated, programs };
}

export type OntarioSnapshot = Record<string, { status: string; deadline_text: string; first_seen: string }>;

export interface OntarioChange { program: OntarioProgram; change: "new" | "status" | "deadline" | "unchanged" }

/** New programs and status or deadline changes since the last snapshot (for the change label and last_diff). */
export function diffPrograms(prev: OntarioSnapshot | null, programs: OntarioProgram[]): OntarioChange[] {
  const out: OntarioChange[] = [];
  for (const p of programs) {
    const old = prev?.[p.title];
    if (!old) out.push({ program: p, change: "new" });
    else if (old.status.toLowerCase() !== p.status.toLowerCase()) out.push({ program: p, change: "status" });
    else if (old.deadline_text !== p.deadline_text) out.push({ program: p, change: "deadline" });
  }
  return out;
}

/** A stable per-program URL: the guidelines link when there is one, else the page with a program marker. */
export function programUrl(p: OntarioProgram): string {
  return p.link ?? `${PAGE_URL}?program=${slug(p.title)}`;
}

const INSTRUCTIONS = `Items are Ontario government funding programs (the province's "Available funding opportunities" page); "change" says whether the program is new on the page or its status/deadline changed.
Cloud Nexus is a tiny Ottawa AI/web/marketing/video consultancy. Two ways a program can matter:
(a) Cloud Nexus itself is eligible (small tech/for-profit businesses, digital adoption, skills/training delivery, innovation), or
(b) it funds Cloud Nexus's likely clients (small businesses, non-profits, municipalities in eastern Ontario) to buy web, marketing, digital, video or training services, so it becomes a sales angle.
Score below 20: programs for police, fire, emergency preparedness, transit, roads, sport or infrastructure capital, environment/conservation, health or social services, mining, forestry, First Nations governments, or any other purpose where web/marketing/video/AI/training services are not plausible eligible spend. Being a municipality or non-profit alone is NOT an angle.
Programs matching (b) usually sit at 40–60, and only when digital, marketing, training or technology-adoption costs are plausibly eligible.
Extra fields for kept items: "opportunity_type": "grant" (direct funding he or a client applies for) or "program" (a broader program/stream); "amount" (only if stated); "eligibility" (one sentence: who can apply and the angle for Cloud Nexus).`;

export interface OntarioDeps { fetchPage?: () => Promise<string> }

export function ontarioSpec(deps: OntarioDeps = {}): FeedSpec<OntarioChange> {
  const fetchPage = deps.fetchPage ?? (() => fetchText(PAGE_URL, { timeoutMs: 45_000, headers: { Accept: "text/html" } }));
  return {
    name: FEED,
    sourceKind: "ontario-funding",
    instructions: INSTRUCTIONS,
    maxScore: 40,
    async collect(stats: FeedStats): Promise<Candidate<OntarioChange>[]> {
      const { updated, programs } = parseOntarioPage(await fetchPage());
      stats.seen = programs.length;
      if (programs.length === 0) throw new Error("no programs parsed: the page layout may have changed");
      const prev = getFeedMemo<OntarioSnapshot>(FEED, "snapshot");
      const changes = diffPrograms(prev, programs);
      const now = new Date().toISOString();
      const next: OntarioSnapshot = {};
      for (const p of programs) next[p.title] = { status: p.status, deadline_text: p.deadline_text, first_seen: prev?.[p.title]?.first_seen ?? now };
      const removed = Object.keys(prev ?? {}).filter((t) => !next[t]);
      setFeedMemo(FEED, "snapshot", next);
      setFeedMemo(FEED, "last_diff", { at: now, updated, changes: changes.map((c) => ({ title: c.program.title, change: c.change, status: c.program.status, deadline: c.program.deadline })), removed });
      stats.notes.push(`page updated ${updated ?? "?"}; ${changes.length} changes, ${removed.length} removed`);
      // Every open program is a candidate; runFeed skips (program, status, deadline)
      // versions already judged, so only new programs and changes reach the scorer,
      // and a failed scoring run is retried even though the snapshot moved on.
      const changed = new Map(changes.map((c) => [c.program.title, c.change]));
      const today = new Date().toISOString().slice(0, 10);
      return programs
        .map((p): OntarioChange => ({ program: p, change: changed.get(p.title) ?? "unchanged" }))
        // Closed or invitation-only programs, and deadlines already past, are never actionable.
        .filter((c) => !/closed|restricted/i.test(c.program.status) && !(c.program.deadline && c.program.deadline < today))
        .map((c) => ({
          ref: `ontario:${slug(c.program.title)}`,
          version: shortHash(`${c.program.status.toLowerCase()}|${c.program.deadline_text}`),
          prior: c.change === "new" ? 2 : c.change === "unchanged" ? 0 : 1,
          brief: {
            change: c.change,
            title: c.program.title,
            status: c.program.status,
            ministry: c.program.ministry ?? undefined,
            note: c.program.note ?? undefined,
            deadline: clip(c.program.deadline_text, 200),
            description: clip(c.program.description, 700),
            eligibility: clip(c.program.eligibility, 500),
          },
          raw: c,
        }));
    },
    toAsset(c: Candidate<OntarioChange>, j: Judgment) {
      const p = c.raw.program;
      const { track, tracks } = pickTrack(j, "bids");
      const type = j.opportunity_type === "program" ? "program" : "grant";
      const url = programUrl(p);
      return {
        asset: {
          kind: "opportunity",
          title: p.title,
          url,
          summary: textOr(j.summary, clip(p.description, 240)),
          track,
          tracks: [...new Set([...tracks, "bids"])],
          value_score: j.score,
          value_reason: textOr(j.reason, "Ontario funding program relevant to the bids track."),
          next_action: textOr(j.next_action, "Read the program guidelines and check eligibility."),
          effort: pickEffort(j.effort) ?? "M",
          deadline: p.deadline,
          amount: j.amount || null,
          extractor: "feed:ontario-funding:v1",
          details: {
            opportunity_type: type,
            org: p.ministry ?? "Government of Ontario",
            status: p.status,
            change: c.raw.change,
            deadline_text: p.deadline_text || undefined,
            eligibility: j.eligibility || clip(p.eligibility, 300) || undefined,
            region: "Ontario",
            page_url: PAGE_URL,
          },
        },
        source: { source_kind: "ontario-funding", source_ref: c.ref, source_url: PAGE_URL, source_title: p.title, evidence: `Status: ${p.status}${p.deadline_text ? ` — ${clip(p.deadline_text, 160)}` : ""}` },
      };
    },
  };
}

export const runOntarioFunding = (deps?: OntarioDeps) => runFeed(ontarioSpec(deps));

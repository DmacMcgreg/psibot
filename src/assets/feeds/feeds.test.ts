import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import * as sqliteVec from "sqlite-vec";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MIGRATIONS } from "../../db/schema.ts";
import { setDbForTesting } from "../../db/index.ts";
import { getOpsState } from "../../db/queries.ts";
import { parseCsv, toIsoDate, humanBytes, clip, readFeedState, FEEDS_STATE_KEY, setAskForTesting, newStats } from "./common.ts";
import * as cb from "./canadabuys.ts";
import * as ont from "./ontario-funding.ts";
import * as gc from "./gc-news.ts";
import * as irap from "./irap-leads.ts";
import * as hf from "./huggingface.ts";
import * as gh from "./github.ts";
import * as hn from "./hackernews.ts";
import * as sk from "./skills-sh.ts";
import * as kg from "./kaggle.ts";

// The scorer is the only model call; a deterministic stub keeps items whose
// brief mentions "Campaign", "Accessibility" or "ROMAERIS".
let scorerCalls = 0;
async function stubAsk(prompt: string): Promise<unknown> {
  scorerCalls++;
  const items = JSON.parse(prompt.slice(prompt.indexOf("Items (JSON"), prompt.indexOf("Reply with ONLY")).replace(/^[^\n]*\n/, "")) as { i: number }[];
  return items.map((it) => /Campaign|Accessibility|ROMAERIS/i.test(JSON.stringify(it))
    ? { i: it.i, score: 70, track: "bids", tracks: ["bids", "marketing"], summary: "Stub summary.", reason: "Stub reason.", next_action: "Stub action.", effort: "M", amount: null, eligibility: "Open to all." }
    : { i: it.i, score: 12, reason: "Off-track." });
}

const fx = (name: string) => readFileSync(join(import.meta.dir, "__fixtures__", name), "utf-8");

let db: Database;
beforeAll(() => {
  db = new Database(":memory:");
  sqliteVec.load(db);
  for (const sql of MIGRATIONS) {
    try { db.exec(sql); } catch (e) { if (!(e instanceof Error && e.message.includes("duplicate column"))) throw e; }
  }
  setDbForTesting(db);
  setAskForTesting(stubAsk);
});
afterAll(() => { setAskForTesting(null); db.close(); });

describe("common helpers", () => {
  it("parses CSV with BOM, quoted commas, doubled quotes and embedded newlines", () => {
    const rows = parseCsv('﻿"a","b"\r\n"x, y","line1\nline2 ""q"""\n3,4\n');
    expect(rows).toEqual([{ a: "x, y", b: 'line1\nline2 "q"' }, { a: "3", b: "4" }]);
  });
  it("normalises dates and sizes", () => {
    expect(toIsoDate("Applications must be submitted by Wednesday, September 9, 2026, at 4:00 p.m.")).toBe("2026-09-09");
    expect(toIsoDate("2026-10-06T14:00:00")).toBe("2026-10-06");
    expect(toIsoDate("Applications are ongoing.")).toBeNull();
    expect(humanBytes(771_000_950)).toBe("771 MB");
    expect(clip("a   b", 10)).toBe("a b");
  });
});

describe("canadabuys", () => {
  const rows = parseCsv(fx("canadabuys.csv"));
  const byTitle = (t: string) => rows.find((r) => r["title-titre-eng"].startsWith(t))!;
  it("reads the real column layout", () => {
    expect(rows.length).toBe(5);
    expect(cb.unspscCodes(byTitle("RFP01"))).toContain("80171602");
    expect(cb.multi("*a\n* b\n")).toEqual(["a", "b"]);
  });
  it("keeps coded, open, winnable notices and drops the rest by rule", () => {
    const today = "2026-09-26";
    expect(cb.tenderRule(byTitle("RFP01"), today).pass).toBe(true);
    expect(cb.tenderRule(byTitle("Request for Supply Arrangement - Accessibility"), today).pass).toBe(true);
    expect(cb.tenderRule(byTitle("Open Construction"), today)).toEqual({ pass: false, why: "construction" });
    expect(cb.tenderRule(byTitle("RFP01"), "2026-10-05")).toEqual({ pass: false, why: "closing too soon" });
    expect(cb.tenderRule(byTitle("RFP01"), "2026-10-07")).toEqual({ pass: false, why: "closed" });
    const callup = { ...byTitle("RFP01"), "noticeType-avisType-eng": "RFP against Supply Arrangement" };
    expect(cb.tenderRule(callup, today)).toEqual({ pass: false, why: "supply-arrangement call-up" });
    const acan = { ...byTitle("RFP01"), "noticeType-avisType-eng": "Advance Contract Award Notice" };
    expect(cb.tenderRule(acan, today)).toEqual({ pass: false, why: "pre-awarded" });
  });
  it("merges sibling notices (RFSA + RFSO of one file number) into one group", () => {
    const base = byTitle("RFP01");
    const rfsa = { ...base, "referenceNumber-numeroReference": "WS1-Doc1", "solicitationNumber-numeroSollicitation": "WS1", "title-titre-eng": "RFSA (EP361-261511) - PSPC - Advertising Creative Production Services", "publicationDate-datePublication": "2026-09-01" };
    const rfso = { ...base, "referenceNumber-numeroReference": "WS2-Doc2", "solicitationNumber-numeroSollicitation": "WS2", "title-titre-eng": "RFSO (EP361-261511) - PSPC - Advertising Creative Production Services", "publicationDate-datePublication": "2026-09-03" };
    const groups = cb.groupTenders([rfsa, rfso, base]);
    expect(groups.length).toBe(2);
    const g = groups.find((x) => x.groupRef === "EP361-261511")!;
    expect(g.rows.length).toBe(2);
    expect(g.lead["referenceNumber-numeroReference"]).toBe("WS1-Doc1");
  });
  it("builds the public notice URL from the reference number", () => {
    expect(cb.canadaBuysUrl("WS4052927717-Doc4053526199")).toBe("https://canadabuys.canada.ca/en/tender-opportunities/tender-notice/ws4052927717-doc4053526199");
    expect(cb.canadaBuysUrl("SSC-26-00034400:T")).toBe("https://canadabuys.canada.ca/en/tender-opportunities/tender-notice/ssc-26-00034400t");
  });

  it("runs the whole pipeline: scores once, keeps ≥ 40, records counts, stays idempotent", async () => {
    const deps = { fetchCsv: async () => fx("canadabuys.csv"), today: "2026-09-26" };
    scorerCalls = 0;
    const s1 = await cb.runCanadaBuys(deps);
    expect(s1.errors).toEqual([]);
    expect(s1.seen).toBe(5);
    expect(s1.candidates).toBe(2);
    expect(s1.kept).toBe(2);
    expect(s1.created).toBe(2);
    const a = db.query(`SELECT * FROM assets WHERE title LIKE 'RFP01%'`).get() as { kind: string; deadline: string; url: string; details_json: string; track: string; value_score: number };
    expect(a.kind).toBe("opportunity");
    expect(a.deadline).toBe("2026-10-06");
    expect(a.url).toContain("canadabuys.canada.ca/en/tender-opportunities/tender-notice/");
    const d = JSON.parse(a.details_json);
    expect(d.opportunity_type).toBe("tender");
    expect(d.org).toContain("Public Works");
    expect(d.categories[0]).toContain("80171602");
    expect(a.value_score).toBe(70);

    const calls = scorerCalls;
    const s2 = await cb.runCanadaBuys(deps);
    expect(scorerCalls).toBe(calls); // nothing re-scored
    expect(s2.scored).toBe(0);
    expect((db.query(`SELECT COUNT(*) AS n FROM assets`).get() as { n: number }).n).toBe(2);

    const state = readFeedState("canadabuys")!;
    expect(state.history.length).toBe(2);
    expect(JSON.parse(getOpsState(FEEDS_STATE_KEY)!).canadabuys.seen).toBe(5);
  });

  it("never throws when the source is down", async () => {
    const s = await cb.runCanadaBuys({ fetchCsv: async () => { throw new Error("boom"); } });
    expect(s.errors.length).toBe(2);
    expect(s.kept).toBe(0);
  });
});

describe("ontario funding", () => {
  const { updated, programs } = ont.parseOntarioPage(fx("ontario.html"));
  it("parses flat and nested program blocks", () => {
    expect(updated).toBe("September 25, 2026");
    const titles = programs.map((p) => p.title);
    expect(titles).toContain("Border Security Grant (BSG)");
    expect(titles).toContain("Eastern Ontario Development Fund");
    expect(titles).toContain("Regional Development Program: Advanced Manufacturing and Innovation Competitiveness (AMIC) Stream");
    expect(titles).not.toContain("Overview");
    const bsg = programs.find((p) => p.title.startsWith("Border"))!;
    expect(bsg.status).toBe("OPEN");
    expect(bsg.deadline).toBe("2026-09-09");
    expect(bsg.ministry).toBe("Ministry of the Solicitor General");
    const eodf = programs.find((p) => p.title === "Eastern Ontario Development Fund")!;
    expect(eodf.description).toContain("eastern Ontario");
    expect(eodf.link).toBe("https://www.ontario.ca/page/eastern-ontario-development-fund");
  });
  it("diffs against the last snapshot", () => {
    const snap = Object.fromEntries(programs.map((p) => [p.title, { status: p.status, deadline_text: p.deadline_text, first_seen: "x" }]));
    expect(ont.diffPrograms(snap, programs)).toEqual([]);
    snap["Border Security Grant (BSG)"].status = "CLOSED";
    delete snap["Eastern Ontario Development Fund"];
    const d = ont.diffPrograms(snap, programs).map((c) => [c.program.title, c.change]);
    expect(d).toEqual([["Border Security Grant (BSG)", "status"], ["Eastern Ontario Development Fund", "new"]]);
  });
  it("gives every program a distinct URL", () => {
    const urls = programs.map(ont.programUrl);
    expect(new Set(urls).size).toBe(urls.length);
  });
});

describe("gc news", () => {
  const entries = JSON.parse(fx("gcnews.json")).feed.entry as { title: string; teaser: string; link: string; publishedDate: string }[];
  it("keeps intake announcements and drops diplomatic news", () => {
    const kept = entries.filter((e) => gc.gcNewsRule(e).pass).map((e) => e.title);
    expect(kept.some((t) => /call for proposals/i.test(t))).toBe(true);
    expect(kept.some((t) => /meets with/i.test(t))).toBe(false);
  });
  it("extracts article text from main", () => {
    expect(gc.articleText("<nav>menu</nav><main><h1>Fund</h1><p>Apply by October 1, 2026.</p><footer>x</footer></main>")).toBe("Fund Apply by October 1, 2026.");
  });
});

describe("irap leads", () => {
  const records = JSON.parse(fx("grants.json"));
  it("keeps Ottawa-area firms inside 90 days of the newest agreement, one per company", () => {
    const dup = { ...records[0], ref_number: "dup-1", agreement_value: "1000.0" };
    const { companies, windowStart } = irap.groupCompanies([...records, dup]);
    expect(windowStart).toBe("2026-04-02");
    expect(companies.every((c) => irap.OTTAWA_AREA.test(c.city))).toBe(true);
    const rom = companies.find((c) => c.name === "ROMAERIS CORPORATION")!;
    expect(rom.refs.length).toBe(2);
    expect(rom.total_value).toBe(351000);
    expect(companies.find((c) => /Mediphage/.test(c.name))).toBeUndefined(); // Toronto
  });
  it("runs as leads with a stable per-company URL", async () => {
    const s = await irap.runIrapLeads({ fetchRecords: async () => records });
    expect(s.kept).toBe(1);
    const a = db.query(`SELECT * FROM assets WHERE title LIKE 'Lead:%'`).get() as { url: string; details_json: string; deadline: string | null };
    expect(a.url).toBe("https://search.open.canada.ca/grants/?search_text=ROMAERIS%20CORPORATION");
    expect(JSON.parse(a.details_json).opportunity_type).toBe("lead");
    expect(a.deadline).toBeNull();
  });
});

describe("hugging face", () => {
  const since = "2026-09-05T00:00:00Z";
  const good = {
    id: "ethan4848/tiktok-video-engagement-200k", createdAt: "2026-09-24T21:52:51.000Z", downloads: 13, likes: 0, mainSize: 135_533_144,
    tags: ["license:cc-by-nc-4.0", "size_categories:1M<n<10M", "tiktok"],
    description: "\n\tTikTok Creator and Video Engagement (200K)\n\nThis release contains 209,543 TikTok videos from 1,872 creators with daily engagement. See the full description on the dataset page: https://x",
    cardData: { license: "cc-by-nc-4.0", pretty_name: "TikTok Creator and Video Engagement (200K)", size_categories: ["1M<n<10M"], task_categories: ["text-classification"] },
  };
  it("keeps on-track datasets with a real card and reads licence and size", () => {
    expect(hf.hfRule(good, { since }).pass).toBe(true);
    expect(hf.licenseOf(good)).toBe("cc-by-nc-4.0");
    expect(hf.sizeOf(good)).toBe("1M<n<10M rows, 136 MB");
    expect(hf.cleanDescription(good.description)).not.toContain("See the full description");
  });
  it("drops spam, robotics dumps, mirrors, off-track and author-only keyword hits", () => {
    expect(hf.hfRule({ id: "anhnt004/crawl_data_youtube_tiktok", createdAt: "2026-09-26", tags: ["region:us"] }, { since }).why).toBe("empty card");
    expect(hf.hfRule({ ...good, id: "x/so101-turn-up-drone_20260926_103705" }, { since }).why).toBe("noise");
    expect(hf.hfRule({ ...good, tags: ["task_categories:robotics"] }, { since }).why).toBe("robotics");
    expect(hf.hfRule({ ...good, createdAt: "2026-01-01" }, { since }).why).toBe("old");
    const ship = { id: "dronefreak/SSDD", createdAt: "2026-09-16", downloads: 500, cardData: { pretty_name: "SSDD SAR Ship Detection Dataset" }, description: "Synthetic aperture radar ship detection benchmark with bounding boxes for maritime surveillance research." };
    expect(hf.hfRule(ship, { since }).why).toBe("off-track");
  });
});

describe("github", () => {
  it("extracts only install commands the README states, agent-specific first", () => {
    const md = "# X\n```bash\ngit clone https://github.com/a/b\nnpm install -g foo-cli\n```\nOr: `npx skills add a/b`\n";
    expect(gh.extractInstall(md)).toBe("npx skills add a/b");
    expect(gh.extractInstall("```\n$ pip install reelcut\n```")).toBe("pip install reelcut");
    expect(gh.extractInstall("No commands here.")).toBeNull();
    const deps = "```\npip install -r requirements.txt\nnpm install -g ffmpeg-static\ngit clone https://github.com/blix/easyedit\n```";
    expect(gh.extractInstall(deps, "blix/easyedit")).toBe("git clone https://github.com/blix/easyedit");
    expect(gh.extractInstall("```\npip install -r requirements.txt\n```", "blix/easyedit")).toBeNull();
  });
  it("builds a created-since search query", () => {
    const u = gh.searchUrl({ q: "topic:claude-skills", days: 7, minStars: 20 }, new Date("2026-09-26T12:00:00Z"));
    expect(decodeURIComponent(u)).toContain("q=topic:claude-skills created:>2026-09-19");
  });
  it("collects, dedupes across queries and applies the star floor", async () => {
    const repo = (full_name: string, stars: number, extra = {}) => ({ full_name, html_url: `https://github.com/${full_name}`, description: "d", stargazers_count: stars, created_at: "2026-09-23T00:00:00Z", ...extra });
    const get = async (url: string) => {
      const body = url.includes("claude-skills") ? { items: [repo("a/skill", 50), repo("b/tiny", 3)] }
        : url.includes("agent-skills") ? { items: [repo("a/skill", 50), repo("c/fork", 99, { fork: true })] }
        : { items: [] };
      return new Response(JSON.stringify(body), { status: 200 });
    };
    const spec = gh.githubSpec({ get, token: "t" });
    const st = newStats("github");
    const c = await spec.collect(st);
    expect(c.map((x) => x.ref)).toEqual(["a/skill"]);
    expect(c[0].raw.queries.length).toBe(2);
    expect(c[0].raw.skillish).toBe(true);
  });
});

describe("hacker news", () => {
  const hit = (over: Record<string, unknown>) => ({ objectID: "1", title: "Show HN: Reelcut – ffmpeg shorts from long videos", url: "https://github.com/a/reelcut", points: 120, created_at: "2026-09-25T00:00:00Z", created_at_i: 1, _tags: ["story", "show_hn"], ...over });
  it("applies the points floor and topic filter", () => {
    expect(hn.hnRule(hit({}))).toBe(true);
    expect(hn.hnRule(hit({ points: 50 }))).toBe(false); // Show HN floor is 60
    expect(hn.hnRule(hit({ title: "Why is the liver so weirdly regenerative?", url: "https://x.com/liver", _tags: ["story"] }))).toBe(false);
    expect(hn.hnRule(hit({ title: "Ask HN: best ffmpeg flags?" }))).toBe(false);
  });
});

describe("skills.sh", () => {
  it("groups skills per package and drops re-published copies", () => {
    const h = (source: string, skillId: string, installs: number) => ({ id: `${source}/${skillId}`, source, skillId, name: skillId, installs });
    const pk = sk.groupPackages({
      marketing: [h("corey/marketingskills", "seo-audit", 1000), h("corey/marketingskills", "copywriting", 900), h("copycat/marketingskills", "seo-audit", 10), h("copycat/marketingskills", "copywriting", 5)],
      seo: [h("corey/marketingskills", "seo-audit", 1000)],
    });
    expect(pk.map((p) => p.source)).toEqual(["corey/marketingskills"]);
    expect(pk[0].skills.length).toBe(2);
    expect(pk[0].queries).toEqual(["marketing", "seo"]);
    expect(sk.alreadyInstalled(pk[0], new Set(["seo-audit"]))).toBe(true);
    expect(sk.alreadyInstalled(pk[0], new Set(["other"]))).toBe(false);
    expect(sk.installCommand("corey/marketingskills", "seo-audit")).toBe("npx skills add https://github.com/corey/marketingskills --skill seo-audit");
  });
});

describe("kaggle", () => {
  const since = "2026-09-05T00:00:00Z";
  const d = { ref: "plantpark/tiktok-product-video-comments", title: "TikTok Product Video Comments 2026", subtitle: "1M TikTok comments on 17.7K product videos", url: "https://www.kaggle.com/datasets/plantpark/tiktok-product-video-comments", lastUpdated: "2026-09-14T00:00:00Z", usabilityRating: 0.59, totalBytes: 71_954_557, licenseName: "Other" };
  it("keeps recent, usable, on-track datasets", () => {
    expect(kg.kaggleRule(d, since).pass).toBe(true);
    expect(kg.kaggleRule({ ...d, title: "College Social Media & Study Habits (Synthetic)" }, since).why).toBe("synthetic");
    expect(kg.kaggleRule({ ...d, usabilityRating: 0.3 }, since).why).toBe("low usability");
    expect(kg.kaggleRule({ ...d, lastUpdated: "2026-08-01" }, since).why).toBe("old");
    expect(kg.kaggleRule({ ...d, title: "Autonomous Driving Crash Reports", subtitle: "NHTSA" }, since).why).toBe("off-track");
  });
});

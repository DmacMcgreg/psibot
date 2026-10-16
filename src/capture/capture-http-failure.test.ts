import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import * as sqliteVec from "sqlite-vec";
import { MIGRATIONS } from "../db/schema.ts";
import { setDbForTesting } from "../db/index.ts";
import { loadConfig } from "../config.ts";
import { resetOpsAlertsForTesting, setOpsAlertSender } from "../shared/ops-alerts.ts";
import { pollRedditSaved } from "./reddit.ts";
import { pollGithubStars } from "./github.ts";
import { runInboxPollReddit, runInboxPollGithub } from "../agent/tools.ts";

/**
 * A capture poll that dies on an HTTP error must be LOUD, not "0 captured".
 *
 * Job 32 (Reddit Saved Poller) has returned HTTP 403 from saved.json on every
 * poll since at least 2026-10-08, yet job_runs records success: pollRedditSaved()
 * logged the error, `break`, and returned 0 — indistinguishable from "no new
 * saves" — and the model replied "[SILENT] Done." because notify_policy=on_error
 * only fires on a non-success run. These tests pin the fix: the fetch boundary
 * rejects with the status, the inflight handlers surface it as isError, and one
 * deduped ops alert (key `capture:reddit` / `capture:github`) goes out through
 * ops-alerts — independent of the model's wording and of notify_policy. A clean
 * 200 with zero items stays silent.
 *
 * Throwaway env fixture, same as provider-window.test.ts: a clean checkout has
 * no .env and loadConfig() refuses to run without these. Literal dummies only.
 */
process.env.TELEGRAM_BOT_TOKEN ??= "123456:TEST-BOT-TOKEN";
process.env.ALLOWED_TELEGRAM_USER_IDS ??= "100000001";
process.env.REDDIT_FEED_TOKEN ??= "test-reddit-feed-token";
process.env.REDDIT_USERNAME ??= "test-user";
process.env.GITHUB_TOKEN ??= "test-github-token";

let db: Database;
let sent: string[];
const realFetch = globalThis.fetch;

beforeAll(() => {
  loadConfig();
  db = new Database(":memory:");
  sqliteVec.load(db);
  for (const sql of MIGRATIONS) db.exec(sql);
  setDbForTesting(db);
});

afterAll(() => {
  globalThis.fetch = realFetch;
  db.close();
});

beforeEach(() => {
  db.exec("DELETE FROM ops_state;");
  resetOpsAlertsForTesting();
  sent = [];
  setOpsAlertSender(async (text) => {
    sent.push(text);
    return true;
  });
});

afterEach(() => {
  globalThis.fetch = realFetch;
  resetOpsAlertsForTesting();
});

function stubFetch(status: number, body = ""): void {
  globalThis.fetch = (async () => new Response(body, { status })) as unknown as typeof fetch;
}

const emptyRedditListing = JSON.stringify({ kind: "Listing", data: { after: null, children: [] } });

describe("capture HTTP failures are loud, not 0", () => {
  it("pollRedditSaved rejects naming the status on 403", async () => {
    stubFetch(403, "blocked");
    await expect(pollRedditSaved()).rejects.toThrow(/403/);
  });

  it("pollGithubStars rejects naming the status on a non-2xx", async () => {
    stubFetch(500, "boom");
    await expect(pollGithubStars()).rejects.toThrow(/500/);
  });

  it("the reddit handler returns isError carrying the status", async () => {
    stubFetch(403, "blocked");
    const res = await runInboxPollReddit();
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("403");
  });

  it("the github handler returns isError carrying the status", async () => {
    stubFetch(404, "nope");
    const res = await runInboxPollGithub();
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("404");
  });

  it("sends exactly one capture:reddit alert naming 403 and dedupes a second failure within 24h", async () => {
    stubFetch(403, "blocked");
    await expect(pollRedditSaved()).rejects.toThrow(/403/);
    await expect(pollRedditSaved()).rejects.toThrow(/403/);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("403");
  });

  it("a 200 with zero items sends no alert", async () => {
    stubFetch(200, emptyRedditListing);
    expect(await pollRedditSaved()).toBe(0);
    expect(sent).toHaveLength(0);
  });
});

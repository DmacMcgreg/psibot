import { describe, it, expect } from "bun:test";
import { providerErrorResult } from "./run-outcome.ts";

/**
 * The classifier that turns a provider error envelope arriving as a *result*
 * into a run failure: the bare 429 dialects (job_runs 10322-24, the original
 * blind spot) plus the census's three residual shapes below.
 * Live specimens quoted verbatim from a fresh /tmp trio copy of the registry
 * (/tmp/psibot-429-20261005 + /tmp/psibot-jobruns-blindspot-20261005, copied
 * 2026-10-05) — never read from the live registry.
 */

// job_runs 10322/10323/10324 — jobs 12/32/34, started 2026-10-05 04:00:00Z,
// all recorded status "success" with these bare 429 results (the silent
// failure this classifier exists to end).
const RUN_10322 = "API Error: Request rejected (429) · [1308][Usage limit reached for 5 hour. Your limit will reset at 2026-10-05 12:12:52][20261005120002e143547df7b14f5c]";
const RUN_10323 = "API Error: Request rejected (429) · [1308][Usage limit reached for 5 hour. Your limit will reset at 2026-10-05 12:12:52][202610051203064ba74f60123e4f91]";
const RUN_10324 = "API Error: Request rejected (429) · [1308][Usage limit reached for 5 hour. Your limit will reset at 2026-10-05 12:12:52][2026100512031038e9dc9c153243e6]";
// The other live phrasing: JSON envelope, code 1302 rate limit (8 registry rows).
const RUN_JSON_1302 = 'API Error: 429 {"error":{"code":"1302","message":"Rate limit reached for requests"},"request_id":"20260413210351a529a7422c0043b3"}';

// Census residual shapes (research/psibot-jobruns-silent-blindspot-2026-10.md),
// quoted verbatim from the /tmp trio copy /tmp/psibot-jobruns-blindspot-20261005/
// (snapshot 2026-10-05T06:46:43Z) — never the live registry.

// id 215, job 33 Inbox Triage, 2026-03-24 18:30:00Z — the registry's OLDEST
// silent success: the exact context-window sentence (26 rows, one distinct
// text, 2026-03-24 → 2026-05-07).
const RUN_215_CONTEXT_WINDOW = "API Error: The model has reached its context window limit.";

// id 1402, job 36, 2026-04-10 21:07:19Z — oldest of the 8 Apr 10-11 auth
// outage rows; the CLI's own prefix ahead of the API envelope.
const RUN_1402_AUTH_401 = 'Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"Invalid authentication credentials"},"request_id":"req_011CZvmnzyRJiiSdrkpkZA6C"}';

// ids 7000/7002 (jobs 62/33, 2026-06-18) — the "[fallback: …]" tag emitted by
// agent/index.ts ahead of the same bare 529 envelope: every fallback tier was
// exhausted, so the tag + envelope IS the run's final output.
const RUN_7000_FALLBACK_529 = `[fallback: glm/sonnet, tier 2/8]

API Error: 529 {"type":"error","error":{"type":"overloaded_error","code":"1305","message":"[1305][The service may be temporarily overloaded, please try again later][20260618114907e8635efcba4c4d98]"},"request_id":"20260618114907e8635efcba4c4d98"}`;
const RUN_7002_FALLBACK_529 = `[fallback: glm/sonnet, tier 2/8]

API Error: 529 {"type":"error","error":{"type":"overloaded_error","code":"1305","message":"[1305][The service may be temporarily overloaded, please try again later][202606181148379b45b770b1964988]"},"request_id":"202606181148379b45b770b1964988"}`;

// id 4117, job 62 Nightly Brief, 2026-05-06 03:00:00Z — the census's contains-
// predicate false positive: a legitimate brief whose prose mentions
// "(Google/Apple API errors)". Anchored matching must keep it a success.
const RUN_4117_PROSE = `[NOTIFY]
🌙 NIGHTLY BRIEF — Tuesday, May 5

📅 TOMORROW (Wednesday, May 6)
  Calendar data unavailable (Google/Apple API errors)
  
🌤️ TOMORROW'S WEATHER
  11.8°C / 6.9°C ☁ Overcast — precip 16%

📚 CLASS PREP
  ⚠️ CLASS NIGHT TOMORROW (Wednesday)
  No lecture notes found in upcoming-lectures/

💤 No confirmed early commitments (calendar unavailable). Sleep well, but remember to prep class material for tomorrow night.

---
Brief saved to: ~/Documents/NotePlan-Notes/Notes/60 - Briefings/2026-05-05-nightly-brief.md
[/NOTIFY]`;

// id 9496, job 12 — a "[fallback: …]" tag ahead of REAL content (a tier that
// worked): 64 registry rows carry this shape and none of them is an error, so
// the tag alone must never match — only the tag + error envelope does.
const RUN_9496_FALLBACK_SUCCESS = `[fallback: glm/opus, tier 2/9]

[SILENT]`;

describe("providerErrorResult", () => {
  it("matches the live-quoted 429 results from job_runs 10322-10324", () => {
    for (const live of [RUN_10322, RUN_10323, RUN_10324]) {
      expect(providerErrorResult(live)).toBe(live);
    }
  });

  it("matches the JSON-envelope 429 phrasing", () => {
    expect(providerErrorResult(RUN_JSON_1302)).toBe(RUN_JSON_1302);
  });

  it("ignores null, empty and normal results", () => {
    expect(providerErrorResult(null)).toBeNull();
    expect(providerErrorResult(undefined)).toBeNull();
    expect(providerErrorResult("")).toBeNull();
    expect(providerErrorResult("Digest complete! ✅ 22 sessions logged")).toBeNull();
    expect(providerErrorResult("[SILENT] Signal Trader tick: 9 clusters reviewed")).toBeNull();
  });

  it("does not match 429 as a substring of real content or another status code", () => {
    expect(providerErrorResult("Processed 1429 items without errors")).toBeNull();
    expect(providerErrorResult("Queue depth: 429 jobs")).toBeNull();
    // The bare 529/500/connect/400 outage families stay unclassified — only
    // the census's fallback-TAGGED 529 pair (ids 7000/7002) is in scope.
    expect(providerErrorResult('API Error: 529 {"type":"error","error":{"type":"overloaded_error","code":"1305","message":"[1305][The service may be temporarily overloaded, please try again later][20260617100322fb9d6f5e638348fb]"},"request_id":"20260617100322fb9d6f5e638348fb"}')).toBeNull();
  });

  it("only matches when the envelope is the whole result (registry: zero mid-text occurrences)", () => {
    expect(providerErrorResult(`Summary: 3 picks delivered.\n\n${RUN_10322}`)).toBeNull();
  });

  it("matches the census's three residual shapes: context-window, auth 401, fallback-exhausted 529", () => {
    // ids 215 / 1402 / 7000+7002 — all stamped status "success" in the
    // registry, all provider rejections the CLI exits 0 on.
    expect(providerErrorResult(RUN_215_CONTEXT_WINDOW)).toBe(RUN_215_CONTEXT_WINDOW);
    expect(providerErrorResult(RUN_1402_AUTH_401)).toBe(RUN_1402_AUTH_401);
    expect(providerErrorResult(RUN_7000_FALLBACK_529)).toBe(RUN_7000_FALLBACK_529);
    expect(providerErrorResult(RUN_7002_FALLBACK_529)).toBe(RUN_7002_FALLBACK_529);
  });

  it("keeps the id-4117 prose false-positive a success (anchored prefix, never contains)", () => {
    // The brief's only "API Error"-shaped text is the mid-prose mention
    // "(Google/Apple API errors)" — lowercase, inside a sentence, not an
    // envelope. The census's contains predicate caught it; this must not.
    expect(providerErrorResult(RUN_4117_PROSE)).toBeNull();
  });

  it("does not match a [fallback: …] tag ahead of real content", () => {
    // 64 registry rows carry the fallback tag over a tier that SUCCEEDED —
    // only the tag + error-envelope shape (ids 7000/7002) is a failure.
    expect(providerErrorResult(RUN_9496_FALLBACK_SUCCESS)).toBeNull();
  });
});

import { describe, it, expect } from "bun:test";
import { providerQuotaError } from "./run-outcome.ts";

/**
 * The classifier that turns a bare provider 429 result into a run failure.
 * Live specimens quoted verbatim from a fresh /tmp trio copy of the registry
 * (/tmp/psibot-429-20261005/app.db, copied 2026-10-05 02:44 UTC) — never read
 * from the live registry.
 */

// job_runs 10322/10323/10324 — jobs 12/32/34, started 2026-10-05 04:00:00Z,
// all recorded status "success" with these bare 429 results (the silent
// failure this classifier exists to end).
const RUN_10322 = "API Error: Request rejected (429) · [1308][Usage limit reached for 5 hour. Your limit will reset at 2026-10-05 12:12:52][20261005120002e143547df7b14f5c]";
const RUN_10323 = "API Error: Request rejected (429) · [1308][Usage limit reached for 5 hour. Your limit will reset at 2026-10-05 12:12:52][202610051203064ba74f60123e4f91]";
const RUN_10324 = "API Error: Request rejected (429) · [1308][Usage limit reached for 5 hour. Your limit will reset at 2026-10-05 12:12:52][2026100512031038e9dc9c153243e6]";
// The other live phrasing: JSON envelope, code 1302 rate limit (8 registry rows).
const RUN_JSON_1302 = 'API Error: 429 {"error":{"code":"1302","message":"Rate limit reached for requests"},"request_id":"20260413210351a529a7422c0043b3"}';

describe("providerQuotaError", () => {
  it("matches the live-quoted 429 results from job_runs 10322-10324", () => {
    for (const live of [RUN_10322, RUN_10323, RUN_10324]) {
      expect(providerQuotaError(live)).toBe(live);
    }
  });

  it("matches the JSON-envelope 429 phrasing", () => {
    expect(providerQuotaError(RUN_JSON_1302)).toBe(RUN_JSON_1302);
  });

  it("ignores null, empty and normal results", () => {
    expect(providerQuotaError(null)).toBeNull();
    expect(providerQuotaError(undefined)).toBeNull();
    expect(providerQuotaError("")).toBeNull();
    expect(providerQuotaError("Digest complete! ✅ 22 sessions logged")).toBeNull();
    expect(providerQuotaError("[SILENT] Signal Trader tick: 9 clusters reviewed")).toBeNull();
  });

  it("does not match 429 as a substring of real content or another status code", () => {
    expect(providerQuotaError("Processed 1429 items without errors")).toBeNull();
    expect(providerQuotaError("Queue depth: 429 jobs")).toBeNull();
    // 529 overloaded_error is a provider capacity issue, not a quota rejection.
    expect(providerQuotaError('API Error: 529 {"type":"error","error":{"type":"overloaded_error","code":"1305","message":"[1305][The service may be temporarily overloaded, please try again later][20260617100322fb9d6f5e638348fb]"},"request_id":"20260617100322fb9d6f5e638348fb"}')).toBeNull();
  });

  it("only matches when the envelope is the whole result (registry: zero mid-text occurrences)", () => {
    expect(providerQuotaError(`Summary: 3 picks delivered.\n\n${RUN_10322}`)).toBeNull();
  });
});

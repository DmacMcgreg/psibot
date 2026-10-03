import { describe, expect, it } from "bun:test";
import { decideNotify } from "./notify-policy.ts";
import type { Job } from "../shared/types.ts";

function jobWith(policy: string | null): Job {
  return { id: 31, name: "Morning Brief", notify_policy: policy } as Job;
}

function decide(policy: string | null, result: string) {
  return decideNotify({
    agent: null,
    job: jobWith(policy),
    status: "success",
    result,
    previousHash: null,
  });
}

/**
 * Real offending output from the 2026-07-22 incident: the agent delivered the
 * brief, then its final free-text was a work report — and policy "always"
 * broadcast it to Telegram. These fixtures pin the fix: brief-class jobs run
 * policy "dynamic", so unmarked work reports are dropped and only
 * [NOTIFY]-wrapped content reaches the user.
 */
const META_REPORT = `Morning brief delivered. Summary:

- **Data sources**: Weather ✓, Apple Calendar ✓, Gmail ✓. remindctl --all failed (wrong flag).
- **Bills**: Scotia credit card min payment due Jul 30 — reminder job #75 already exists.
- **Backup saved**: ~/Documents/NotePlan-Notes/Notes/60 - Briefings/2026-07-22-morning-brief.md

Brief is ~1,900 chars (under the 2,500 cap).`;

const MARKED_BRIEF = `Some internal narration first.

[NOTIFY]🌙 NIGHTLY BRIEF — Tue, Jul 21

📅 TOMORROW (Wed, Jul 22)
9:30 — Catch up (Grove talent)[/NOTIFY]

Saved backup to briefings folder.`;

describe("notify-policy: brief meta-report regression", () => {
  it("dynamic policy drops an unmarked work report", () => {
    const d = decide("dynamic", META_REPORT);
    expect(d.notify).toBe(false);
  });

  it("dynamic policy delivers a [NOTIFY]-marked brief with markers stripped", () => {
    const d = decide("dynamic", MARKED_BRIEF);
    expect(d.notify).toBe(true);
    expect(d.cleanedResult).not.toContain("[NOTIFY]");
    expect(d.cleanedResult).not.toContain("[/NOTIFY]");
    expect(d.cleanedResult).toContain("NIGHTLY BRIEF");
  });

  it("documents the failure mode: null policy defaults to always and broadcasts the report", () => {
    // This is WHY jobs 31/62 must carry notify_policy='dynamic' in the DB.
    // If the default ever changes, this test states the current contract.
    const d = decide(null, META_REPORT);
    expect(d.policy).toBe("always");
    expect(d.notify).toBe(true);
  });

  it("[SILENT] wins over [NOTIFY] under dynamic policy", () => {
    const d = decide("dynamic", `[SILENT] nothing worth sending\n[NOTIFY]x[/NOTIFY]`);
    expect(d.notify).toBe(false);
  });
});

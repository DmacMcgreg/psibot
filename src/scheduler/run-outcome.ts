/**
 * Provider rejections reach the scheduler as *results*, not throws: the agent
 * CLI exits 0 and its final message is the error envelope. The silent-success
 * census (research/psibot-jobruns-silent-blindspot-2026-10.md, /tmp trio copy
 * 2026-10-05T06:46Z) counted 167 success-stamped rows whose result text IS a
 * provider error — this classifier is what turns them into failed runs the
 * streak counter, ops alert and watchdog can see.
 *
 * Shapes, each quoted verbatim from that census:
 * - 429 quota/rate-limit dialects: "Request rejected (429)" (job_runs
 *   10322-24) and the JSON-envelope 1302 family (8 rows).
 * - Context-window exhaustion: one exact sentence, 26 rows (2026-03-24 →
 *   2026-05-07); id 215 is the registry's oldest silent success.
 * - Auth rejection: 8 rows from the Apr 10-11 outage; the CLI prefixes its
 *   own "Failed to authenticate." ahead of the API envelope.
 * - Fallback ladder exhausted: agent/index.ts emits "[fallback: …]" ahead of
 *   the bare envelope when every tier is gone (ids 7000/7002, 529). The tag
 *   alone also precedes 64 SUCCESS results (a tier that worked), so this arm
 *   requires the envelope right after the tag.
 *
 * Every arm anchors at the start: the envelope is always the whole result
 * (zero mid-text occurrences in the census), and id 4117 — a legitimate
 * Nightly Brief whose prose mentions "(Google/Apple API errors)" — must stay
 * a success. Deliberately still unclassified: the bare 529/500/connect/400
 * families from the pre-July outage weeks (117 rows) — pinned as non-matches
 * in run-outcome.test.ts until a live specimen justifies widening again.
 */

const PROVIDER_ERROR_RESULT = [
  /^API Error: (?:Request rejected \(429\)|429\b)/,
  /^API Error: The model has reached its context window limit\./,
  /^Failed to authenticate\. API Error: 401/,
  /^\[fallback: [^\]]+\]\s*API Error: /,
];

/**
 * The result text back when it is a provider error envelope (or the fallback
 * tag ahead of one), otherwise null. Callers treat a match as a failed run.
 */
export function providerErrorResult(result: string | null | undefined): string | null {
  const text = (result ?? "").trim();
  return PROVIDER_ERROR_RESULT.some((arm) => arm.test(text)) ? text : null;
}

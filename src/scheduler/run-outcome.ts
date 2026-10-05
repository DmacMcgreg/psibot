/**
 * Provider quota/rate-limit rejections reach the scheduler as *results*, not
 * throws: the agent CLI exits 0 and its final message is a bare API-error
 * envelope. job_runs 10322-10324 (jobs 12/32/34, 2026-10-05T04:00Z) carried
 * exactly these texts behind status "success" — invisible to the watchdog and
 * the job-alerts arm, which only count "error" rows. Both phrasings below are
 * quoted from that registry window; observed codes so far are 1302 (rate
 * limit) and 1308 (usage limit). The envelope is always the whole result
 * (14 bare rows, zero mid-text occurrences in the registry), so the pattern
 * anchors at the start — a "429" inside real content never matches.
 */

const PROVIDER_QUOTA_ERROR = /^API Error: (?:Request rejected \(429\)|429\b)/;

/**
 * The result text back when it is a bare provider 429 (quota/rate-limit)
 * rejection, otherwise null. Callers treat a match as a failed run.
 */
export function providerQuotaError(result: string | null | undefined): string | null {
  const text = (result ?? "").trim();
  return PROVIDER_QUOTA_ERROR.test(text) ? text : null;
}

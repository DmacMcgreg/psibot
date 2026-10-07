/**
 * NoteplanSweepRunner — recurring NotePlan content-archival sweep.
 *
 * Mirrors DigestRunner's shape (own croner Cron, timezone, running guard).
 * Fires weekly (Sunday 03:30 America/Toronto — inside heartbeat quiet hours,
 * low-activity) and runs the two-phase archival pipeline against the NotePlan
 * pipeline folders:
 *
 *   1. `--commit`         ingest new/changed inbox, research, briefing and trash
 *                         markdown into the `noteplan_archive` table (idempotent
 *                         upsert; runaway "## Related" bloat collapsed).
 *   2. `--delete --force` retention prune: unlink on-disk files older than their
 *                         retention window whose content is provably in the DB.
 *
 * It does NOT reimplement any of that logic — it shells out to
 * scripts/archive-noteplan-content.ts (single source of truth, owned
 * elsewhere). Everything is wrapped so a sweep failure only logs and never
 * crashes the daemon.
 *
 * Retention windows (enforced inside the script):
 *   inbox     — keep pending/triaged pending_items OR mtime ≤ 14d
 *   research  — queued: archive+delete all; completed: keep mtime ≤ 30d
 *   briefings — keep mtime ≤ 14d
 *   trash     — archive+delete all
 *   queued zips — moved to ~/Documents/40_Archive/noteplan-extracted-zips/
 */

import { Cron } from "croner";
import { resolve } from "node:path";
import { createLogger } from "../shared/logger.ts";

const log = createLogger("noteplan-sweep");

/** Sunday 03:30 — quiet hours, once a week. Timezone applied via Cron options. */
const SWEEP_CRON = "30 3 * * 0";
const SWEEP_TZ = "America/Toronto";

const SCRIPT_PATH = resolve(process.cwd(), "scripts/archive-noteplan-content.ts");
/** Hard ceiling so a wedged sweep can never hang the daemon indefinitely. */
const PHASE_TIMEOUT_MS = 10 * 60 * 1000;

interface PhaseResult {
  phase: string;
  ok: boolean;
  exitCode: number | null;
  tail: string;
}

export class NoteplanSweepRunner {
  private cron: Cron | null = null;
  private running = false;

  start(): void {
    log.info("Starting NotePlan archive sweep runner", {
      pattern: SWEEP_CRON,
      timezone: SWEEP_TZ,
      script: SCRIPT_PATH,
    });
    this.cron = new Cron(SWEEP_CRON, { timezone: SWEEP_TZ }, () => {
      // Cron callbacks must never reject — runNow already swallows, but guard anyway.
      this.runNow().catch((err) =>
        log.error("NotePlan sweep run failed", { error: String(err) }),
      );
    });
  }

  stop(): void {
    if (this.cron) {
      this.cron.stop();
      this.cron = null;
      log.info("NotePlan archive sweep runner stopped");
    }
  }

  /**
   * Run the ingest-then-prune sweep. Exported for manual triggering (dashboard,
   * CLI, or a one-off). Always resolves — never throws — so a scheduled run can
   * never take down the daemon. Returns per-phase results for inspection.
   */
  async runNow(): Promise<PhaseResult[]> {
    if (this.running) {
      log.info("NotePlan sweep skipped (already running)");
      return [];
    }
    this.running = true;
    const results: PhaseResult[] = [];
    try {
      // Phase 1: ingest. Must succeed before we prune — deletion is gated on a
      // matching sha256 row existing in noteplan_archive, so if commit fails the
      // delete phase simply finds no matches and keeps the files (safe), but we
      // still short-circuit to avoid noise.
      const commit = await this.runPhase("commit", ["--commit"]);
      results.push(commit);
      if (!commit.ok) {
        log.error("NotePlan sweep: ingest phase failed, skipping prune", {
          exitCode: commit.exitCode,
        });
        return results;
      }

      // Phase 2: retention prune (live unlink + zip move).
      const prune = await this.runPhase("prune", ["--delete", "--force"]);
      results.push(prune);

      log.info("NotePlan sweep complete", {
        ingest: commit.ok ? "ok" : "failed",
        prune: prune.ok ? "ok" : "failed",
      });
      return results;
    } catch (err) {
      log.error("NotePlan sweep threw", { error: String(err) });
      return results;
    } finally {
      this.running = false;
    }
  }

  private async runPhase(phase: string, flags: string[]): Promise<PhaseResult> {
    log.info("NotePlan sweep phase starting", { phase, flags });
    const proc = Bun.spawn(["bun", "run", SCRIPT_PATH, ...flags], {
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          try {
            proc.kill("SIGKILL");
          } catch {
            /* already gone */
          }
          reject(new Error(`phase ${phase} timed out after ${PHASE_TIMEOUT_MS}ms`));
        }, PHASE_TIMEOUT_MS);
      });

      const [exitCode, stdout, stderr] = await Promise.race([
        Promise.all([
          proc.exited,
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
        ]),
        timeout,
      ]);

      const output = `${stdout}${stderr ? `\n[stderr]\n${stderr}` : ""}`.trim();
      const tail = output.split("\n").slice(-12).join("\n");
      const ok = exitCode === 0 && !timedOut;
      log[ok ? "info" : "error"]("NotePlan sweep phase finished", {
        phase,
        exitCode,
        ok,
        tail,
      });
      return { phase, ok, exitCode, tail };
    } catch (err) {
      log.error("NotePlan sweep phase errored", { phase, error: String(err) });
      return {
        phase,
        ok: false,
        exitCode: proc.exitCode ?? null,
        tail: String(err),
      };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}

/**
 * LogRotationRunner — daily rotation of the daemon's launchd logs, plus a
 * runaway-growth guard.
 *
 * launchd writes `~/.psibot/logs/psibot.out.log` and `psibot.err.log`
 * (StandardOutPath / StandardErrorPath) and holds them open, so they can't be
 * renamed away. Rotation is copy-then-truncate: gzip the file's current bytes
 * into `logs/archive/<name>.<YYYY-MM-DD>.gz`, then truncate the live file in
 * place (launchd appends, so the next line lands at the new end). Bytes
 * written between the copy and the truncate are carried over, not dropped.
 * Rotated archives older than RETAIN_DAYS are deleted.
 *
 * Why in the daemon and not a LaunchAgent: the only writer of these logs is
 * this daemon, the growth guard needs the daemon's Telegram notifier and
 * ops_state de-dupe, and a second LaunchAgent would be one more thing that
 * can silently stop. If the daemon is down, nothing grows the logs anyway.
 *
 * Schedule: a check every 15 minutes. It rotates once per local day (first
 * check after midnight America/Toronto, or right after a start that missed
 * it) and checks growth since the day's baseline. Growth over
 * GROWTH_ALERT_BYTES in one day (the 2026-09-16 triage loop wrote ~1.3 GB to
 * stdout and ~2.1 GB to stderr in a day; a normal day is under 1 MB) logs one
 * ERROR and sends one Telegram ops alert per file per day.
 *
 * Never throws; a failed rotation logs and is retried at the next check.
 */

import { Cron } from "croner";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, statSync, unlinkSync, renameSync, openSync, readSync, ftruncateSync, writeSync, closeSync, fstatSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { createLogger } from "../shared/logger.ts";
import { getOpsState, setOpsState } from "../db/queries.ts";
import { sendOpsAlert } from "../shared/ops-alerts.ts";
import { localDayAndHour } from "../scheduler/watchdog.ts";

const log = createLogger("log-rotation");

export const LOG_DIR = join(homedir(), ".psibot/logs");
export const LOG_FILES = ["psibot.out.log", "psibot.err.log"];
export const RETAIN_DAYS = 7;
export const GROWTH_ALERT_BYTES = 200 * 1024 * 1024;
const CHECK_CRON = "*/15 * * * *";
const ROTATION_STATE_KEY = "logs:last-rotation-day";

export interface RotateResult {
  file: string;
  bytes: number;
  archive: string | null;
  carriedOver: number;
}

/** `YYYY-MM-DD` of the day before `day` (a `YYYY-MM-DD` string). */
export function previousDay(day: string): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Gzip `path`'s current bytes into `archiveDir/<name>.<label>.gz`, then
 * truncate `path` in place. Streams; never loads the file into memory.
 */
export async function rotateFile(path: string, archiveDir: string, label: string): Promise<RotateResult> {
  const name = basename(path);
  if (!existsSync(path)) return { file: name, bytes: 0, archive: null, carriedOver: 0 };
  const size = statSync(path).size;
  if (size === 0) return { file: name, bytes: 0, archive: null, carriedOver: 0 };

  mkdirSync(archiveDir, { recursive: true });
  let archive = join(archiveDir, `${name}.${label}.gz`);
  for (let n = 2; existsSync(archive); n++) archive = join(archiveDir, `${name}.${label}-${n}.gz`);
  const tmp = `${archive}.partial`;

  await pipeline(createReadStream(path, { start: 0, end: size - 1 }), createGzip(), createWriteStream(tmp));
  renameSync(tmp, archive);

  // Truncate, keeping anything appended since `size` was measured. Sync and
  // back-to-back, so only lines written in the same instant could interleave.
  const fd = openSync(path, "r+");
  let carriedOver = 0;
  try {
    const now = fstatSync(fd).size;
    const tail = Buffer.alloc(Math.max(0, now - size));
    if (tail.length > 0) carriedOver = readSync(fd, tail, 0, tail.length, size);
    ftruncateSync(fd, 0);
    if (carriedOver > 0) writeSync(fd, tail, 0, carriedOver, 0);
  } finally {
    closeSync(fd);
  }
  return { file: name, bytes: size, archive, carriedOver };
}

/** Delete `<name>.<YYYY-MM-DD>[-n].gz` archives dated more than `retainDays` before `today`. */
export function pruneArchives(archiveDir: string, today: string, retainDays: number = RETAIN_DAYS): string[] {
  if (!existsSync(archiveDir)) return [];
  let oldest = today;
  for (let i = 0; i < retainDays; i++) oldest = previousDay(oldest);
  const removed: string[] = [];
  for (const f of readdirSync(archiveDir)) {
    const m = /\.(\d{4}-\d{2}-\d{2})(?:-\d+)?\.gz$/.exec(f);
    if (!m || m[1] >= oldest) continue;
    unlinkSync(join(archiveDir, f));
    removed.push(f);
  }
  return removed;
}

interface GrowthState {
  day: string;
  base: number;
  alerted?: boolean;
}

/**
 * Bytes `file` grew today (local day), from a baseline stored in ops_state.
 * A size below the baseline means the file was truncated (rotated), so the
 * baseline drops to 0. Returns growth and whether it newly crossed the limit.
 */
export function trackGrowth(name: string, size: number, day: string, limit: number = GROWTH_ALERT_BYTES): { growth: number; crossed: boolean } {
  const key = `logs:growth:${name}`;
  let state: GrowthState | null = null;
  try {
    state = JSON.parse(getOpsState(key) ?? "null") as GrowthState | null;
  } catch {
    state = null;
  }
  if (!state || state.day !== day) state = { day, base: size };
  if (size < state.base) state.base = 0;
  const growth = size - state.base;
  const crossed = growth > limit && !state.alerted;
  if (crossed) state.alerted = true;
  setOpsState(key, JSON.stringify(state));
  return { growth, crossed };
}

export class LogRotationRunner {
  private cron: Cron | null = null;
  private running = false;

  constructor(
    private readonly dir: string = LOG_DIR,
    private readonly files: string[] = LOG_FILES,
  ) {}

  start(): void {
    log.info("Starting log rotation runner", { dir: this.dir, files: this.files, retainDays: RETAIN_DAYS });
    this.cron = new Cron(CHECK_CRON, () => {
      this.check().catch((err) => log.error("Log check failed", { error: String(err) }));
    });
    // Catch up a rotation missed while the daemon was down.
    this.check().catch((err) => log.error("Log check failed", { error: String(err) }));
  }

  stop(): void {
    this.cron?.stop();
    this.cron = null;
  }

  /** Rotate if today's rotation hasn't happened, then check growth. */
  async check(now: Date = new Date()): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const { day } = localDayAndHour(now);
      const last = getOpsState(ROTATION_STATE_KEY);
      if (last === null) {
        // First run: start the daily cycle today without rotating mid-day.
        setOpsState(ROTATION_STATE_KEY, day);
      } else if (last !== day) {
        await this.rotateAll(day);
      }
      await this.checkGrowth(day);
    } finally {
      this.running = false;
    }
  }

  private async rotateAll(day: string): Promise<void> {
    const archiveDir = join(this.dir, "archive");
    const label = previousDay(day);
    for (const f of this.files) {
      try {
        const r = await rotateFile(join(this.dir, f), archiveDir, label);
        if (r.archive) log.info("Rotated log", { file: f, bytes: r.bytes, archive: r.archive, carriedOver: r.carriedOver });
      } catch (err) {
        log.error("Log rotation failed", { file: f, error: String(err) });
        return; // leave the day unmarked so the next check retries
      }
    }
    setOpsState(ROTATION_STATE_KEY, day);
    try {
      const removed = pruneArchives(archiveDir, day);
      if (removed.length > 0) log.info("Pruned rotated logs", { removed });
    } catch (err) {
      log.error("Pruning rotated logs failed", { error: String(err) });
    }
  }

  private async checkGrowth(day: string): Promise<void> {
    for (const f of this.files) {
      const path = join(this.dir, f);
      if (!existsSync(path)) continue;
      const { growth, crossed } = trackGrowth(f, statSync(path).size, day);
      if (!crossed) continue;
      const mb = Math.round(growth / (1024 * 1024));
      log.error("Log growing like a runaway loop", { file: f, grewMb: mb, limitMb: GROWTH_ALERT_BYTES / (1024 * 1024), day });
      await sendOpsAlert(
        `log-growth:${f}`,
        [
          `PsiBot log runaway: ${f}`,
          `Grew ${mb} MB today (limit ${GROWTH_ALERT_BYTES / (1024 * 1024)} MB) — something is probably looping.`,
          `Check: tail -n 50 ~/.psibot/logs/${f}`,
        ].join("\n"),
      );
    }
  }
}

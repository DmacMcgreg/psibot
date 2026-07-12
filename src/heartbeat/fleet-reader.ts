import { Database } from "bun:sqlite";
import { getConfig } from "../config.ts";
import { createLogger, type Logger } from "../shared/logger.ts";

export interface FleetEvent {
  id: number;
  ts: number;
  entity: string;
  kind: "transition" | "verb" | "proposal" | "threshold";
  fromState?: string;
  toState?: string;
  reasonClass?: "unreachable" | "health-fail" | "rss-threshold" | "disk-threshold";
  fingerprint?: string;
  alerted: 0 | 1;
  verbs: string[];
  detail: string;
}

export interface EntityStatus {
  id: string;
  kind: "app" | "frontend";
  tier: "legacy" | "kit";
  reachability: "reachable" | "unreachable" | "unknown";
  health: "pass" | "degraded" | "fail" | "pending";
  alertState: "up" | "grace" | "down" | "flapping" | "silenced";
  pid: number | null;
  rssBytes: number | null;
  cpuPct: number | null;
  mode?: "dev" | "prod" | "stopped";
  since: number;
  detail: string;
  probeError?: string;
  healthDetail?: unknown;
  manifestVersion?: string;
}

export interface FleetSnapshot {
  schemaVersion: number;
  generatedAtMs: number;
  pollIntervalMs: number;
  hostId: string;
  entities: EntityStatus[];
  approvals: {
    pending: number;
    oldestMs?: number;
    vaultReachable: boolean;
    approvalsSource?: "e7-t06" | "none";
  };
  pool: { active: "claude" | "claude-glm"; quota?: unknown };
  pollDurationMs: number;
  pollErrors: string[];
}

const READER_SCHEMA_VERSION = 1;

let logger: Logger | undefined;
let wasMissing = true;

function log(): Logger {
  if (!logger) logger = createLogger("heartbeat.fleet-reader");
  return logger;
}

export function openFleetDbReadOnly(): Database | null {
  try {
    const db = new Database(getConfig().HUB_FLEET_DB, { readonly: true });
    if (wasMissing) log().debug("fleet.db became readable");
    wasMissing = false;
    return db;
  } catch (error) {
    if (!wasMissing) {
      log().debug("fleet.db became unavailable", { error: String(error) });
    }
    wasMissing = true;
    return null;
  }
}

function parseVerbs(value: unknown): string[] {
  if (typeof value !== "string") return [];

  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((verb): verb is string => typeof verb === "string")
      ? parsed
      : [];
  } catch {
    return [];
  }
}

interface FleetEventRow {
  id: number;
  ts: number;
  entity: string;
  kind: FleetEvent["kind"];
  fromState: string | null;
  toState: string | null;
  reasonClass: FleetEvent["reasonClass"] | null;
  fingerprint: string | null;
  alerted: number;
  verbs: string;
  detail: string;
}

export function readAlertedEventsSince(watermark: number, limit = 100): FleetEvent[] {
  const db = openFleetDbReadOnly();
  if (!db) return [];

  try {
    const rows = db
      .prepare<FleetEventRow, [number, number]>(
        `SELECT id, ts, entity_id AS entity, kind, from_state AS fromState,
                to_state AS toState, reason_class AS reasonClass, fingerprint,
                alerted, verbs, detail
           FROM events
          WHERE alerted = 1 AND id > ?
          ORDER BY id ASC LIMIT ?`,
      )
      .all(watermark, limit);

    return rows.map((row) => ({
      id: row.id,
      ts: row.ts,
      entity: row.entity,
      kind: row.kind,
      ...(row.fromState === null ? {} : { fromState: row.fromState }),
      ...(row.toState === null ? {} : { toState: row.toState }),
      ...(row.reasonClass === null ? {} : { reasonClass: row.reasonClass }),
      ...(row.fingerprint === null ? {} : { fingerprint: row.fingerprint }),
      alerted: row.alerted === 1 ? 1 : 0,
      verbs: parseVerbs(row.verbs),
      detail: row.detail,
    }));
  } catch (error) {
    log().warn("fleet event query failed", { error: String(error) });
    return [];
  } finally {
    try {
      db.close();
    } catch (error) {
      log().debug("fleet reader close failed", { error: String(error) });
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isAlertState(value: unknown): value is EntityStatus["alertState"] {
  return value === "up" || value === "grace" || value === "down" ||
    value === "flapping" || value === "silenced";
}

function isValidFleetSnapshot(value: unknown): value is FleetSnapshot {
  if (!isRecord(value)) return false;
  if (!isFiniteNumber(value.generatedAtMs)) return false;

  const pollIntervalMs = value.pollIntervalMs;
  if (pollIntervalMs !== undefined &&
      (!isFiniteNumber(pollIntervalMs) || pollIntervalMs < 0)) {
    return false;
  }

  if (!Array.isArray(value.entities)) return false;
  for (const entity of value.entities) {
    if (!isRecord(entity) || !isAlertState(entity.alertState)) return false;
  }

  const approvals = value.approvals;
  if (!isRecord(approvals) || !isFiniteNumber(approvals.pending)) return false;

  return true;
}

function getSnapshotSchemaVersion(snapshot: Record<string, unknown>): number | null {
  const value = snapshot.schemaVersion;
  if (value === undefined) return READER_SCHEMA_VERSION;
  if (!isFiniteNumber(value) || !Number.isInteger(value) || value < 1) return null;
  return value;
}

export function readLatestSnapshot(): FleetSnapshot | null {
  const db = openFleetDbReadOnly();
  if (!db) return null;

  try {
    const row = db
      .prepare<{ json: string }, []>(
        "SELECT json FROM snapshots ORDER BY ts DESC LIMIT 1",
      )
      .get();
    if (!row) return null;

    const parsed: unknown = JSON.parse(row.json);
    if (!isRecord(parsed)) {
      throw new Error("snapshot failed runtime shape validation");
    }

    const schemaVersion = getSnapshotSchemaVersion(parsed);
    if (schemaVersion === null) {
      throw new Error("snapshot schemaVersion is not a positive integer");
    }
    if (schemaVersion > READER_SCHEMA_VERSION) {
      log().warn(`snapshot schema v${schemaVersion} > reader v${READER_SCHEMA_VERSION}`);
      return null;
    }

    if (!isValidFleetSnapshot(parsed)) {
      throw new Error(
        "snapshot failed runtime shape validation (generatedAtMs/pollIntervalMs/entities[].alertState/approvals.pending)",
      );
    }
    return parsed;
  } catch (error) {
    log().warn("fleet snapshot parse/query failed", { error: String(error) });
    return null;
  } finally {
    try {
      db.close();
    } catch (error) {
      log().debug("fleet reader close failed", { error: String(error) });
    }
  }
}

export function renderFleetEvent(event: FleetEvent): string {
  const escape = (value: string): string =>
    value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const entity = escape(event.entity);
  const detail = escape(event.detail);
  if (event.kind === "transition" && event.toState === "down") {
    return `🔴 <b>${entity}</b> DOWN — ${detail}`;
  }
  if (event.kind === "transition" && event.fromState === "down" && event.toState === "up") {
    return `✅ <b>${entity}</b> recovered — ${detail}`;
  }
  if (event.kind === "transition" && event.toState === "flapping") {
    return `⚠️ <b>${entity}</b> flapping — ${detail}`;
  }
  return `ℹ️ <b>${entity}</b> ${escape(event.kind)}: ${detail}`;
}

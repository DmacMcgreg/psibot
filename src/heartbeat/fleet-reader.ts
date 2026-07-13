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

export interface FleetProposal {
  id: string;
  ts: number;
  entity: string;
  verb: string;
  args: string | null;
  rationale: string;
  status: "pending";
}

const READER_SCHEMA_VERSION = 1;
const EVENT_SCAN_PAGE_SIZE = 50;
const MAX_EVENT_SCAN_ROWS = 500;

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
  id: unknown;
  ts: unknown;
  entity: unknown;
  kind: unknown;
  fromState: string | null;
  toState: string | null;
  reasonClass: FleetEvent["reasonClass"] | null;
  fingerprint: string | null;
  alerted: number;
  verbs: unknown;
  detail: unknown;
}

function isFleetEventKind(value: unknown): value is FleetEvent["kind"] {
  return value === "transition" || value === "verb" || value === "proposal" || value === "threshold";
}

function parseFleetEventRow(row: FleetEventRow): FleetEvent | null {
  const invalidFields: string[] = [];
  if (typeof row.id !== "number" || !Number.isSafeInteger(row.id) || row.id < 0) invalidFields.push("id");
  if (typeof row.ts !== "number" || !Number.isSafeInteger(row.ts) || row.ts < 0) invalidFields.push("ts");
  if (typeof row.entity !== "string") invalidFields.push("entity");
  if (!isFleetEventKind(row.kind)) invalidFields.push("kind");
  if (typeof row.detail !== "string") invalidFields.push("detail");
  const verbs = parseVerbs(row.verbs);

  if (invalidFields.length > 0 || typeof row.id !== "number" ||
      typeof row.ts !== "number" || typeof row.entity !== "string" ||
      !isFleetEventKind(row.kind) || typeof row.detail !== "string") {
    log().warn("Skipping malformed fleet event row", {
      eventId: typeof row.id === "number" || typeof row.id === "string" ? row.id : null,
      invalidFields,
    });
    return null;
  }

  return {
    id: row.id,
    ts: row.ts,
    entity: row.entity,
    kind: row.kind,
    ...(row.fromState === null ? {} : { fromState: row.fromState }),
    ...(row.toState === null ? {} : { toState: row.toState }),
    ...(row.reasonClass === null ? {} : { reasonClass: row.reasonClass }),
    ...(row.fingerprint === null ? {} : { fingerprint: row.fingerprint }),
    alerted: row.alerted === 1 ? 1 : 0,
    verbs,
    detail: row.detail,
  };
}

export interface FleetEventBatch {
  events: FleetEvent[];
  maxScannedId: number;
}

export function readAlertedEventBatchSince(watermark: number, limit = 100): FleetEventBatch {
  const safeWatermark = Number.isSafeInteger(watermark) && watermark >= 0 ? watermark : 0;
  const deliverableLimit = Number.isSafeInteger(limit) && limit > 0
    ? Math.min(limit, MAX_EVENT_SCAN_ROWS)
    : 0;
  const batch: FleetEventBatch = { events: [], maxScannedId: safeWatermark };
  if (deliverableLimit === 0) return batch;

  const db = openFleetDbReadOnly();
  if (!db) return batch;

  try {
    const statement = db.prepare<FleetEventRow, [number, number]>(
      `SELECT id, ts, entity_id AS entity, kind, from_state AS fromState,
              to_state AS toState, reason_class AS reasonClass, fingerprint,
              alerted, verbs, detail
         FROM events
        WHERE alerted = 1 AND id > ?
        ORDER BY id ASC LIMIT ?`,
    );
    let scannedRows = 0;

    while (batch.events.length < deliverableLimit && scannedRows < MAX_EVENT_SCAN_ROWS) {
      const pageLimit = Math.min(EVENT_SCAN_PAGE_SIZE, MAX_EVENT_SCAN_ROWS - scannedRows);
      const rows = statement.all(batch.maxScannedId, pageLimit);
      if (rows.length === 0) break;

      const pageStartId = batch.maxScannedId;
      for (const row of rows) {
        scannedRows++;
        const rowId = typeof row.id === "number" && Number.isSafeInteger(row.id) && row.id >= 0
          ? row.id
          : null;
        const event = parseFleetEventRow(row);
        if (rowId === null) continue;

        batch.maxScannedId = rowId;
        if (event) batch.events.push(event);
        if (batch.events.length === deliverableLimit) break;
      }

      if (batch.events.length === deliverableLimit) break;
      if (batch.maxScannedId === pageStartId) {
        log().warn("Fleet event scan halted because a page had no safe cursor IDs", { scannedRows });
        break;
      }
      if (rows.length < pageLimit) break;
    }
    return batch;
  } catch (error) {
    log().warn("fleet event query failed", { error: String(error) });
    return batch;
  } finally {
    try {
      db.close();
    } catch (error) {
      log().debug("fleet reader close failed", { error: String(error) });
    }
  }
}

export function readAlertedEventsSince(watermark: number, limit = 100): FleetEvent[] {
  return readAlertedEventBatchSince(watermark, limit).events;
}

interface FleetProposalRow {
  id: unknown;
  ts: unknown;
  entity: unknown;
  verb: unknown;
  args: unknown;
  rationale: unknown;
  status: unknown;
}

const FLEET_PROPOSAL_TTL_MS = 24 * 60 * 60 * 1_000;

/**
 * Read live pending proposals from a fresh read-only handle. This surface is
 * deliberately query-only; proposal decisions always go through hub-edge.
 */
export function readPendingFleetProposals(
  nowMs = Date.now(),
  openDb: typeof openFleetDbReadOnly = openFleetDbReadOnly,
): FleetProposal[] {
  const db = openDb();
  if (!db) return [];

  try {
    const rows = db.prepare<FleetProposalRow, [number]>(
      `SELECT id, ts, entity_id AS entity, verb, args, rationale, status
         FROM proposals
        WHERE status = 'pending' AND ts > ?
        ORDER BY ts ASC, id ASC`,
    ).all(nowMs - FLEET_PROPOSAL_TTL_MS);

    const proposals: FleetProposal[] = [];
    for (const row of rows) {
      if (
        typeof row.id !== "string" ||
        typeof row.ts !== "number" || !Number.isSafeInteger(row.ts) || row.ts < 0 ||
        typeof row.entity !== "string" ||
        typeof row.verb !== "string" ||
        (row.args !== null && typeof row.args !== "string") ||
        typeof row.rationale !== "string" ||
        row.status !== "pending"
      ) {
        log().warn("Skipping malformed fleet proposal row", {
          proposalId: typeof row.id === "string" ? row.id : null,
        });
        continue;
      }
      proposals.push({
        id: row.id,
        ts: row.ts,
        entity: row.entity,
        verb: row.verb,
        args: row.args,
        rationale: row.rationale,
        status: "pending",
      });
    }
    return proposals;
  } catch (error) {
    log().warn("fleet proposal query failed", { error: String(error) });
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

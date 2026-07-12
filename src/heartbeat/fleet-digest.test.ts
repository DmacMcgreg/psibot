import { describe, expect, test } from "bun:test";
import { buildFleetDigestLines } from "./index.ts";
import type { EntityStatus, FleetSnapshot } from "./fleet-reader.ts";

function makeSnapshot(
  overrides: Partial<Pick<FleetSnapshot, "generatedAtMs" | "entities" | "approvals">> = {},
): FleetSnapshot {
  return {
    schemaVersion: 1,
    generatedAtMs: 1_000,
    pollIntervalMs: 1_000,
    hostId: "test-host",
    entities: [],
    approvals: {
      pending: 0,
      vaultReachable: true,
      approvalsSource: "e7-t06",
    },
    pool: { active: "claude" },
    pollDurationMs: 1,
    pollErrors: [],
    ...overrides,
  };
}

function entity(id: string, alertState: EntityStatus["alertState"]): EntityStatus {
  return {
    id,
    kind: "app",
    tier: "legacy",
    reachability: "reachable",
    health: "pass",
    alertState,
    pid: null,
    rssBytes: null,
    cpuPct: null,
    since: 1_000,
    detail: "test",
  };
}

describe("buildFleetDigestLines", () => {
  test("omits Fleet entirely when no snapshot is available", () => {
    expect(buildFleetDigestLines(null)).toEqual([]);
  });

  test("renders a fresh all-up summary without an empty approvals claim", () => {
    const snapshot = makeSnapshot({
      entities: [entity("hub-core", "up"), entity("psibot", "up")],
    });

    expect(buildFleetDigestLines(snapshot)).toEqual([
      "Fleet: 2/2 up",
    ]);
  });

  test("renders escaped not-up ids and a known pending approval count", () => {
    const snapshot = makeSnapshot({
      entities: [entity("hub<core>", "down"), entity("psibot", "up")],
      approvals: {
        pending: 2,
        vaultReachable: true,
        approvalsSource: "e7-t06",
      },
    });

    expect(buildFleetDigestLines(snapshot)).toEqual([
      "Fleet: 1 of 2 not up (hub&lt;core&gt;)",
      "Approvals pending: 2",
    ]);
  });

  test("uses the exact summary template even when the cached snapshot is stale", () => {
    const snapshot = makeSnapshot({
      generatedAtMs: 1_000,
      entities: [entity("hub-core", "up")],
      approvals: {
        pending: 0,
        vaultReachable: true,
        approvalsSource: "none",
      },
    });

    expect(buildFleetDigestLines(snapshot)).toEqual([
      "Fleet: 1/1 up",
    ]);
  });

  test("does not render pool or quota data in the E2 digest fold", () => {
    const snapshot = makeSnapshot({
      entities: [entity("hub-core", "up")],
    });

    expect(buildFleetDigestLines(snapshot).join("\n")).not.toContain("Pool");
  });
});

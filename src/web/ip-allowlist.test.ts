import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import * as sqliteVec from "sqlite-vec";
import type { Server } from "bun";
import { MIGRATIONS } from "../db/schema.ts";
import { setDbForTesting } from "../db/index.ts";
import { loadConfig } from "../config.ts";
import { createWebApp } from "./index.ts";

/**
 * Dashboard + Mini App IP allowlist. The client IP comes from the socket peer;
 * X-Forwarded-For counts only when that peer is loopback (tailscale serve).
 * Regression: a direct LAN request with no headers — or with a forged
 * X-Forwarded-For: 127.0.0.1 — used to pass as localhost.
 */

/** Stands in for Bun's Server as Hono's env: reports `address` as the socket peer. */
const peer = (address: string) => ({
  requestIP: () => ({ address, family: address.includes(":") ? "IPv6" : "IPv4", port: 50_000 }),
});

const LAN = "192.168.1.50";
const FORGED = { "x-forwarded-for": "127.0.0.1", "x-real-ip": "127.0.0.1" };

let db: Database;
let app: ReturnType<typeof createWebApp>;

beforeAll(() => {
  db = new Database(":memory:");
  sqliteVec.load(db);
  for (const sql of MIGRATIONS) db.exec(sql);
  setDbForTesting(db);
  loadConfig();
  app = createWebApp({
    agent: {} as never,
    memory: {} as never,
    triggerJob: () => {},
    reloadScheduler: () => {},
  });
});

afterAll(() => db.close());

describe("dashboard", () => {
  it("403s a LAN peer that sends no forwarding headers", async () => {
    expect((await app.request("/", {}, peer(LAN))).status).toBe(403);
  });

  it("403s a LAN peer that forges X-Forwarded-For / X-Real-IP: 127.0.0.1", async () => {
    expect((await app.request("/", { headers: FORGED }, peer(LAN))).status).toBe(403);
  });

  it("403s when the socket peer is unknown instead of assuming localhost", async () => {
    expect((await app.request("/")).status).toBe(403);
  });

  it("allows a loopback peer", async () => {
    expect((await app.request("/", {}, peer("127.0.0.1"))).status).toBe(302);
  });
});

describe("Mini App API without Telegram initData", () => {
  it("401s a LAN peer, forged headers or not", async () => {
    expect((await app.request("/tma/api/logs", { headers: FORGED }, peer(LAN))).status).toBe(401);
  });

  it("allows a loopback peer", async () => {
    expect((await app.request("/tma/api/logs", {}, peer("127.0.0.1"))).status).toBe(200);
  });
});

describe("over a real loopback socket (the tailscale serve path)", () => {
  // Bun.serve hands itself to fetch as Hono's env — the same wiring as src/index.ts.
  let server: Server<undefined>;
  beforeAll(() => {
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
  });
  afterAll(() => server.stop(true));

  const status = async (headers: Record<string, string> = {}) =>
    (await fetch(`http://127.0.0.1:${server.port}/`, { headers, redirect: "manual" })).status;

  it("allows a direct local request", async () => {
    expect(await status()).toBe(302);
  });

  it("allows a tailnet client the proxy forwarded", async () => {
    expect(await status({ "x-forwarded-for": "100.87.28.23" })).toBe(302);
  });

  it("403s a non-tailnet client, judged by the hop the proxy added", async () => {
    expect(await status({ "x-forwarded-for": "8.8.8.8" })).toBe(403);
    // A client-prepended loopback hop does not override the proxy's own entry.
    expect(await status({ "x-forwarded-for": "127.0.0.1, 8.8.8.8" })).toBe(403);
  });
});

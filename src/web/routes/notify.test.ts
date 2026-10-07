import { describe, it, expect, beforeAll, beforeEach, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import * as sqliteVec from "sqlite-vec";
import { mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "bun";
import { MIGRATIONS } from "../../db/schema.ts";
import { setDbForTesting } from "../../db/index.ts";
import { deleteOpsState } from "../../db/queries.ts";
import { loadConfig } from "../../config.ts";
import { sendTelegramDm, type DmBot } from "../../shared/ops-alerts.ts";
import { createWebApp } from "../index.ts";
import { ensureNotifyToken, NOTIFY_LINK_ORIGIN } from "./notify.ts";

/**
 * POST /api/notify through the real web app (allowlist middleware included)
 * and the real DM path (sendTelegramDm), with only Telegram's API faked.
 */

const peer = (address: string) => ({
  requestIP: () => ({ address, family: address.includes(":") ? "IPv6" : "IPv4", port: 50_000 }),
});
const LOOPBACK = peer("127.0.0.1");
const TAILNET = peer("100.87.28.23");
const DAVID = 111;

type Sent = { chatId: number; text: string; opts: Record<string, unknown> };
let sent: Sent[];
let telegramFails = false;
const fakeBot: DmBot = {
  api: {
    sendMessage: async (chatId: number, text: string, opts: Record<string, unknown>) => {
      if (telegramFails) throw new Error("Bad Gateway");
      sent.push({ chatId, text, opts });
      return { message_id: 9000 + sent.length };
    },
  },
};

let db: Database;
let dir: string;
let tokenPath: string;
let token: string;
let clock: Date;
let app: ReturnType<typeof createWebApp>;

beforeAll(() => {
  db = new Database(":memory:");
  sqliteVec.load(db);
  for (const sql of MIGRATIONS) db.exec(sql);
  setDbForTesting(db);
  loadConfig();
  dir = mkdtempSync(join(tmpdir(), "notify-test-"));
  tokenPath = join(dir, "data", "notify-token");
  ensureNotifyToken(tokenPath);
  token = readFileSync(tokenPath, "utf8").trim();
  app = createWebApp({
    agent: {} as never,
    memory: {} as never,
    triggerJob: () => {},
    reloadScheduler: () => {},
    notify: {
      tokenPath,
      send: (html) => sendTelegramDm(fakeBot, [DAVID], html, { parseMode: "HTML", source: "fleet-digest" }),
      now: () => clock,
    },
  });
});

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  sent = [];
  telegramFails = false;
  clock = new Date("2026-10-08T12:00:00Z"); // 08:00 in Ottawa
  deleteOpsState("notify:daily");
});

const body = (over: Record<string, unknown> = {}) => ({
  title: "Fleet · Wed Oct 8",
  text: "Income US$110/mo · Broken 2 · Only you 3 (45 min)\n1. Check <Google Ads> & spend",
  links: [{ label: "All of Now", url: `${NOTIFY_LINK_ORIGIN}/v2/now?x=1&y=2` }],
  ...over,
});

const post = (payload: unknown, opts: { auth?: string | null; env?: object; headers?: Record<string, string> } = {}) => {
  const headers: Record<string, string> = { ...opts.headers };
  const auth = opts.auth === undefined ? `Bearer ${token}` : opts.auth;
  if (auth !== null) headers.authorization = auth;
  return app.request(
    "/api/notify",
    { method: "POST", headers, body: typeof payload === "string" ? payload : JSON.stringify(payload) },
    opts.env ?? LOOPBACK,
  );
};

describe("token file", () => {
  it("is 32 random bytes (hex), mode 0600, and kept across boots", () => {
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(statSync(tokenPath).mode & 0o777).toBe(0o600);
    ensureNotifyToken(tokenPath);
    expect(readFileSync(tokenPath, "utf8").trim()).toBe(token);
  });
});

describe("refusals", () => {
  it("403s a tailnet peer even with the right token", async () => {
    expect((await post(body(), { env: TAILNET })).status).toBe(403);
  });

  it("403s a LAN peer (the dashboard allowlist stops it first)", async () => {
    expect((await post(body(), { env: peer("192.168.1.50") })).status).toBe(403);
  });

  it("403s a loopback peer that a proxy forwarded (tailscale serve)", async () => {
    expect((await post(body(), { headers: { "x-forwarded-for": "100.87.28.23" } })).status).toBe(403);
  });

  it("401s a missing or wrong bearer", async () => {
    expect((await post(body(), { auth: null })).status).toBe(401);
    expect((await post(body(), { auth: `Bearer ${"0".repeat(64)}` })).status).toBe(401);
    expect((await post(body(), { auth: token })).status).toBe(401);
  });

  it("401s every call once the token file is deleted", async () => {
    const saved = readFileSync(tokenPath, "utf8");
    unlinkSync(tokenPath);
    try {
      expect((await post(body())).status).toBe(401);
    } finally {
      writeFileSync(tokenPath, saved, { mode: 0o600 });
    }
  });

  it("422s a link whose origin is not the tailnet Studio", async () => {
    for (const url of [
      "http://127.0.0.1:4890/v2/now",
      "https://100.110.54.112:4890/v2/now",
      "http://100.110.54.112:4891/v2/now",
      "http://100.110.54.112:4890@evil.example/v2/now",
      "javascript:alert(1)",
    ]) {
      const res = await post(body({ links: [{ label: "x", url }] }));
      expect(res.status).toBe(422);
    }
    expect(sent).toHaveLength(0);
  });

  it("400s a malformed body", async () => {
    expect((await post("not json")).status).toBe(400);
    expect((await post(body({ title: "t".repeat(81) }))).status).toBe(400);
    expect((await post(body({ text: "t".repeat(3501) }))).status).toBe(400);
    const nine = Array.from({ length: 9 }, (_, i) => ({ label: `l${i}`, url: `${NOTIFY_LINK_ORIGIN}/v2/` }));
    expect((await post(body({ links: nine }))).status).toBe(400);
    expect(sent).toHaveLength(0);
  });
});

describe("a valid call", () => {
  it("sends one HTML DM with escaped text and <a href> links, and returns its message id", async () => {
    const res = await post(body());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, messageId: 9001 });

    expect(sent).toHaveLength(1);
    expect(sent[0].chatId).toBe(DAVID);
    expect(sent[0].opts.parse_mode).toBe("HTML");
    expect(sent[0].text).toBe(
      "<b>Fleet · Wed Oct 8</b>\n\n" +
        "Income US$110/mo · Broken 2 · Only you 3 (45 min)\n1. Check &lt;Google Ads&gt; &amp; spend\n\n" +
        `<a href="${NOTIFY_LINK_ORIGIN}/v2/now?x=1&amp;y=2">All of Now</a>`,
    );

    const row = db.query("SELECT source, message_id FROM sent_messages").get() as { source: string; message_id: number };
    expect(row).toEqual({ source: "fleet-digest", message_id: 9001 });
  });

  it("accepts the acceptance curl's shape (no links, no content-type)", async () => {
    const res = await post({ title: "test", text: "digest test", links: [] });
    expect(res.status).toBe(200);
    expect(sent[0].text).toBe("<b>test</b>\n\ndigest test");
  });
});

describe("daily cap (Ottawa day)", () => {
  it("429s the seventh send in one Ottawa day and resets after Ottawa midnight", async () => {
    for (let i = 0; i < 6; i++) expect((await post(body())).status).toBe(200);
    expect((await post(body())).status).toBe(429);
    expect(sent).toHaveLength(6);

    // 03:59Z on Oct 9 is still 23:59 Oct 8 in Ottawa.
    clock = new Date("2026-10-09T03:59:00Z");
    expect((await post(body())).status).toBe(429);
    clock = new Date("2026-10-09T04:01:00Z");
    expect((await post(body())).status).toBe(200);
  });

  it("does not spend a slot when Telegram refuses the send", async () => {
    telegramFails = true;
    expect((await post(body())).status).toBe(502);
    telegramFails = false;
    for (let i = 0; i < 6; i++) expect((await post(body())).status).toBe(200);
    expect((await post(body())).status).toBe(429);
  });
});

describe("over a real loopback socket", () => {
  let server: Server<undefined>;
  beforeAll(() => {
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
  });
  afterAll(() => server.stop(true));

  const call = (headers: Record<string, string>) =>
    fetch(`http://127.0.0.1:${server.port}/api/notify`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, ...headers },
      body: JSON.stringify({ title: "test", text: "digest test", links: [] }),
    });

  it("sends for a direct local caller", async () => {
    expect((await call({})).status).toBe(200);
    expect(sent).toHaveLength(1);
  });

  it("403s a tailnet client the proxy forwarded", async () => {
    expect((await call({ "x-forwarded-for": "100.87.28.23" })).status).toBe(403);
    expect(sent).toHaveLength(0);
  });
});

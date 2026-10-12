import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalDeciderClient } from "./local-decider.ts";
import { noul } from "./jev.ts";

test("scores uncached payloads once, then serves the disk cache", async () => {
  let calls = 0;
  const runner = async (payloads: unknown[]) => {
    calls += payloads.length;
    return payloads.map(() => ({ answers: { q: { type: "noul", noul: 0.7 } }, model: "decider-test", usage: { input_tokens: 5 } }));
  };
  const client = new LocalDeciderClient({ cacheDir: mkdtempSync(join(tmpdir(), "ld-")), runner: runner as never });
  const payload = { state: { a: 1 }, questions: { q: noul("is it?") } };

  const first = await client.askMany([payload]);
  const second = await client.ask(payload);

  expect(first[0] instanceof Error ? "error" : first[0].source).toBe("live");
  expect(second.source).toBe("cache");
  expect(second.answers.q.noul).toBe(0.7);
  expect(calls).toBe(1);
});

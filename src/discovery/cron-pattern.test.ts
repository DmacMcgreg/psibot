import { describe, expect, test } from "bun:test";
import { Cron } from "croner";
import { DiscoveryRunner } from "./index.ts";

// Decollision regression (research/psibot-channel-rot-census-2026-10.md): the
// default pattern 0-every-N-hours pins one daily fire to 00:00 local (04:00Z),
// the window the census measured at 287-296 channel errors every night. An
// explicit cronPattern must be resolved, held, and armed in croner — not
// silently replaced by the midnight-aligned default.

/** Deps satisfying every config-backed field so the constructor never calls getConfig(). */
function makeDeps(cronPattern?: string) {
  return {
    getBot: () => null,
    defaultChatIds: [],
    intervalHours: 6,
    quietStart: 23,
    quietEnd: 7,
    maxProcessPerRun: 3,
    maxSearchCallsPerRun: 2,
    cronPattern,
  };
}

describe("DiscoveryRunner cron pattern decollision", () => {
  test("resolves and holds the offset pattern instead of the midnight-aligned default", () => {
    const runner = new DiscoveryRunner(makeDeps("30 */6 * * *"));
    expect(runner.resolvedCronPattern()).toBe("30 */6 * * *");
  });

  test("unset pattern keeps the midnight-aligned default unchanged", () => {
    const runner = new DiscoveryRunner(makeDeps(undefined));
    expect(runner.resolvedCronPattern()).toBe("0 */6 * * *");
  });

  test("nextFireAt() is null before start()", () => {
    const runner = new DiscoveryRunner(makeDeps("30 */6 * * *"));
    expect(runner.nextFireAt()).toBeNull();
  });

  test("start() arms croner on the offset pattern: next fire sits on the :30 offset, not the hour", () => {
    const runner = new DiscoveryRunner(makeDeps("30 */6 * * *"));
    runner.start();
    const next = runner.nextFireAt();
    runner.stop();
    expect(next).toBeInstanceOf(Date);
    if (!(next instanceof Date)) return;
    expect(next.getMinutes()).toBe(30);
    expect(next.getHours() % 6).toBe(0);
    // Cross-check against croner itself: the armed schedule must be the
    // override, and the midnight-aligned default must land on the hour.
    expect(new Cron("30 */6 * * *").nextRun()?.getTime()).toBe(next.getTime());
    expect(new Cron("0 */6 * * *").nextRun()?.getMinutes()).toBe(0);
  });
});

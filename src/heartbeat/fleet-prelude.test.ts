import { describe, expect, test } from "bun:test";
import { HeartbeatRunner } from "./index.ts";

interface PreludeTestRunner {
  tick(): Promise<void>;
  fleetPreludeTick(): Promise<void>;
  phaseFleetAlerts(): Promise<void>;
  phaseFleetStaleness(): Promise<void>;
  isQuietHours(): boolean;
}

describe("Fleet prelude cadence", () => {
  test("same-boundary sequential callbacks run staleness once and the next slot runs normally", async () => {
    for (const first of ["heartbeat", "dedicated"] as const) {
      let nowMs = 3 * 60_000;
      let alertRuns = 0;
      let stalenessRuns = 0;
      const runner = new HeartbeatRunner({
        getBot: () => null,
        defaultChatIds: [],
        config: {
          intervalMinutes: 30,
          fleetPreludeIntervalMinutes: 3,
          quietStart: 0,
          quietEnd: 0,
        },
        memory: {} as never,
        now: () => nowMs,
      });
      const testRunner = runner as unknown as PreludeTestRunner;
      testRunner.phaseFleetAlerts = async () => { alertRuns++; };
      testRunner.phaseFleetStaleness = async () => { stalenessRuns++; };
      testRunner.isQuietHours = () => true;

      if (first === "heartbeat") {
        await testRunner.tick();
        await testRunner.fleetPreludeTick();
      } else {
        await testRunner.fleetPreludeTick();
        await testRunner.tick();
      }

      expect(alertRuns).toBe(1);
      expect(stalenessRuns).toBe(1);

      nowMs += 3 * 60_000;
      await testRunner.fleetPreludeTick();

      expect(alertRuns).toBe(2);
      expect(stalenessRuns).toBe(2);
    }
  });
});

import { describe, it, expect, afterAll } from "bun:test";
import { scoreBatch, setAskForTesting } from "./common.ts";

afterAll(() => setAskForTesting(null));

describe("feed scoring rubric", () => {
  it("anchors paid work above tooling and caps generic packs at 70", async () => {
    let prompt = "";
    setAskForTesting(async (p) => { prompt = p; return []; });
    await scoreBatch({ instructions: "Items are test items." }, [{ title: "x" }]);
    expect(prompt).toContain("85–90 (up to 100 only for an exceptional fit): a winnable open bid, RFP or grant");
    expect(prompt).toContain("warm lead with a named contact and a deadline");
    expect(prompt).toContain("70–80: a dataset or technique that directly powers a paid Cloud Nexus offer");
    expect(prompt).toContain("$2,260");
    expect(prompt).toContain("Cap generic skill and tool packs at 70");
    expect(prompt).toContain("0–39: drop.");
    expect(prompt).not.toContain("65–84: strong fit");
  });
});

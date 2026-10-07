import { describe, it, expect } from "bun:test";
import { scoreGate, cosine, keywordPoints, buildAnchors, gateText, vecToB64, b64ToVec, GATE, type Anchor } from "./gate.ts";
import { parseGoals } from "./goals.ts";

// Unit vectors on a 4-d toy space: axis 0 = marketing, 1 = video, 2 = noise, 3 = unrelated.
const v = (...xs: number[]) => Float32Array.from(xs);
const anchors: { anchor: Anchor; vec: Float32Array }[] = [
  { anchor: { track: "marketing", kind: "track", text: "" }, vec: v(1, 0, 0, 0) },
  { anchor: { track: "marketing", kind: "clause", text: "" }, vec: v(0.9, 0.1, 0, 0) },
  { anchor: { track: "video", kind: "track", text: "" }, vec: v(0, 1, 0, 0) },
  { anchor: { track: "video", kind: "clause", text: "" }, vec: v(0.1, 0.9, 0, 0) },
  { anchor: { track: null, kind: "noise", text: "" }, vec: v(0, 0, 1, 0) },
];

describe("cosine", () => {
  it("is 1 for parallel, 0 for orthogonal, 0 for zero vectors", () => {
    expect(cosine([1, 2], [2, 4])).toBeCloseTo(1);
    expect(cosine([1, 0], [0, 1])).toBe(0);
    expect(cosine([0, 0], [1, 1])).toBe(0);
  });
});

describe("scoreGate", () => {
  it("picks the closest track and passes a strong match", () => {
    const d = scoreGate(v(0.95, 0.05, 0, 0.1), anchors, "plain text");
    expect(d.track).toBe("marketing");
    expect(d.pass).toBe(true);
    expect(d.score).toBe(100);
  });

  it("fails items nearer the noise anchors than any track", () => {
    const d = scoreGate(v(0.3, 0.2, 0.9, 0), anchors, "election news");
    expect(d.pass).toBe(false);
    expect(d.score).toBe(0);
  });

  it("adds keyword points to the matching track", () => {
    // sim ≈ 0.62 lands mid-scale, so keywords decide the track and the pass.
    const x = v(0.62, 0.6, 0, 0.5);
    const plain = scoreGate(x, anchors, "nothing special");
    const boosted = scoreGate(x, anchors, "ffmpeg speed ramp for drone footage with DaVinci Resolve");
    expect(boosted.track).toBe("video");
    expect(boosted.score).toBeGreaterThan(plain.score);
    expect(boosted.kw).toBe(GATE.KW_CAP);
  });

  it("lets explicit items through above the lower floor only", () => {
    const mid = v(0.55, 0, 0, 0.83); // sim ~0.55 → ~20 points
    const auto = scoreGate(mid, anchors, "x");
    const chosen = scoreGate(mid, anchors, "x", true);
    expect(auto.pass).toBe(false);
    expect(chosen.pass).toBe(auto.score >= GATE.EXPLICIT_FLOOR);
    const offGoal = scoreGate(v(0, 0, 1, 0), anchors, "x", true);
    expect(offGoal.pass).toBe(false);
  });

  it("track weight breaks ties toward heavier tracks", () => {
    const tie = v(0.7, 0.7, 0, 0.1);
    expect(scoreGate(tie, anchors, "x", false, { marketing: 3, video: 1 }).track).toBe("marketing");
    expect(scoreGate(tie, anchors, "x", false, { marketing: 1, video: 3 }).track).toBe("video");
  });
});

describe("keywordPoints", () => {
  it("counts distinct track terms and asset markers with caps", () => {
    const k = keywordPoints("RFP tender closing date Oct 3; npx skills add foo/bar; github.com/a/b");
    expect(k.perTrack.bids).toBeGreaterThanOrEqual(2 * GATE.KW_POINTS);
    expect(k.markers).toBe(GATE.MARKER_CAP);
  });
});

describe("anchors and text", () => {
  it("builds track, clause and noise anchors from GOALS.md", () => {
    const tracks = parseGoals("## track: video\nweight: 2\nEdit video.\n- wins: ffmpeg techniques; colour grading\n- not: gear unboxings\n");
    const a = buildAnchors(tracks);
    expect(a.filter((x) => x.kind === "track")).toHaveLength(1);
    expect(a.filter((x) => x.kind === "clause").map((x) => x.text)).toEqual(["Edit video. Specifically: ffmpeg techniques", "Edit video. Specifically: colour grading"]);
    expect(a.some((x) => x.kind === "noise" && x.text === "gear unboxings")).toBe(true);
  });
  it("gate text is the title plus a bounded head of the body", () => {
    const t = gateText({ title: "T", text: "a ".repeat(5000) });
    expect(t.startsWith("T\n\n")).toBe(true);
    expect(t.length).toBeLessThanOrEqual(GATE.TEXT_CHARS + 400);
  });
  it("round-trips vectors through base64", () => {
    const x = v(0.1, -2, 3.5, 0);
    expect([...b64ToVec(vecToB64(x))]).toEqual([...x]);
  });
});

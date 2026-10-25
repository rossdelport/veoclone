import { describe, expect, it } from "vitest";
import type { AiRun, BallStats } from "../api";
import { ballWords, percent, reportFileName } from "./ballWords";

const stats = (s: Partial<BallStats>): BallStats => ({ frames: 1000, detected: 0.3, seen: 0.23, followed: 0.61, sightings: 900, rejectedStatic: 0, rejectedOther: 0, ...s });
const run = (style: AiRun["style"], ball: BallStats | null): AiRun => ({ style, aiAccuracy: "best", pitchId: null, ball });

describe("ball words", () => {
  it("says how much of the match the camera follows the ball", () => {
    expect(ballWords(run("ball", stats({})))).toEqual([
      "The AI saw the ball in 23% of the match. VeoClone filled short gaps, so the camera follows the ball for 61% of it; the rest follows the players.",
    ]);
  });
  it("counts the sightings that were not the ball", () => {
    const w = ballWords(run("ball", stats({ rejectedStatic: 1200, rejectedOther: 34 })));
    expect(w[1]).toBe("VeoClone ignored 1,234 sightings that weren't the ball, 1,200 of them spots that never moved (a mark or a light on the grass, a spare ball).");
    expect(ballWords(run("ball", stats({ rejectedOther: 1 })))[1]).toBe("VeoClone ignored 1 sighting that wasn't the ball.");
  });
  it("other styles point to Follow the ball", () => {
    expect(ballWords(run("broadcast", stats({ seen: 0.5, followed: 0.5 })))[0]).toBe(
      "The AI saw the ball in 50% of the match. This camera style follows the players; “Follow the ball” would follow the ball for 50% of it.",
    );
  });
  it("hardly any ball: says so and gives a filming tip", () => {
    const w = ballWords(run("ball", stats({ seen: 0.004, followed: 0.02 })));
    expect(w[0]).toContain("in less than 1% of the match");
    expect(w.at(-1)).toContain("good light");
    expect(ballWords(run("ball", stats({ seen: 0, followed: 0 })))[0]).toBe("The AI didn't see the ball in this match, so the camera follows the players.");
  });
  it("nothing without numbers", () => {
    expect(ballWords(null)).toEqual([]);
    expect(ballWords(run("ball", null))).toEqual([]);
  });
  it("percent and file name", () => {
    expect(percent(0.234)).toBe("23%");
    expect(percent(1.2)).toBe("100%");
    expect(percent(Number.NaN)).toBe("0%");
    expect(reportFileName(new Date(2026, 9, 5))).toBe("veoclone-ai-report-2026-10-05.zip");
  });
});

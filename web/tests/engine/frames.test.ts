import { describe, expect, it } from "vitest";
import { formatFrameTime, frameToTime, timeToFrame } from "../../src/engine/frames";

const fps30 = { num: 30, den: 1 };
const ntsc = { num: 30000, den: 1001 };

describe("frameToTime", () => {
  it("is frame * den / num", () => {
    expect(frameToTime(0, fps30)).toBe(0);
    expect(frameToTime(30, fps30)).toBe(1);
    expect(frameToTime(45, fps30)).toBe(1.5);
    expect(frameToTime(30000, ntsc)).toBeCloseTo(1001, 9);
  });
});

describe("timeToFrame", () => {
  it("rounds to the nearest frame", () => {
    expect(timeToFrame(0, fps30, 100)).toBe(0);
    expect(timeToFrame(1, fps30, 100)).toBe(30);
    expect(timeToFrame(1.01, fps30, 100)).toBe(30);
    expect(timeToFrame(1.02, fps30, 100)).toBe(31);
    // a media time a hair before the frame start still maps to that frame
    expect(timeToFrame(frameToTime(57, ntsc) - 1e-6, ntsc, 1000)).toBe(57);
  });
  it("round-trips every frame", () => {
    for (let f = 0; f < 5000; f++) {
      expect(timeToFrame(frameToTime(f, ntsc), ntsc, 5000)).toBe(f);
    }
  });
  it("clamps to [0, frameCount - 1]", () => {
    expect(timeToFrame(-3, fps30, 100)).toBe(0);
    expect(timeToFrame(1e9, fps30, 100)).toBe(99);
    expect(timeToFrame(Number.NaN, fps30, 100)).toBe(0);
    expect(timeToFrame(5, fps30, 0)).toBe(0);
  });
});

describe("formatFrameTime", () => {
  it("shows m:ss under an hour and h:mm:ss above", () => {
    expect(formatFrameTime(0, fps30)).toBe("0:00");
    expect(formatFrameTime(29, fps30)).toBe("0:00");
    expect(formatFrameTime(30, fps30)).toBe("0:01");
    expect(formatFrameTime((12 * 60 + 5) * 30, fps30)).toBe("12:05");
    expect(formatFrameTime((3600 + 23 * 60 + 45) * 30, fps30)).toBe("1:23:45");
    expect(formatFrameTime(90 * 60 * 30, fps30)).toBe("1:30:00");
  });
  it("never shows a negative or broken time", () => {
    expect(formatFrameTime(-50, fps30)).toBe("0:00");
    expect(formatFrameTime(Number.NaN, fps30)).toBe("0:00");
  });
  it("works for 29.97 fps", () => {
    // frame 1798 starts at 59.993 s
    expect(formatFrameTime(1798, ntsc)).toBe("0:59");
    expect(formatFrameTime(1799, ntsc)).toBe("1:00");
  });
});

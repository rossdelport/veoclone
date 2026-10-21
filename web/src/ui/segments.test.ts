import { describe, expect, it } from "vitest";
import { cutOut, cutParts, isKept, keep, nextKept, setEnd, setStart } from "./segments";

const all = [{ start: 0, end: 100 }];

describe("segments", () => {
  it("trims the start and end", () => {
    expect(setStart(all, 10)).toEqual([{ start: 10, end: 100 }]);
    expect(setEnd(all, 49)).toEqual([{ start: 0, end: 50 }]);
  });

  it("extends back when the new start/end is outside", () => {
    expect(setStart([{ start: 20, end: 50 }], 5)).toEqual([{ start: 5, end: 50 }]);
    expect(setEnd([{ start: 20, end: 50 }], 79)).toEqual([{ start: 20, end: 80 }]);
  });

  it("refuses to keep nothing", () => {
    expect(setStart([{ start: 0, end: 10 }], 10)).toBeNull();
    expect(cutOut(all, 0, 100)).toBeNull();
  });

  it("cuts out a middle part in either order and drops parts entirely before a new start", () => {
    const cut = cutOut(all, 60, 40)!;
    expect(cut).toEqual([
      { start: 0, end: 40 },
      { start: 60, end: 100 },
    ]);
    expect(setStart(cut, 70)).toEqual([{ start: 70, end: 100 }]);
    expect(setEnd(cut, 19)).toEqual([{ start: 0, end: 20 }]);
  });

  it("lists cut parts and puts them back", () => {
    const segs = [
      { start: 10, end: 40 },
      { start: 60, end: 90 },
    ];
    expect(cutParts(segs, 100)).toEqual([
      { start: 0, end: 10 },
      { start: 40, end: 60 },
      { start: 90, end: 100 },
    ]);
    expect(keep(segs, 40, 60)).toEqual([{ start: 10, end: 90 }]);
  });

  it("finds kept frames", () => {
    const segs = [
      { start: 10, end: 40 },
      { start: 60, end: 90 },
    ];
    expect(isKept(segs, 10)).toBe(true);
    expect(isKept(segs, 40)).toBe(false);
    expect(nextKept(segs, 0)).toBe(10);
    expect(nextKept(segs, 45)).toBe(60);
    expect(nextKept(segs, 70)).toBe(70);
    expect(nextKept(segs, 95)).toBeNull();
  });
});

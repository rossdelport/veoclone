import { describe, expect, it } from "vitest";
import { checkParts, goProFileName, parseGoPro, partsNote, sortParts } from "./parts";

const names = (files: { name: string }[]) => files.map((f) => f.name);
const files = (...list: string[]) => list.map((name) => ({ name }));

describe("GoPro file names", () => {
  it("reads HERO6 and later (GX = H.265, GH = H.264)", () => {
    expect(parseGoPro("GX010123.MP4")).toEqual({ recording: "X0123", number: "0123", chapter: 1, prefix: "GX" });
    expect(parseGoPro("GX020123.MP4")).toMatchObject({ recording: "X0123", chapter: 2 });
    expect(parseGoPro("gh120042.mp4")).toEqual({ recording: "H0042", number: "0042", chapter: 12, prefix: "GH" });
  });

  it("reads HERO5 and older (GOPR first, then GP01, GP02…)", () => {
    expect(parseGoPro("GOPR0123.MP4")).toEqual({ recording: "P0123", number: "0123", chapter: 0, prefix: "GP" });
    expect(parseGoPro("GP010123.MP4")).toEqual({ recording: "P0123", number: "0123", chapter: 1, prefix: "GP" });
    expect(parseGoPro("GP020123.MP4")).toMatchObject({ recording: "P0123", chapter: 2 });
  });

  it("ignores other names", () => {
    for (const n of ["IMG_1234.MOV", "left.mp4", "GX0123.MP4", "GX01234.MP4", "GX0101234.MP4", "GOPR123.MP4", "GZ010123.MP4", "GX010123", "DJI_0001.MP4"]) {
      expect(parseGoPro(n)).toBeNull();
    }
  });

  it("names a part of a recording", () => {
    expect(goProFileName({ number: "0123", prefix: "GX" }, 3, ".MP4")).toBe("GX030123.MP4");
    expect(goProFileName({ number: "0123", prefix: "GP" }, 0, ".MP4")).toBe("GOPR0123.MP4");
    expect(goProFileName({ number: "0123", prefix: "GP" }, 1, ".mp4")).toBe("GP010123.mp4");
  });
});

describe("the order of the parts", () => {
  it("puts GoPro parts in recording order, not name order", () => {
    // By name, GX10… would come before GX02…; and GOPR after GP01.
    const shuffled = files("GX100123.MP4", "GX020123.MP4", "GX010123.MP4", "GX090123.MP4");
    expect(names(sortParts(shuffled))).toEqual(["GX010123.MP4", "GX020123.MP4", "GX090123.MP4", "GX100123.MP4"]);
    expect(names(sortParts(files("GP020077.MP4", "GP010077.MP4", "GOPR0077.MP4")))).toEqual(["GOPR0077.MP4", "GP010077.MP4", "GP020077.MP4"]);
    // Two recordings: one after the other.
    expect(names(sortParts(files("GX020124.MP4", "GX010124.MP4", "GX020123.MP4", "GX010123.MP4")))).toEqual([
      "GX010123.MP4",
      "GX020123.MP4",
      "GX010124.MP4",
      "GX020124.MP4",
    ]);
  });

  it("sorts other names by name, counting numbers properly, after GoPro ones", () => {
    expect(names(sortParts(files("clip10.mp4", "clip2.mp4", "Clip1.mp4")))).toEqual(["Clip1.mp4", "clip2.mp4", "clip10.mp4"]);
    expect(names(sortParts(files("left.mp4", "GX020001.MP4", "GX010001.MP4")))).toEqual(["GX010001.MP4", "GX020001.MP4", "left.mp4"]);
  });

  it("keeps the files themselves", () => {
    const a = { name: "GX020123.MP4", size: 2 };
    const b = { name: "GX010123.MP4", size: 1 };
    const sorted = sortParts([a, b]);
    expect(sorted[0]).toBe(b);
    expect(sorted[1]).toBe(a);
  });
});

describe("checking the parts", () => {
  it("is happy with the parts of one recording, and with one file", () => {
    expect(checkParts(["GX010123.MP4", "GX020123.MP4", "GX030123.MP4"])).toEqual([]);
    expect(checkParts(["GOPR0077.MP4", "GP010077.MP4"])).toEqual([]);
    expect(checkParts(["GX010123.MP4"])).toEqual([]);
    expect(checkParts(["GX030123.MP4"])).toEqual([]); // one file: just a video
    expect(checkParts(["IMG_1.MOV"])).toEqual([]);
    expect(checkParts([])).toEqual([]);
  });

  it("points out files from different recordings", () => {
    const [w] = checkParts(["GX010123.MP4", "GX020123.MP4", "GX010456.MP4"]);
    expect(w).toContain("different recordings (recordings 0123 and 0456)");
    expect(w).toContain("end in the same 4 numbers");
    expect(checkParts(["GX010123.MP4", "GH010123.MP4"])[0]).toContain("different recordings");
    expect(checkParts(["GX010123.MP4", "IMG_1.MOV"])[0]).toContain("different recordings");
  });

  it("points out a missing part, also the first one", () => {
    const [w] = checkParts(["GX010123.MP4", "GX030123.MP4"]);
    expect(w).toBe(
      "A part seems to be missing: GX020123.MP4. Add all the files of the recording: without it the video jumps there, and the two cameras no longer line up after it.",
    );
    const [first] = checkParts(["GX020123.MP4", "GX030123.MP4"]);
    expect(first).toContain("missing: GX010123.MP4.");
    expect(first).toContain("line up and level the cameras");
    // HERO5: GOPR0077 is the first part.
    expect(checkParts(["GP010077.MP4", "GP020077.MP4"])[0]).toContain("missing: GOPR0077.MP4");
    expect(checkParts(["GOPR0077.MP4", "GP020077.MP4", "GP040077.MP4"])[0]).toContain(
      "Some parts seem to be missing: GP010077.MP4 and GP030077.MP4",
    );
  });

  it("points out a part that is there twice", () => {
    expect(checkParts(["GX010123.MP4", "GX020123.MP4", "gx020123.mp4"])).toEqual([
      "The same part is in this box twice: gx020123.mp4. Remove the extra copy.",
    ]);
  });

  it("explains joining when the files are not GoPro parts", () => {
    expect(partsNote(["clip1.mp4", "clip2.mp4"])).toContain("joins these 2 files in this order");
    expect(partsNote(["clip1.mp4"])).toBeNull();
    expect(partsNote(["GX010123.MP4", "GX020123.MP4"])).toBeNull();
  });
});

// A camera that splits one long recording into several files (a GoPro starts
// a new "chapter" file every 4 GB, about every 8–12 minutes in 4K): put the
// files of one box in order and spot files that don't belong. Pure, unit
// tested (parts.test.ts).

/** What a GoPro file name says about the recording it belongs to. */
export interface GoProName {
  /** The recording: the 4-digit number every part shares, plus the kind of camera ("X0123"). */
  recording: string;
  /** The 4-digit recording number, e.g. "0123". */
  number: string;
  /** Which part: HERO6 and later count from 1 (GX01…); HERO5 and older start with GOPR… (0), then GP01… */
  chapter: number;
  /** "GX" (H.265) or "GH" (H.264) for HERO6 and later, "GP" for HERO5 and older. */
  prefix: "GX" | "GH" | "GP";
}

/**
 * GX010123.MP4 → recording 0123, part 1 (HERO6 and later: GX = H.265,
 * GH = H.264); GOPR0123.MP4 → part 0 and GP010123.MP4 → part 1 (HERO5 and
 * older). Anything else: null.
 */
export function parseGoPro(fileName: string): GoProName | null {
  const name = fileName.toUpperCase();
  const newer = /^G([XH])(\d{2})(\d{4})\.[A-Z0-9]+$/.exec(name);
  if (newer) {
    const prefix = newer[1] === "X" ? "GX" : "GH";
    return { recording: `${newer[1]}${newer[3]}`, number: newer[3], chapter: Number(newer[2]), prefix };
  }
  const older = /^GP(\d{2})(\d{4})\.[A-Z0-9]+$/.exec(name);
  if (older) return { recording: `P${older[2]}`, number: older[2], chapter: Number(older[1]), prefix: "GP" };
  const first = /^GOPR(\d{4})\.[A-Z0-9]+$/.exec(name);
  if (first) return { recording: `P${first[1]}`, number: first[1], chapter: 0, prefix: "GP" };
  return null;
}

/** The file name of part `chapter` of a GoPro recording, with `ext` (".MP4"). */
export function goProFileName(g: Pick<GoProName, "number" | "prefix">, chapter: number, ext: string): string {
  if (g.prefix === "GP" && chapter === 0) return `GOPR${g.number}${ext}`;
  return `${g.prefix}${String(chapter).padStart(2, "0")}${g.number}${ext}`;
}

const byName = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });

/**
 * The order the files are joined in: GoPro files by recording, then part
 * (GOPR0123 before GP010123); other names after them, sorted by name
 * (numbers in names in counting order: CLIP2 before CLIP10).
 */
export function sortParts<T extends { name: string }>(files: readonly T[]): T[] {
  return [...files].sort((a, b) => {
    const ga = parseGoPro(a.name);
    const gb = parseGoPro(b.name);
    if (ga && gb) return byName(ga.number, gb.number) || byName(ga.recording, gb.recording) || ga.chapter - gb.chapter;
    if (ga || gb) return ga ? -1 : 1;
    return byName(a.name, b.name);
  });
}

function extension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot) : "";
}

/** "A and B", "A, B and C". */
function list(items: string[]): string {
  return items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * Problems with the files of one box (already in order), in plain words:
 * files from different recordings, a part that is missing or there twice.
 * Empty when they look like the parts of one recording (or a single file).
 */
export function checkParts(names: readonly string[]): string[] {
  if (names.length < 2) return [];
  const parsed = names.map((n) => ({ name: n, g: parseGoPro(n) }));
  const gopro = parsed.filter((p) => p.g !== null) as { name: string; g: GoProName }[];
  if (gopro.length === 0) return [];
  const recordings = [...new Set(gopro.map((p) => p.g.recording))];
  if (recordings.length > 1 || gopro.length < names.length) {
    const numbers = [...new Set(gopro.map((p) => p.g.number))];
    const which = numbers.length > 1 ? ` (recordings ${list(numbers)})` : "";
    return [
      `These files seem to come from different recordings${which}. Put only the files of one recording in this box: ` +
        `the files of one GoPro recording all end in the same 4 numbers, for example GX010123.MP4, GX020123.MP4.`,
    ];
  }
  const warnings: string[] = [];
  const g = gopro[0].g;
  const ext = extension(gopro[0].name);
  const chapters = gopro.map((p) => p.g.chapter);
  const twice = gopro.filter((p, i) => chapters.indexOf(p.g.chapter) !== i).map((p) => p.name);
  if (twice.length) warnings.push(`The same part is in this box twice: ${list([...new Set(twice)])}. Remove the extra copy.`);
  const first = g.prefix === "GP" ? 0 : 1;
  const last = Math.max(...chapters);
  const missing: string[] = [];
  for (let c = first; c <= last; c++) if (!chapters.includes(c)) missing.push(goProFileName(g, c, ext));
  if (missing.length) {
    const what = missing.length === 1 ? `A part seems to be missing: ${missing[0]}` : `Some parts seem to be missing: ${list(missing)}`;
    const start = !chapters.includes(first) ? " The first part also carries what VeoClone uses to line up and level the cameras." : "";
    warnings.push(`${what}. Add all the files of the recording: without it the video jumps there, and the two cameras no longer line up after it.${start}`);
  }
  return warnings;
}

/**
 * A note for several files that are not GoPro parts (another camera that
 * splits its videos, or two separate videos put in one box by mistake).
 */
export function partsNote(names: readonly string[]): string | null {
  if (names.length < 2 || names.some((n) => parseGoPro(n))) return null;
  return `VeoClone joins these ${names.length} files in this order into one video. Only put several files in one box when the camera split one recording into parts.`;
}

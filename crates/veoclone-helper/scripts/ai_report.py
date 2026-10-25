#!/usr/bin/env python3
"""Open a VeoClone AI report and run the AI camera again from it, offline.

An AI report is the zip the editor saves with "Save AI report" (helper
endpoint GET /api/projects/:id/ai-report, DESIGN.md 4.13): what the AI saw in
one match (boxes and numbers, no video), the calibration, the settings and the
camera path VeoClone made. This script

  * summarises the recording (frames, people and balls per frame, how often a
    ball was detected),
  * runs the camera again with the helper's own code
    (`veoclone-helper --ai-report`), optionally with other brain settings
    (--set name=value, the BrainConfig names in crates/veoclone-helper/src/
    brain.rs) or another camera style,
  * prints the ball numbers, whether the result is the report's camera path
    (it must be, with no --set and the same style), and the time it took,
  * with --truth (CSV frame,camera,x,y: where the ball really was, camera
    "left" or "right", x/y from 0 to 1 in that camera's picture), how well each
    camera shows the ball: this camera, Reco's ball mode, Reco's broadcast
    camera, and Reco's broadcast camera given the brain's ball track,
  * with --csv, writes the path per frame (yaw, pitch in radians, fov in
    degrees, the ball track, how much the camera follows the ball, the truth).

Usage:
  ai_report.py REPORT.zip [--helper PATH] [--csv OUT.csv] [--truth TRUTH.csv]
               [--style ball|broadcast|action|frame_all] [--set gapSecs=3 ...]
               [--json]

The helper is --helper, else $VEOCLONE_HELPER, else target/release (then
target/debug) of this repository. Python 3 standard library only.
"""

import argparse
import gzip
import json
import os
import struct
import subprocess
import sys
import tempfile
import zipfile

PREFIX = "veoclone-ai-report/"
REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))


def find_helper(explicit):
    for path in [explicit, os.environ.get("VEOCLONE_HELPER"),
                 os.path.join(REPO, "target", "release", "veoclone-helper"),
                 os.path.join(REPO, "target", "debug", "veoclone-helper")]:
        for p in [path, path + ".exe"] if path else []:
            if os.path.isfile(p):
                return p
    raise SystemExit("veoclone-helper not found: build it (cargo build --release -p "
                     "veoclone-helper) or pass --helper")


def read_seen(data):
    """ai_seen.bin.gz → detection frames [(camera, class, conf, x, y, w, h)]."""
    raw = gzip.decompress(data)
    frames, at = [], 0
    while at < len(raw):
        cam, n = raw[at], struct.unpack_from("<I", raw, at + 1)[0]
        at += 5
        if cam == 0 or not frames:
            frames.append([])
        for _ in range(n):
            frames[-1].append((cam,) + struct.unpack_from("<H5f", raw, at))
            at += 22
    return frames


def summary(zip_path):
    with zipfile.ZipFile(zip_path) as z:
        names = z.namelist()
        settings = json.loads(z.read(PREFIX + "settings.json"))
        meta = json.loads(z.read(PREFIX + "ai_seen.json"))
        frames = read_seen(z.read(PREFIX + "ai_seen.bin.gz"))
    ball, person = meta["classes"]["ball"], meta["classes"]["person"]
    people = sum(1 for f in frames for d in f if d[1] == person)
    balls = [[d for d in f if d[1] == ball] for f in frames]
    with_ball = sum(1 for b in balls if b)
    confident = sum(1 for b in balls if any(d[2] >= 0.25 for d in b))
    fps = meta["fps"]
    return {
        "files": sorted(n[len(PREFIX):] for n in names if n.startswith(PREFIX)),
        "style": settings["style"],
        "aiAccuracy": settings["aiAccuracy"],
        "widestView": settings["widestView"],
        "pitchMarked": settings.get("pitch") is not None,
        "frames": meta["frames"],
        "minutes": round(meta["frames"] / fps / 60, 1),
        "detectionFrames": len(frames),
        "every": meta["every"],
        "model": meta["model"],
        "peoplePerFrame": round(people / max(len(frames), 1), 1),
        "framesWithBall": round(with_ball / max(len(frames), 1), 3),
        "framesWithBallAt0.25": round(confident / max(len(frames), 1), 3),
        "aiRunBall": (settings.get("aiRun") or {}).get("ball"),
    }


def pct(x):
    return f"{100 * x:.0f}%" if isinstance(x, (int, float)) else "-"


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("report")
    ap.add_argument("--helper")
    ap.add_argument("--csv")
    ap.add_argument("--truth")
    ap.add_argument("--style", choices=["ball", "broadcast", "action", "frame_all"])
    ap.add_argument("--set", action="append", default=[], metavar="NAME=VALUE",
                    help="change a brain setting (BrainConfig, camelCase), e.g. gapSecs=3")
    ap.add_argument("--json", action="store_true", help="print the tool's JSON as it is")
    args = ap.parse_args()

    info = summary(args.report)
    cmd = [find_helper(args.helper), "--ai-report", os.path.abspath(args.report)]
    for flag, value in (("--csv", args.csv), ("--truth", args.truth), ("--style", args.style)):
        if value:
            cmd += [flag, os.path.abspath(value) if flag != "--style" else value]
    tune = None
    if args.set:
        changes = {}
        for item in args.set:
            name, _, value = item.partition("=")
            if not value:
                raise SystemExit(f"--set {item}: use NAME=VALUE")
            changes[name.strip()] = float(value)
        tune = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False)
        json.dump(changes, tune)
        tune.close()
        cmd += ["--brain-config", tune.name]
    try:
        res = subprocess.run(cmd, capture_output=True, text=True)
    finally:
        if tune:
            os.unlink(tune.name)
    if res.returncode != 0:
        raise SystemExit(res.stderr.strip() or f"the helper failed ({res.returncode})")
    out = json.loads(res.stdout)
    if args.json:
        print(json.dumps({"report": info, "run": out}, indent=2))
        return

    print(f"Report: {info['minutes']} min, {info['frames']} frames, the AI looked at every "
          f"{info['every']} frame(s) with {info['model']}; style {info['style']}, AI accuracy "
          f"{info['aiAccuracy']}, widest view {info['widestView']}, pitch "
          f"{'marked' if info['pitchMarked'] else 'not marked'}")
    print(f"What the AI saw: {info['peoplePerFrame']} people per frame; a ball in "
          f"{pct(info['framesWithBall'])} of the frames it looked at "
          f"({pct(info['framesWithBallAt0.25'])} at confidence 0.25 or more)")
    b = out.get("ball") or {}
    print(f"Camera ({out['style']}) made in {out['seconds']:.2f} s. Ball: detected in "
          f"{pct(b.get('detected'))} of the match, on the ball track {pct(b.get('seen'))}, "
          f"followed {pct(b.get('followed'))}; of {b.get('sightings')} sightings "
          f"{b.get('rejectedStatic')} were spots that never moved, {b.get('rejectedOther')} "
          f"were off the track")
    same = out.get("sameAsReport")
    if same:
        d = same["maxDifference"]
        exact = all(x == 0 for x in d)
        if same["comparable"]:
            print("Same as the report's camera path: " + ("yes, exactly" if exact else
                  f"no (largest difference yaw {d[0]:.4g} rad, pitch {d[1]:.4g} rad, "
                  f"zoom {d[2]:.4g} deg)"))
        else:
            print(f"Another style than the report's: largest difference to its path {d}")
    for name, s in (out.get("truth") or {}).items():
        e = s["yawErrorDeg"]
        print(f"  {name:28s} ball in the picture {pct(s['ballInPicture']):>4s}; "
              f"yaw error mean {e['mean']:.1f}, median {e['median']:.1f}, 95% {e['p95']:.1f}, "
              f"max {e['max']:.1f} deg ({s['frames']} frames)")
    if out.get("csv"):
        print(f"Path written to {out['csv']}")


if __name__ == "__main__":
    sys.exit(main())

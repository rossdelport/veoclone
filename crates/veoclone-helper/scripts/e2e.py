#!/usr/bin/env python3
"""End-to-end test of a running-from-scratch veoclone-helper over HTTP.

Starts the helper binary, uploads two videos, processes them, checks the
editor data, exports two segments (also with text boxes burned in, checked
frame by frame), and exercises cancel, delete, restart recovery, re-runs
that keep the earlier result, lens choices, swapping left and right, the
single-instance check, CORS and the Host check. Then the same videos split
into GoPro-style chapter files, sent as parts, against the one-file match
frame for frame, and the "Widest view" zoom limit (the AI pass, a quick
re-run and the editor's final path). Python 3 standard library only; needs
ffmpeg and ffprobe on PATH (and node with web/node_modules for the editor's
final path check).

Usage:
  e2e.py --helper target/release/veoclone-helper --left L.mp4 --right R.mp4 \
         --model models/yolo26n_640.onnx --work /tmp/veoclone-e2e

The helper needs ffmpeg/ffprobe next to it or on PATH and, for a
dynamically linked ONNX Runtime, LD_LIBRARY_PATH / ORT_DYLIB_PATH set.
"""

import argparse
import base64
import http.client
import json
import os
import shutil
import signal
import struct
import subprocess
import sys
import time
import zlib

PORT = 47871
HOST = f"127.0.0.1:{PORT}"


def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def request(method, path, body=None, headers=None, host=HOST, raw=False):
    conn = http.client.HTTPConnection("127.0.0.1", PORT, timeout=600)
    hdrs = {"Host": host}
    hdrs.update(headers or {})
    if isinstance(body, (dict, list)):
        body = json.dumps(body).encode()
        hdrs["Content-Type"] = "application/json"
    conn.request(method, path, body=body, headers=hdrs)
    res = conn.getresponse()
    data = res.read()
    conn.close()
    if raw:
        return res.status, dict(res.getheaders()), data
    try:
        return res.status, json.loads(data) if data else None
    except ValueError:
        return res.status, data


def upload(pid, side, path, part=None):
    """Send a video file; part=(n, m): part n (from 1) of a video in m files."""
    conn = http.client.HTTPConnection("127.0.0.1", PORT, timeout=600)
    size = os.path.getsize(path)
    query = f"?part={part[0]}&parts={part[1]}" if part else ""
    conn.putrequest("PUT", f"/api/projects/{pid}/files/{side}{query}", skip_host=True)
    conn.putheader("Host", HOST)
    conn.putheader("Content-Length", str(size))
    conn.putheader("X-Filename", os.path.basename(path))
    conn.endheaders()
    with open(path, "rb") as f:
        while chunk := f.read(1 << 16):
            conn.send(chunk)
    res = conn.getresponse()
    data = json.loads(res.read())
    conn.close()
    return res.status, data


def check(cond, what):
    if not cond:
        raise SystemExit(f"FAILED: {what}")
    log(f"ok: {what}")


class Helper:
    def __init__(self, args):
        self.args = args
        self.proc = None

    def cmd(self, port=PORT):
        cmd = [self.args.helper, "--no-open", "--port", str(port),
               "--data-dir", self.args.data, "--model", self.args.model]
        if self.args.web_dir:
            cmd += ["--web-dir", self.args.web_dir]
        return cmd

    def start(self):
        self.proc = subprocess.Popen(self.cmd(), stdout=open(self.args.log, "a"),
                                     stderr=subprocess.STDOUT)
        for _ in range(100):
            try:
                if request("GET", "/api/health")[0] == 200:
                    return
            except OSError:
                time.sleep(0.2)
        raise SystemExit("helper did not start")

    def kill(self):
        self.proc.send_signal(signal.SIGKILL)
        self.proc.wait()

    def stop(self):
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()
            self.proc.wait()


def wait_for(pid, done, timeout=3600, seen=None):
    start = time.time()
    last = None
    while time.time() - start < timeout:
        _, p = request("GET", f"/api/projects/{pid}")
        job = p.get("job") or {}
        state = (p["status"], job.get("step"), round(job.get("progress", 0), 1))
        if state != last:
            log(f"  status={p['status']} step={job.get('step')} "
                f"progress={job.get('progress', 0):.2f} frames={job.get('framesDone')}/"
                f"{job.get('framesTotal')} eta={job.get('etaSeconds')} msg={job.get('message')}")
            last = state
        if seen is not None:
            seen.add((p["status"], job.get("step")))
        if done(p):
            return p
        time.sleep(0.5)
    raise SystemExit("timed out")


def ffprobe(path, entries, stream="v:0"):
    out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", stream, "-count_packets",
                          "-show_entries", entries, "-of", "json", path],
                         capture_output=True, text=True, check=True).stdout
    return json.loads(out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--helper", required=True)
    ap.add_argument("--left", required=True)
    ap.add_argument("--right", required=True)
    ap.add_argument("--model", required=True)
    ap.add_argument("--work", required=True)
    ap.add_argument("--web-dir")
    ap.add_argument("--only", choices=["main", "quickwins", "chapters", "natural"],
                    help="run only these checks (main: processing, exports, recovery, lenses; "
                         "quickwins: ball style, AI accuracy, pitch outline, fast re-runs; "
                         "chapters: videos in several files; natural: the widest view)")
    args = ap.parse_args()
    shutil.rmtree(args.work, ignore_errors=True)
    os.makedirs(args.work)
    args.data = os.path.join(args.work, "data")
    args.log = os.path.join(args.work, "helper.log")
    helper = Helper(args)
    helper.start()
    try:
        if args.only in (None, "main"):
            run(args, helper)
        if args.only in (None, "quickwins"):
            quickwins(args)
        if args.only in (None, "chapters"):
            chapters(args)
        if args.only in (None, "natural"):
            natural_look(args)
    finally:
        helper.stop()
    log("ALL CHECKS PASSED")


def run(args, helper):
    _, h = request("GET", "/api/health")
    log(f"health: {json.dumps(h)}")
    check(h["app"] == "veoclone-helper" and h["ffmpeg"] is True, "health reports ffmpeg")
    for _ in range(100):
        _, h = request("GET", "/api/health")
        if h["ai"]["provider"] != "checking":
            break
        time.sleep(0.3)
    check(h["ai"]["available"] and h["ai"]["provider"] == "CPU", "AI available on CPU")

    # Security: wrong Host, CORS preflight incl. private network access.
    status, _, _ = request("GET", "/api/projects", host=f"evil.example:{PORT}", raw=True)
    check(status == 403, "request with a foreign Host header is refused")
    status, hdrs, _ = request("OPTIONS", "/api/projects", raw=True, headers={
        "Origin": "https://rossdelport.github.io",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type",
        "Access-Control-Request-Private-Network": "true"})
    hdrs = {k.lower(): v for k, v in hdrs.items()}
    check(status in (200, 204)
          and hdrs.get("access-control-allow-origin") == "https://rossdelport.github.io"
          and hdrs.get("access-control-allow-private-network") == "true",
          f"CORS preflight answered ({status}, {hdrs})")

    status, hdrs, _ = request("GET", "/", raw=True)
    hdrs = {k.lower(): v for k, v in hdrs.items()}
    check(hdrs.get("x-frame-options") == "DENY"
          and hdrs.get("content-security-policy") == "frame-ancestors 'none'",
          "the editor cannot be shown inside another page")

    status, lenses = request("GET", "/api/lenses")
    check(status == 200 and lenses[0]["id"] == "generic:ultra"
          and all(set(l) >= {"id", "model", "lens", "label"} for l in lenses)
          and len({l["id"] for l in lenses}) == len(lenses)
          and any(l["id"] == "iphone-16-pro:ultra" for l in lenses),
          f"{len(lenses)} lens choices, first {lenses[0]}")

    # Create + upload.
    status, p = request("POST", "/api/projects", {"name": "E2E match", "style": "broadcast"})
    check(status == 201 and p["status"] == "new" and p["lensId"] == "generic:ultra",
          "project created with the default lens")
    pid = p["id"]
    status, p = upload(pid, "left", args.left)
    check(status == 200 and p["status"] == "new", "left uploaded")
    status, p = upload(pid, "right", args.right)
    check(status == 200 and p["status"] == "uploaded"
          and p["files"]["right"]["sizeBytes"] == os.path.getsize(args.right), "right uploaded")

    # Process.
    status, p = request("POST", f"/api/projects/{pid}/process")
    check(status == 200 and p["status"] in ("queued", "processing"), "processing started")
    status, _ = request("POST", f"/api/projects/{pid}/process")
    check(status == 409, "second process request is refused while busy")
    status, _ = request("DELETE", f"/api/projects/{pid}")
    check(status == 409, "delete is refused while processing")
    seen = set()
    t0 = time.time()
    p = wait_for(pid, lambda p: p["status"] in ("ready", "failed", "cancelled"), seen=seen)
    log(f"processing took {time.time() - t0:.0f} s; states seen: {sorted(seen, key=str)}")
    check(p["status"] == "ready", f"processing finished: {p.get('error')}")
    check(p["calibration"]["lens"] == "Not sure · Ultra wide (0.5×)"
          and any("didn't know which iPhone" in w for w in p["warnings"]),
          "an iPhone lens was guessed, with a warning")
    steps = {s for _, s in seen}
    check({"probe", "calibrate", "proxy", "track"} <= steps, f"all steps reported {steps}")
    log(f"warnings: {p['warnings']}; calibration: {p.get('calibration')}")
    check(p["calibration"]["syncOffsetFrames"] == 12, "sync offset 12 frames")
    frame_count = p["frameCount"]
    check(560 <= frame_count <= 600, f"frameCount {frame_count}")
    check(p["files"]["left"]["probe"]["width"] == 1280, "probe stored on the file")

    status, cal = request("GET", f"/api/projects/{pid}/calibration")
    cov = cal["coverage"]
    check(status == 200 and cal["frameCount"] == frame_count and cal["fps"] == {"num": 30, "den": 1},
          "calibration frameCount/fps")
    check(len(cov["slices"]) == 400 and cov["pitchMin"] < 0 < cov["pitchMax"]
          and 5 < cov["maxFovDeg"] < 120
          and all(a <= b for a, b in cov["slices"][50:350]),
          f"coverage sane (pitch {cov['pitchMin']:.3f}..{cov['pitchMax']:.3f}, "
          f"max fov {cov['maxFovDeg']:.1f}, mid row {cov['slices'][200]})")
    check(cal["proxy"]["tileWidth"] == 1280 and cal["proxy"]["tileHeight"] == 720
          and cal["match"]["sync_offset"] == 12, "proxy tiles + match verbatim")

    status, hdrs, data = request("GET", f"/api/projects/{pid}/ai-path.bin", raw=True)
    check(status == 200 and len(data) == frame_count * 12, f"ai-path.bin is {len(data)} bytes")
    poses = list(struct.iter_unpack("<3f", data))
    yaws = [y for y, _, _ in poses]
    fovs = [f for _, _, f in poses]
    log(f"AI yaw range {min(yaws):.3f}..{max(yaws):.3f}, pitch {poses[0][1]:.3f}, "
        f"fov {min(fovs):.1f}..{max(fovs):.1f}")
    check(all(abs(y) < 1.6 for y in yaws) and all(5 <= f <= 90 for f in fovs),
          "AI poses plausible")

    status, hdrs, data = request("GET", f"/api/projects/{pid}/proxy.mp4", raw=True)
    proxy = os.path.join(args.work, "proxy.mp4")
    open(proxy, "wb").write(data)
    info = ffprobe(proxy, "stream=width,height,nb_read_packets,codec_name")["streams"][0]
    check(info["width"] == 1280 and info["height"] == 1440
          and int(info["nb_read_packets"]) == frame_count, f"proxy {info}")
    status, hdrs, part = request("GET", f"/api/projects/{pid}/proxy.mp4", raw=True,
                                 headers={"Range": "bytes=100-199"})
    check(status == 206 and part == data[100:200]
          and hdrs.get("content-range") == f"bytes 100-199/{len(data)}", "proxy Range request")
    decoded = subprocess.run(["ffmpeg", "-v", "error", "-i", proxy, "-f", "null", "-"],
                             capture_output=True, text=True)
    check(decoded.returncode == 0 and not decoded.stderr.strip(), "proxy decodes cleanly")

    status, _ = request("PUT", f"/api/projects/{pid}/edits", {"version": 1, "zoom": 1.1})
    status, edits = request("GET", f"/api/projects/{pid}/edits")
    check(edits == {"version": 1, "zoom": 1.1}, "edits saved")

    # Export two segments along the AI path.
    segments = [{"startFrame": 30, "endFrame": 200}, {"startFrame": 300, "endFrame": 500}]
    kept = sum(s["endFrame"] - s["startFrame"] for s in segments)
    body = {"segments": segments, "width": 1280, "height": 720, "quality": "fast",
            "pathBase64": base64.b64encode(data_path(poses)).decode()}
    status, ex = request("POST", f"/api/projects/{pid}/exports", body)
    check(status == 201 and ex["status"] == "queued", f"export queued {ex}")
    t0 = time.time()
    p = wait_for(pid, lambda p: p["exports"][0]["status"] in ("done", "failed", "cancelled"))
    ex = p["exports"][0]
    log(f"export took {time.time() - t0:.0f} s: {ex}")
    check(ex["status"] == "done" and ex["fileName"].endswith(".mp4"), "export done")
    status, hdrs, video = request("GET", f"/api/projects/{pid}/exports/{ex['id']}/file", raw=True)
    out = os.path.join(args.work, "export.mp4")
    open(out, "wb").write(video)
    check(status == 200 and len(video) == ex["sizeBytes"]
          and hdrs.get("content-disposition", "").startswith("attachment"), "export download")
    v = ffprobe(out, "stream=width,height,nb_read_packets")["streams"][0]
    a = ffprobe(out, "stream=codec_name", stream="a:0")["streams"]
    dur = float(ffprobe(out, "format=duration")["format"]["duration"])
    check(v["width"] == 1280 and v["height"] == 720 and int(v["nb_read_packets"]) == kept,
          f"export has {v['nb_read_packets']} frames (kept {kept})")
    check(abs(dur - kept / 30) < 0.1, f"export duration {dur:.3f} s = {kept}/30")
    check(len(a) == 1, f"export has audio {a}")
    check(0 <= video.find(b"moov") < video.find(b"mdat"), "export is faststart (moov first)")
    status, hdrs, part = request("GET", f"/api/projects/{pid}/exports/{ex['id']}/file", raw=True,
                                 headers={"Range": "bytes=0-9"})
    check(status == 206 and part == video[:10], "export Range request")

    straighten_checks(args, pid, poses, frame_count)

    # Cancel a running export, then delete it.
    status, ex2 = request("POST", f"/api/projects/{pid}/exports", body)
    wait_for(pid, lambda p: (p.get("job") or {}).get("framesDone", 0) > 5)
    status, _ = request("DELETE", f"/api/projects/{pid}/exports/{ex2['id']}")
    check(status == 409, "deleting a running export is refused")
    request("POST", f"/api/projects/{pid}/cancel")
    p = wait_for(pid, lambda p: p["job"] is None)
    ex2 = [e for e in p["exports"] if e["id"] == ex2["id"]][0]
    check(ex2["status"] == "cancelled" and p["status"] == "ready", "export cancelled")
    status, p = request("DELETE", f"/api/projects/{pid}/exports/{ex2['id']}")
    check(status == 200 and len(p["exports"]) == 1, "cancelled export deleted")

    text_checks(args, pid, body, out, kept)

    # A second copy of VeoClone (double-clicked again) must leave the running
    # one alone, also on another port with the same folder.
    folder = os.path.join(args.data, "projects", pid)
    before = sorted(os.listdir(folder))
    for port, words in ((PORT, "already running"), (PORT + 1, "using the folder")):
        second = subprocess.run(["timeout", "30"] + helper.cmd(port), capture_output=True,
                                text=True)
        check(second.returncode != 0 and words in second.stderr
              and sorted(os.listdir(folder)) == before,
              f"second copy on port {port} stops at once ({second.stderr.strip()[-90:]})")

    # Re-run AI with another style and cancel it during tracking: the match
    # keeps its earlier result (DESIGN.md 4.7).
    request("PATCH", f"/api/projects/{pid}", {"style": "action"})
    forget_seen(args, pid)  # a full AI pass, long enough to stop half-way
    request("POST", f"/api/projects/{pid}/process")
    wait_for(pid, lambda p: (p.get("job") or {}).get("step") == "track"
             and (p["job"].get("framesDone") or 0) > 10)
    request("POST", f"/api/projects/{pid}/cancel")
    p = wait_for(pid, lambda p: p["job"] is None and p["status"] != "queued")
    check(p["status"] == "ready" and p["error"] is None and p["frameCount"] == frame_count
          and any("stopped the new run" in w for w in p["warnings"]),
          f"cancelled re-run keeps the earlier result: {p['warnings']}")
    status, _ = request("GET", f"/api/projects/{pid}/calibration")
    check(status == 200, "editor data still there")

    # Restart while re-processing: back to ready with the earlier result.
    forget_seen(args, pid)
    request("POST", f"/api/projects/{pid}/process")
    wait_for(pid, lambda p: p["status"] == "processing")
    helper.kill()
    log("helper killed during processing; restarting")
    helper.start()
    _, p = request("GET", f"/api/projects/{pid}")
    check(p["status"] == "ready" and p["job"] is None
          and any("closed" in w for w in p["warnings"]),
          f"interrupted re-run keeps the earlier result: {p['warnings']}")

    # Try again (calibration + preview are reused, AI re-runs).
    request("POST", f"/api/projects/{pid}/process")
    p = wait_for(pid, lambda p: p["status"] in ("ready", "failed", "cancelled"))
    check(p["status"] == "ready" and p["style"] == "action", "Try again succeeds")

    # Choosing an iPhone and lens re-calibrates with it.
    lens = [l for l in lenses if l["id"] == "iphone-13-pro:ultra"][0]
    status, p = request("PATCH", f"/api/projects/{pid}", {"lensId": lens["id"]})
    check(status == 200 and p["lensId"] == lens["id"] and "calibration" not in p,
          "lens chosen, calibration will be redone")
    request("POST", f"/api/projects/{pid}/process")
    seen = set()
    p = wait_for(pid, lambda p: p["status"] in ("ready", "failed", "cancelled"), seen=seen)
    check(p["status"] == "ready" and p["calibration"]["lens"] == lens["label"]
          and ("processing", "calibrate") in seen and ("processing", "proxy") in seen
          and not any("didn't know which iPhone" in w for w in p["warnings"]),
          f"re-processed with lens {p.get('calibration')}, warnings {p['warnings']}")

    # Left and right the wrong way round: the error says so, and swapping
    # them back (no new upload) fixes it.
    status, p = request("POST", f"/api/projects/{pid}/swap")
    check(status == 200 and p["status"] == "uploaded" and "calibration" not in p
          and p["files"]["left"]["name"] == os.path.basename(args.right)
          and not os.path.exists(os.path.join(folder, "proxy.mp4")),
          "videos swapped, earlier results dropped")
    request("POST", f"/api/projects/{pid}/process")
    p = wait_for(pid, lambda p: p["status"] in ("ready", "failed", "cancelled"))
    problem = p["error"]["message"] if p["status"] == "failed" else " ".join(p["warnings"])
    check("wrong way round" in problem, f"swapped videos are pointed out: {p['status']} {problem}")
    status, p = request("POST", f"/api/projects/{pid}/swap")
    check(status == 200 and p["files"]["left"]["name"] == os.path.basename(args.left),
          "videos swapped back")
    request("POST", f"/api/projects/{pid}/process")
    p = wait_for(pid, lambda p: p["status"] in ("ready", "failed", "cancelled"))
    check(p["status"] == "ready" and p["calibration"]["syncOffsetFrames"] == 12,
          "processed again after swapping back")

    # Delete.
    status, _ = request("DELETE", f"/api/projects/{pid}")
    check(status == 200 and not os.path.exists(folder), "project deleted with its folder")
    status, _ = request("GET", f"/api/projects/{pid}")
    check(status == 404, "deleted project is gone")


def new_match(args, name, style, **extra):
    status, p = request("POST", "/api/projects", {"name": name, "style": style, **extra})
    check(status == 201 and p["style"] == style, f"match '{name}' created with style {style}")
    pid = p["id"]
    for side, path in (("left", args.left), ("right", args.right)):
        status, p = upload(pid, side, path)
        check(status == 200, f"{side} uploaded")
    return pid


def process(pid):
    """Process a match and wait for the end. Returns (meta, seconds, steps seen)."""
    status, p = request("POST", f"/api/projects/{pid}/process")
    check(status == 200, "processing started")
    seen = set()
    t0 = time.time()
    p = wait_for(pid, lambda p: p["status"] in ("ready", "failed", "cancelled"), seen=seen)
    secs = time.time() - t0
    check(p["status"] == "ready", f"processed in {secs:.1f} s: {p.get('error')}")
    return p, secs, seen


def ai_path(pid, frame_count):
    status, _, data = request("GET", f"/api/projects/{pid}/ai-path.bin", raw=True)
    check(status == 200 and len(data) == frame_count * 12, "AI path downloaded")
    return list(struct.iter_unpack("<3f", data))


def job_log(args, pid):
    with open(os.path.join(args.data, "projects", pid, "log.txt"), encoding="utf-8",
              errors="replace") as f:
        return f.read()


def ai_pass_seconds(text):
    """The "AI pass: N frames in S s" times in a job log."""
    import re
    return [float(m) for m in re.findall(r"AI pass: \d+ frames in ([\d.]+) s", text)]


def quickwins(args):
    """Ball tracking quick wins: the "Follow the ball" style, the AI
    accuracy option, the pitch outline and fast re-runs."""
    # 1. "Follow the ball": Reco's ball tracking mode.
    pid = new_match(args, "Follow the ball", "ball")
    p, secs, _ = process(pid)
    n = p["frameCount"]
    ball = ai_path(pid, n)
    text = job_log(args, pid)
    check("Reco Ball tracking" in text and "Tracking mode: ball-only" in text,
          "the AI ran in Reco's ball mode")
    yaws = [y for y, _, _ in ball]
    fovs = {round(f, 3) for _, _, f in ball}
    log(f"ball style: yaw {min(yaws):.3f}..{max(yaws):.3f}, fov {sorted(fovs)[:5]}, "
        f"AI pass {secs:.0f} s")
    # The synthetic ball crosses the pitch and back; with no player cluster
    # Reco's ball mode keeps its starting zoom (FieldPanner fov_default: 40
    # in the broadcast preset, 34 with the Natural widest view new matches
    # have).
    check(max(yaws) - min(yaws) > 0.5, f"the camera follows the ball across the pitch "
          f"({max(yaws) - min(yaws):.2f} rad)")
    check(fovs == {34.0}, "ball mode keeps a fixed zoom (Natural: 34 deg)")
    request("PATCH", f"/api/projects/{pid}", {"style": "broadcast"})
    p, secs, _ = process(pid)
    broadcast = ai_path(pid, n)
    yaws_b = [y for y, _, _ in broadcast]
    log(f"broadcast style: yaw {min(yaws_b):.3f}..{max(yaws_b):.3f}")
    check(max(yaws_b) - min(yaws_b) < max(yaws) - min(yaws),
          "Broadcast follows the (still) players, Follow the ball moves much more")

    # 2. AI accuracy: every frame by default, every 3rd frame on request.
    check(p["aiAccuracy"] == "best", "the AI looks at every frame by default")
    best_secs = ai_pass_seconds(job_log(args, pid))[-1]
    status, p = request("PATCH", f"/api/projects/{pid}", {"aiAccuracy": "faster"})
    check(status == 200 and p["aiAccuracy"] == "faster", "AI accuracy set to Faster")
    forget_seen(args, pid)  # time a full AI pass (a quick re-run is checked below)
    p, _, _ = process(pid)
    text = job_log(args, pid)
    faster_secs = ai_pass_seconds(text)[-1]
    check(text.count("Detection interval: every 3 frames") == 1
          and "the AI looks at every 3rd frame" in text, "Faster runs the AI on every 3rd frame")
    log(f"AI pass: every frame {best_secs:.0f} s, every 3rd frame {faster_secs:.0f} s "
        f"({best_secs / max(faster_secs, 1):.1f}x)")
    fast_checks(args, pid, n, ball)
    request("DELETE", f"/api/projects/{pid}")


def max_diff(a, b):
    """Largest |yaw|, |pitch| (rad) and |fov| (deg) difference of two paths."""
    assert len(a) == len(b)
    return [max(abs(p[k] - q[k]) for p, q in zip(a, b)) for k in range(3)]


def forget_seen(args, pid):
    """Delete the recording of what the AI saw: the next run goes through the video."""
    for f in ("ai_seen.bin.gz", "ai_seen.json"):
        path = os.path.join(args.data, "projects", pid, f)
        if os.path.exists(path):
            os.remove(path)


def run_timed(args, pid, quick):
    p, secs, seen = process(pid)
    text = job_log(args, pid).split("=== Processing started")[-1]
    check(("Quick re-run" in text) == quick,
          f"{'quick re-run' if quick else 'full AI pass'} as expected ({secs:.1f} s)")
    return p, secs, text


def read_seen(path):
    """ai_seen.bin.gz as a list of detection frames [(camera, class, conf, x, y, w, h)]."""
    import gzip
    data = gzip.open(path).read()
    frames, at = [], 0
    while at < len(data):
        cam, n = data[at], struct.unpack_from("<I", data, at + 1)[0]
        at += 5
        if cam == 0 or not frames:
            frames.append([])
        for _ in range(n):
            cls, conf, x, y, w, h = struct.unpack_from("<H5f", data, at)
            at += 22
            frames[-1].append((cam, cls, conf, x, y, w, h))
    return frames


def inside(pt, poly):
    x, y = pt
    res = False
    j = len(poly) - 1
    for i in range(len(poly)):
        xi, yi = poly[i]
        xj, yj = poly[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            res = not res
        j = i
    return res


def fast_checks(args, pid, n, ball_live):
    """4. Fast re-runs from what the AI saw, against full AI passes."""
    folder = os.path.join(args.data, "projects", pid)
    import re
    _, p = request("GET", f"/api/projects/{pid}")
    # The last run was every 3rd frame: back to every frame needs the video.
    check(p["aiSeen"] == {"every": 3}, f"recording of every 3rd frame kept: {p['aiSeen']}")
    request("PATCH", f"/api/projects/{pid}", {"aiAccuracy": "best", "style": "ball"})
    p, full_secs, text = run_timed(args, pid, quick=False)
    m = re.search(r"largest difference: yaw ([\d.e+-]+) rad, pitch ([\d.e+-]+) rad, zoom "
                  r"([\d.e+-]+) deg; checked in ([\d.]+) s", text)
    check(m is not None, "the AI pass checked its recording by replaying it")
    log(f"PARITY live AI pass vs replay of its recording (ball style): yaw {m[1]}, pitch {m[2]}, "
        f"fov {m[3]} (replay took {m[4]} s)")
    size = os.path.getsize(os.path.join(folder, "ai_seen.bin.gz"))
    frames = read_seen(os.path.join(folder, "ai_seen.bin.gz"))
    dets = sum(len(f) for f in frames)
    log(f"recording: {size} bytes for {n} frames ({size / n:.0f} B/frame, {dets / len(frames):.1f} "
        f"detections per frame); 90 min at 30 fps: about {size / n * 162000 / 1e6:.0f} MB")
    check(len(frames) == n and p["aiSeen"] == {"every": 1}, "every frame recorded")
    ball_full = ai_path(pid, n)
    d = max_diff(ball_full, ball_live)
    log(f"ball style, AI pass with recording vs Reco's plain ball mode setup: {d}")
    check(max(d) == 0.0, "recording does not change the ball-mode path")

    # Style changes run again in seconds, and match a full AI pass.
    results = {}
    for style in ("broadcast", "action", "frame_all", "ball"):
        request("PATCH", f"/api/projects/{pid}", {"style": style})
        p, secs, _ = run_timed(args, pid, quick=True)
        results[style] = (ai_path(pid, n), secs)
    quick_ball = results["ball"][0]
    check(max(max_diff(quick_ball, ball_full)) == 0.0, "quick ball re-run = its AI pass")
    request("PATCH", f"/api/projects/{pid}", {"style": "broadcast"})
    forget_seen(args, pid)
    p, broadcast_secs, _ = run_timed(args, pid, quick=False)
    broadcast_full = ai_path(pid, n)
    d = max_diff(results["broadcast"][0], broadcast_full)
    log(f"PARITY quick broadcast (from the ball run's recording) vs full broadcast AI pass: {d}")
    check(max(d) < 1e-5, "quick style change = full AI pass")
    # And the other way round: ball from the broadcast run's recording.
    request("PATCH", f"/api/projects/{pid}", {"style": "ball"})
    p, _, _ = run_timed(args, pid, quick=True)
    d = max_diff(ai_path(pid, n), ball_full)
    log(f"PARITY quick ball (from the broadcast run's recording) vs full ball AI pass: {d}")
    check(max(d) < 1e-5, "quick ball = full ball AI pass")

    # AI accuracy "Faster" from a recording of every frame.
    request("PATCH", f"/api/projects/{pid}", {"style": "broadcast", "aiAccuracy": "faster"})
    p, faster_quick_secs, _ = run_timed(args, pid, quick=True)
    faster_quick = ai_path(pid, n)
    forget_seen(args, pid)
    p, faster_full_secs, _ = run_timed(args, pid, quick=False)
    d = max_diff(faster_quick, ai_path(pid, n))
    log(f"PARITY quick every-3rd-frame (from every frame) vs full every-3rd-frame pass: {d}")
    check(max(d) < 1e-5, "every 3rd frame emulated exactly")

    # Pitch outline: drop the stands (the top of both pictures).
    request("PATCH", f"/api/projects/{pid}", {"aiAccuracy": "best"})
    p, _, _ = run_timed(args, pid, quick=False)  # every-3rd recording: needs the video
    no_pitch = ai_path(pid, n)
    poly = [[0.0, 0.45], [1.0, 0.45], [1.0, 1.0], [0.0, 1.0]]
    status, p = request("PUT", f"/api/projects/{pid}/pitch", {
        "points": [[0.9, -0.05], [-0.9, -0.05], [-0.8, -0.35], [0.8, -0.35]],
        "left": poly, "right": poly})
    check(status == 200 and p["pitch"]["left"] == poly, "pitch outline saved")
    check(p["aiRun"]["pitchId"] is None, "the AI path does not use it yet")
    p, pitch_secs, text = run_timed(args, pid, quick=True)
    check(p["aiRun"]["pitchId"] == p["pitch"]["id"], "now it does")
    m = re.search(r"Pitch outline: (\d+) of the (\d+) people and balls", text)
    check(m is not None, "the job log says how many were outside the pitch")
    # Count them ourselves from the recording, with Reco's rules (a person's
    # feet and lower body must be inside, a ball's centre).
    frames = read_seen(os.path.join(folder, "ai_seen.bin.gz"))
    outside = 0
    for f in frames:
        for cam, cls, conf, x, y, w, h in f:
            ok = (inside((x, y + h / 2), poly) and inside((x, y + h / 4), poly)) if cls == 0 \
                else inside((x, y), poly)
            outside += not ok
    total = sum(len(f) for f in frames)
    log(f"pitch outline: helper ignored {m[1]} of {m[2]}; counted from the recording: "
        f"{outside} of {total}")
    check(int(m[1]) == outside and int(m[2]) == total and outside > 0,
          "the pitch outline removes exactly the detections outside it")
    with_pitch = ai_path(pid, n)
    check(max(max_diff(with_pitch, no_pitch)) > 1e-3, "the camera path changed")
    forget_seen(args, pid)
    p, _, _ = run_timed(args, pid, quick=False)
    d = max_diff(with_pitch, ai_path(pid, n))
    log(f"PARITY quick re-run with the pitch outline vs full AI pass with it: {d}")
    check(max(d) < 1e-5, "quick pitch re-run = full AI pass with the outline")
    status, p = request("DELETE", f"/api/projects/{pid}/pitch")
    check(status == 200 and p["pitch"] is None, "pitch outline removed")

    quick = [secs for _, secs in results.values()] + [faster_quick_secs, pitch_secs]
    log(f"TIMINGS full AI pass (every frame): {full_secs:.1f} s ball, {broadcast_secs:.1f} s "
        f"broadcast, every 3rd frame {faster_full_secs:.1f} s; quick re-runs: "
        f"{min(quick):.1f}-{max(quick):.1f} s")


def framemd5(video):
    out = subprocess.run(["ffmpeg", "-v", "error", "-i", video, "-map", "0:v", "-f", "framemd5", "-"],
                         capture_output=True, text=True, check=True).stdout
    return [line.split(",")[-1].strip() for line in out.splitlines() if not line.startswith("#")]


def frame_hashes(video):
    """MD5 of every decoded video frame, each frame once (no constant-rate fill)."""
    out = subprocess.run(["ffmpeg", "-v", "error", "-i", video, "-map", "0:v", "-fps_mode", "passthrough",
                          "-f", "framemd5", "-"], capture_output=True, text=True, check=True).stdout
    return [line.split(",")[-1].strip() for line in out.splitlines() if not line.startswith("#")]


def split_gopro(src, out_dir, number):
    """GoPro-style chapter files of a video: GX01<number>.MP4, GX02…, GX03…
    of 256, 256 and the remaining frames, each with its own sound and with
    picture and sound starting at time 0, like a camera's. For that the
    video is first encoded once more, without B-frames, with keyframes where
    the parts start and with ALAC sound (no AAC start-up delay, which would
    make ffmpeg start the first part's picture a little after 0); that file
    is the one-file video to compare with, and the parts are cut from it by
    stream copy, so together they hold exactly its frames and sound packets.
    Returns (parts, whole file)."""
    os.makedirs(out_dir, exist_ok=True)
    whole = os.path.join(out_dir, f"whole-{number}.mp4")
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", src, "-map", "0:v", "-map", "0:a", "-c:v", "libx264",
                    "-preset", "veryfast", "-crf", "16", "-bf", "0", "-g", "1000",
                    "-force_key_frames", "expr:eq(n,256)+eq(n,512)", "-pix_fmt", "yuv420p", "-c:a", "alac",
                    whole], check=True)
    pattern = os.path.join(out_dir, "part%d.mp4")
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", whole, "-map", "0", "-c", "copy", "-f", "segment",
                    "-segment_frames", "256,512", "-reset_timestamps", "1", pattern], check=True)
    parts = []
    for i in range(3):
        path = os.path.join(out_dir, f"GX{i + 1:02d}{number}.MP4")
        os.replace(pattern % i, path)
        info = ffprobe(path, "stream=start_time,nb_read_packets")["streams"][0]
        check(float(info["start_time"]) == 0.0,
              f"{os.path.basename(path)}: {info['nb_read_packets']} frames, picture starts at "
              f"{info['start_time']}")
        parts.append(path)
    check(sum((frame_hashes(p) for p in parts), []) == frame_hashes(whole)
          and sum((audio_hashes(p) for p in parts), []) == audio_hashes(whole),
          "the parts hold every frame and sound packet of the one-file video")
    return parts, whole


def audio_hashes(video):
    """MD5 of every sound packet (copied, not decoded)."""
    out = subprocess.run(["ffmpeg", "-v", "error", "-i", video, "-map", "0:a", "-c:a", "copy",
                          "-f", "framemd5", "-"], capture_output=True, text=True, check=True).stdout
    return [line.split(",")[-1].strip() for line in out.splitlines() if not line.startswith("#")]


def export_video(args, pid, body, name):
    """Export and download; returns the file."""
    status, ex = request("POST", f"/api/projects/{pid}/exports", body)
    check(status == 201, f"export {name} queued ({status}: {ex if status != 201 else 'ok'})")
    p = wait_for(pid, lambda p: [e for e in p["exports"] if e["id"] == ex["id"]][0]["status"]
                 in ("done", "failed", "cancelled"))
    e = [e for e in p["exports"] if e["id"] == ex["id"]][0]
    check(e["status"] == "done", f"export {name} done: {e.get('error')}")
    _, _, video = request("GET", f"/api/projects/{pid}/exports/{e['id']}/file", raw=True)
    out = os.path.join(args.work, f"export-{name}.mp4")
    open(out, "wb").write(video)
    return out


WEB_DIR = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..",
                                       "..", "web"))

# The editor's computeFinalPath (web/src/engine/path.ts) on a match's real
# calibration and AI path: the widest frame for each widest view and zoom,
# with a fix zoomed right out (80 deg) in the middle ("+fix") or without.
FINAL_PATH_TS = """
import { readFileSync } from "node:fs";
import { computeFinalPath, normalizeEdits, straightenOfMatch, widestViewMaxFov } from "@ENGINE@";
const [calibFile, aiFile] = process.argv.slice(2);
const calib = JSON.parse(readFileSync(calibFile, "utf8"));
const bytes = readFileSync(aiFile);
const ai = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length));
const n = calib.frameCount;
const out: Record<string, unknown> = { coverageMaxFov: calib.coverage.maxFovDeg };
for (const [zoom, fix] of [[0.5, true], [1, true], [2, true], [2, false]] as const) {
  const raw = { zoom, keyframes: fix ? [{ frame: Math.floor(n / 2), yaw: 0, pitch: 0, fov: 80 }] : [] };
  const edits = normalizeEdits(raw, n, straightenOfMatch(calib.match));
  const free = computeFinalPath(ai, calib, edits);
  for (const w of ["natural", "wide", "widest", null]) {
    const path = computeFinalPath(ai, calib, edits, widestViewMaxFov(w as never));
    let max = 0;
    let same = true;
    for (let i = 0; i < path.length; i++) {
      if (i % 3 === 2) max = Math.max(max, path[i]);
      if (!Object.is(path[i], free[i])) same = false;
    }
    out[`${w ?? "unset"}@${zoom}${fix ? "+fix" : ""}`] = { maxFov: max, sameAsNoLimit: same };
  }
}
console.log(JSON.stringify(out));
"""


def editor_final_path(args, pid, n):
    """Run the editor's own computeFinalPath on this match (bundled with
    esbuild from web/node_modules). None when node or esbuild is missing."""
    esbuild = os.path.join(WEB_DIR, "node_modules", ".bin", "esbuild")
    if not shutil.which("node") or not os.path.exists(esbuild):
        return None
    folder = os.path.join(args.work, "final-path")
    os.makedirs(folder, exist_ok=True)
    _, cal = request("GET", f"/api/projects/{pid}/calibration")
    _, _, ai = request("GET", f"/api/projects/{pid}/ai-path.bin", raw=True)
    check(len(ai) == n * 12, "AI path for the editor check")
    calib_file, ai_file = os.path.join(folder, "calib.json"), os.path.join(folder, "ai.bin")
    with open(calib_file, "w") as f:
        json.dump(cal, f)
    with open(ai_file, "wb") as f:
        f.write(ai)
    entry, bundle = os.path.join(folder, "final.ts"), os.path.join(folder, "final.mjs")
    with open(entry, "w") as f:
        engine = os.path.join(WEB_DIR, "src", "engine", "path.ts").replace("\\", "/")
        f.write(FINAL_PATH_TS.replace("@ENGINE@", engine))
    subprocess.run([esbuild, entry, "--bundle", "--platform=node", "--format=esm",
                    f"--outfile={bundle}", "--log-level=warning"], check=True)
    out = subprocess.run(["node", bundle, calib_file, ai_file], capture_output=True, text=True,
                         check=True).stdout
    return json.loads(out)


def natural_look(args):
    """The "Widest view" (DESIGN.md 4.12): new matches are Natural (like Veo);
    the AI pass keeps to the limit; changing it re-runs in seconds from what
    the AI saw, exactly like a full AI pass; the editor's final path keeps to
    it whatever the zoom and the fixes."""
    import re
    cap = {"natural": 34.0, "wide": 44.0}
    status, p = request("POST", "/api/projects", {"name": "Natural look", "style": "broadcast"})
    check(status == 201 and p["widestView"] == "natural", "a new match is Natural (like Veo)")
    pid = p["id"]
    for side, path in (("left", args.left), ("right", args.right)):
        status, p = upload(pid, side, path)
        check(status == 200, f"{side} uploaded")
    status, p = request("PATCH", f"/api/projects/{pid}", {"widestView": "fisheye"})
    check(status == 400 and p["error"] == "Unknown widest view.", "an unknown widest view is refused")

    # 1. Widest (Reco's preset, as before the setting): a full AI pass.
    status, p = request("PATCH", f"/api/projects/{pid}", {"widestView": "widest"})
    check(status == 200 and p["widestView"] == "widest", "Widest chosen")
    p, widest_secs, text = run_timed(args, pid, quick=False)
    n = p["frameCount"]
    widest = ai_path(pid, n)
    check("Widest view: Widest" in text and "AI camera zoom: 22 to 58 deg tall, starting at 40" in text,
          "the AI pass used Reco's broadcast preset as it is")
    check(p["aiRun"]["widestView"] == "widest", "aiRun says Widest")
    max_widest = max(f for _, _, f in widest)
    log(f"Widest: fov {min(f for _, _, f in widest):.1f}..{max_widest:.1f} deg")
    check(max_widest > cap["natural"] + 0.5, f"Widest zooms out past 34 deg ({max_widest:.1f})")

    # 2. Natural from the Widest run's recording: seconds, and never wider than 34 deg.
    request("PATCH", f"/api/projects/{pid}", {"widestView": "natural"})
    p, natural_quick_secs, text = run_timed(args, pid, quick=True)
    check("Widest view: Natural: the AI camera zooms out to at most 34 deg tall (57 deg across)"
          in text, "the job log names the widest view")
    natural_quick = ai_path(pid, n)
    max_natural = max(f for _, _, f in natural_quick)
    log(f"Natural (quick re-run, {natural_quick_secs:.1f} s): fov "
        f"{min(f for _, _, f in natural_quick):.1f}..{max_natural:.4f} deg")
    check(max_natural <= cap["natural"] + 1e-3, f"Natural never wider than 34 deg ({max_natural:.4f})")
    check(p["aiRun"]["widestView"] == "natural", "aiRun says Natural")
    d = max_diff(natural_quick, widest)
    log(f"Natural vs Widest: yaw {d[0]}, pitch {d[1]}, fov {d[2]:.2f}")
    check(d[0] == 0.0 and d[1] == 0.0 and d[2] > 1.0, "only the zoom changed, not where it looks")

    # 3. A full AI pass with Natural: its own recording replays to it, and it
    # is the quick re-run's path (parity).
    forget_seen(args, pid)
    p, natural_full_secs, text = run_timed(args, pid, quick=False)
    check("AI camera zoom: 22 to 34 deg tall, starting at 34" in text,
          "the AI pass gave Reco the Natural zoom range")
    m = re.search(r"largest difference: yaw ([\d.e+-]+) rad, pitch ([\d.e+-]+) rad, zoom "
                  r"([\d.e+-]+) deg", text)
    check(m is not None and float(m[1]) == float(m[2]) == float(m[3]) == 0.0,
          "the Natural AI pass replays its own recording exactly")
    log(f"PARITY live Natural AI pass vs replay of its recording: yaw {m[1]}, pitch {m[2]}, fov {m[3]}")
    natural_full = ai_path(pid, n)
    d = max_diff(natural_quick, natural_full)
    log(f"PARITY quick Natural (from the Widest run's recording) vs full Natural AI pass: {d}")
    check(max(d) == 0.0, "quick Natural = full Natural AI pass, bit for bit")

    # 4. Wide, and Follow the ball (its fixed zoom), from the recording.
    request("PATCH", f"/api/projects/{pid}", {"widestView": "wide"})
    p, wide_secs, _ = run_timed(args, pid, quick=True)
    wide = ai_path(pid, n)
    max_wide = max(f for _, _, f in wide)
    check(max_natural <= max_wide <= cap["wide"] + 1e-3, f"Wide: at most 44 deg ({max_wide:.2f})")
    request("PATCH", f"/api/projects/{pid}", {"widestView": "natural", "style": "ball"})
    p, _, _ = run_timed(args, pid, quick=True)
    check({round(f, 3) for _, _, f in ai_path(pid, n)} == {34.0}, "Follow the ball: fixed at 34 deg")
    request("PATCH", f"/api/projects/{pid}", {"style": "broadcast"})
    p, _, _ = run_timed(args, pid, quick=True)
    check(max(max_diff(ai_path(pid, n), natural_full)) == 0.0, "back to broadcast: the same path")

    # 5. The editor's final path: the Zoom slider and a fix can't go wider.
    res = editor_final_path(args, pid, n)
    if res is None:
        log("SKIPPED the editor's final path check: needs node and web/node_modules (npm ci)")
    else:
        log(f"editor final path, widest frame (deg): " + ", ".join(
            f"{k} {v['maxFov']:.2f}" for k, v in res.items() if isinstance(v, dict)))
        for case in ("0.5+fix", "1+fix", "2+fix", "2"):
            for w, limit in (("natural", 34.0), ("wide", 44.0)):
                got = res[f"{w}@{case}"]["maxFov"]
                check(got <= limit, f"editor, {w}, zoom {case}: at most {limit:.0f} deg ({got:.2f})")
            check(res[f"widest@{case}"]["sameAsNoLimit"] and res[f"unset@{case}"]["sameAsNoLimit"],
                  f"editor, widest / not set, zoom {case}: exactly the path without a limit")
        check(res["natural@0.5+fix"]["maxFov"] == 34.0 and res["widest@0.5+fix"]["maxFov"] > 34.5,
              "zoomed out: Natural stops at 34 deg, Widest goes wider")
        check(res["natural@2"]["sameAsNoLimit"], "zooming in is not limited")
    log(f"TIMINGS widest view: full AI pass {widest_secs:.1f} s / {natural_full_secs:.1f} s, "
        f"quick re-runs {natural_quick_secs:.1f} s (Natural), {wide_secs:.1f} s (Wide)")
    request("DELETE", f"/api/projects/{pid}")


def chapters(args):
    """GoPro chapter files: the same two videos split into 3 files each and
    sent as parts give exactly the one-file match: frame count, AI camera
    path, preview, and exports across the joins."""
    split = os.path.join(args.work, "chapters")
    left_parts, left_whole = split_gopro(args.left, os.path.join(split, "left"), "0042")
    right_parts, right_whole = split_gopro(args.right, os.path.join(split, "right"), "0077")
    counts = [[int(ffprobe(p, "stream=nb_read_packets")["streams"][0]["nb_read_packets"])
               for p in parts] for parts in (left_parts, right_parts)]
    log(f"chapter files: left {counts[0]} frames, right {counts[1]} frames")

    # The same match from one file per camera.
    status, p = request("POST", "/api/projects", {"name": "One file per camera", "style": "broadcast"})
    single = p["id"]
    for side, path in (("left", left_whole), ("right", right_whole)):
        status, p = upload(single, side, path)
        check(status == 200, f"{side} video uploaded as one file")
    p1, secs1, _ = process(single)
    n = p1["frameCount"]

    # Sent as parts, the right camera's in another order.
    status, p = request("POST", "/api/projects", {"name": "GoPro chapters", "style": "broadcast"})
    pid = p["id"]
    for i, path in enumerate(left_parts):
        status, p = upload(pid, "left", path, (i + 1, 3))
        check(status == 200, f"left part {i + 1} of 3 uploaded")
    check(p["status"] == "new" and [x["name"] for x in p["files"]["left"]["parts"]]
          == [os.path.basename(x) for x in left_parts]
          and p["files"]["left"]["sizeBytes"] == sum(os.path.getsize(x) for x in left_parts),
          "the left video lists its 3 parts and their total size")
    status, _ = request("POST", f"/api/projects/{pid}/process")
    check(status == 400, "processing waits for the right video")
    for i in (2, 0):
        status, p = upload(pid, "right", right_parts[i], (i + 1, 3))
    check(status == 200 and p["status"] == "new" and p["files"]["right"]["parts"][1] is None,
          "right part 2 of 3 still missing: not ready yet")
    status, _ = request("POST", f"/api/projects/{pid}/process")
    check(status == 400, "processing refuses a video with a part missing")
    status, p = upload(pid, "right", right_parts[1], (2, 3))
    check(status == 200 and p["status"] == "uploaded", "all parts there")
    folder = os.path.join(args.data, "projects", pid)
    check(sorted(f for f in os.listdir(folder) if f.startswith(("left", "right")))
          == ["left.001.mp4", "left.002.mp4", "left.003.mp4",
              "right.001.mp4", "right.002.mp4", "right.003.mp4"], "stored as numbered parts")

    p2, secs2, _ = process(pid)
    log(f"processing: one file per camera {secs1:.0f} s, in parts {secs2:.0f} s")
    check(p2["frameCount"] == n and p2["calibration"]["syncOffsetFrames"] == p1["calibration"]["syncOffsetFrames"],
          f"frameCount {p2['frameCount']} = one-file match's {n}, same sync offset")
    check(p2["files"]["left"]["probe"]["frameCount"] == sum(counts[0]),
          f"the left video counts the frames of all its parts ({sum(counts[0])})")
    text = job_log(args, pid)
    check("The left video is 3 files, joined in this order:" in text, "the job log lists the parts")
    # Calibration reads only the first part (the GoPro's motion data is
    # there), so it takes its sample pictures at other moments than from the
    # whole file: a slightly different calibration and camera path.
    d = max_diff(ai_path(pid, n), ai_path(single, n))
    log(f"AI path in parts (calibrated from the first part) vs one file: {d}; calibration "
        f"{p2['calibration']} vs {p1['calibration']}")
    check(p2["calibration"]["confidence"] >= 0.8 and max(d[:2]) < 0.1 and d[2] < 3,
          "calibrated well from the first parts, a similar camera path")
    # With the one-file match's calibration the AI must see exactly the same
    # frames, paired the same way: the same path, bit for bit.
    shutil.copy(os.path.join(args.data, "projects", single, "match.json"),
                os.path.join(args.data, "projects", pid, "match.json"))
    forget_seen(args, pid)
    p2, _, _ = process(pid)
    check("Using the earlier calibration" in job_log(args, pid).split("=== Processing started")[-1],
          "AI run again with the one-file match's calibration")
    d = max_diff(ai_path(pid, n), ai_path(single, n))
    log(f"PARITY AI path in parts vs one file, same calibration: {d}")
    check(max(d) == 0.0, "the AI camera path is the same, frame for frame")
    proxies = []
    for project in (single, pid):
        _, _, data = request("GET", f"/api/projects/{project}/proxy.mp4", raw=True)
        path = os.path.join(args.work, f"proxy-{project}.mp4")
        open(path, "wb").write(data)
        proxies.append(frame_hashes(path))
    check(len(proxies[1]) == n and proxies[0] == proxies[1],
          f"the preview has the same {len(proxies[1])} frames as the one-file match's")

    # Exports across the joins (left frames 256 and 512 are synced 256 and
    # 512, right ones synced 244 and 500 with the 12-frame offset), one
    # starting inside the last part, along the same camera path.
    _, _, path_data = request("GET", f"/api/projects/{single}/ai-path.bin", raw=True)
    segments = [{"startFrame": 200, "endFrame": 300}, {"startFrame": 480, "endFrame": 525},
                {"startFrame": 530, "endFrame": 580}]
    kept = sum(x["endFrame"] - x["startFrame"] for x in segments)
    body = {"segments": segments, "width": 1280, "height": 720, "quality": "fast",
            "pathBase64": base64.b64encode(path_data).decode()}
    one = export_video(args, single, body, "one-file")
    parts = export_video(args, pid, body, "parts")
    a, b = frame_hashes(one), frame_hashes(parts)
    check(len(b) == kept and a == b,
          f"the export from the parts has the same {len(b)} frames as from one file (kept {kept})")
    text = job_log(args, pid)
    check("Part 2: left files 2-3, right files 2-3" in text and "Part 3: left files 3-3, right files 3-3" in text,
          "export parts start reading in the chapter file their first frame is in")
    # The sound: the same packets as from one file, through the joins.
    durations = [{k: float(ffprobe(v, "stream=duration", stream=k)["streams"][0]["duration"])
                  for k in ("v:0", "a:0")} for v in (one, parts)]
    check(all(abs(durations[0][k] - durations[1][k]) < 0.005 for k in ("v:0", "a:0")),
          f"the same length of picture and sound as from one file ({durations[1]}, {durations[0]})")
    a, b = audio_hashes(one), audio_hashes(parts)
    check(a == b, f"the export from the parts has the same {len(b)} sound packets as from one file")
    for project in (single, pid):
        request("DELETE", f"/api/projects/{project}")


def straighten_checks(args, pid, poses, frame_count):
    """Straighten picture (DESIGN.md 4.3/5.5): rigTiltDeg / rigRollDeg go to
    every part's calibration; 0/0 gives the same video as no setting; bad
    values are refused in plain words; match.json is not changed. Saves the
    straightened export, its path and match.json for the browser comparison
    (straighten-out/ in the work folder)."""
    folder = os.path.join(args.data, "projects", pid)
    with open(os.path.join(folder, "match.json"), "rb") as f:
        match_before = f.read()
    # A short part: far left, then far right (world poses for Reco's Panner).
    path = list(poses)
    for f in range(20, 80):
        path[f] = (1.0, 0.0, 30.0) if f < 50 else (-0.9, 0.05, 35.0)
    base = {"segments": [{"startFrame": 20, "endFrame": 80}], "width": 1280, "height": 720,
            "quality": "high", "pathBase64": base64.b64encode(data_path(path)).decode()}

    _, before = request("GET", f"/api/projects/{pid}")
    for extra, words in (({"rigTiltDeg": 40}, "tilt must be between -35 and 35 degrees"),
                         ({"rigTiltDeg": 10, "rigRollDeg": -26}, "level must be between -25 and 25 degrees"),
                         ({"rigRollDeg": None}, "level is not a number")):
        status, res = request("POST", f"/api/projects/{pid}/exports", {**base, **extra})
        check(status == 400 and words in res["error"], f"refused {extra}: {res.get('error')}")
    status, res = request("POST", f"/api/projects/{pid}/exports", {**base, "rigTiltDeg": "5"})
    check(status == 400, f"refused a tilt that is not a number: {res}")
    _, after = request("GET", f"/api/projects/{pid}")
    check(len(after["exports"]) == len(before["exports"]), "nothing queued by refused requests")

    def export(extra, name):
        status, ex = request("POST", f"/api/projects/{pid}/exports", {**base, **extra})
        check(status == 201, f"export {name} queued")
        p = wait_for(pid, lambda p: [e for e in p["exports"] if e["id"] == ex["id"]][0]["status"]
                     in ("done", "failed", "cancelled"))
        e = [e for e in p["exports"] if e["id"] == ex["id"]][0]
        check(e["status"] == "done", f"export {name} done: {e.get('error')}")
        status, _, video = request("GET", f"/api/projects/{pid}/exports/{e['id']}/file", raw=True)
        out = os.path.join(args.work, f"export-{name}.mp4")
        open(out, "wb").write(video)
        v = ffprobe(out, "stream=nb_read_packets")["streams"][0]
        check(int(v["nb_read_packets"]) == 60, f"export {name} has 60 frames")
        request("DELETE", f"/api/projects/{pid}/exports/{e['id']}")
        return out

    plain = export({}, "plain")
    zero = export({"rigTiltDeg": 0, "rigRollDeg": 0}, "zero")
    check(framemd5(plain) == framemd5(zero), "0/0 straightening gives exactly the same frames as none")
    tilt_deg, roll_deg = -14.3239, 2.8648  # about -0.25 and 0.05 rad
    straight = export({"rigTiltDeg": tilt_deg, "rigRollDeg": roll_deg}, "straight")
    check(framemd5(straight) != framemd5(plain), "the straightened export is different")
    with open(os.path.join(folder, "match.json"), "rb") as f:
        check(f.read() == match_before, "match.json on disk is unchanged")
    with open(os.path.join(folder, "log.txt"), encoding="utf-8", errors="replace") as f:
        log_text = f.read()
    check("Straighten picture: rig tilt -14.32 deg, roll 2.86 deg" in log_text
          and "rig tilt 0.00 deg, roll 0.00 deg (from match.json)" in log_text,
          "the job log names the straightening used")

    # For the browser comparison (web/tests/engine/parity.pw.ts).
    out_dir = os.path.join(args.work, "straighten-out")
    os.makedirs(out_dir, exist_ok=True)
    shutil.copy(straight, os.path.join(out_dir, "export.mp4"))
    shutil.copy(plain, os.path.join(out_dir, "export-plain.mp4"))
    _, cal = request("GET", f"/api/projects/{pid}/calibration")
    json.dump({"match": cal["match"], "coverage": cal["coverage"], "rigTiltDeg": tilt_deg,
               "rigRollDeg": roll_deg, "segmentStart": 20,
               "path": {str(f): path[f] for f in range(20, 80)}},
              open(os.path.join(out_dir, "info.json"), "w"))


def data_path(poses):
    return b"".join(struct.pack("<3f", *p) for p in poses)


def png_rgba(width, height, boxes):
    """A see-through PNG with boxes [(x, y, w, h, (r, g, b, a))], later ones on top."""
    rows = []
    for y in range(height):
        row = bytearray(width * 4)
        for bx, by, bw, bh, rgba in boxes:
            if by <= y < by + bh:
                row[bx * 4:(bx + bw) * 4] = bytes(rgba) * bw
        rows.append(b"\0" + bytes(row))

    def chunk(kind, data):
        return (struct.pack(">I", len(data)) + kind + data
                + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF))

    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(b"".join(rows), 9)) + chunk(b"IEND", b""))


def patches(video, x, y, size=16):
    """Average colour of a size x size patch at (x, y) in every frame."""
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", video, "-vf",
                          f"crop={size}:{size}:{x}:{y},scale=1:1:flags=area",
                          "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
                         capture_output=True, check=True).stdout
    return [tuple(raw[i:i + 3]) for i in range(0, len(raw), 3)]


def luma(c):
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]


def text_checks(args, pid, body, plain_video, kept):
    """Text boxes (DESIGN.md 5.4): refused when wrong, burned in exactly
    during their times, temp files cleaned up, cancel honoured."""
    w, h = body["width"], body["height"]
    b64 = lambda data: base64.b64encode(data).decode()
    # Like the editor's: a see-through dark box with light "text" (an opaque
    # magenta stripe, a colour the footage never has), top left.
    title = png_rgba(w, h, [(40, 30, 360, 90, (8, 12, 18, 184)), (70, 60, 300, 30, (255, 0, 255, 255))])
    # An opaque cyan box bottom right, shown twice.
    tag = png_rgba(w, h, [(w - 260, h - 110, 220, 70, (0, 255, 255, 255))])
    fps = 30
    overlays = [{"pngBase64": b64(title), "ranges": [[2.0, 5.0]]},           # frames 60..149
                {"pngBase64": b64(tag), "ranges": [[0.0, 1.0], [8.0, 9.5]]}]  # 0..29, 240..284

    # Refused in plain words, and nothing is queued.
    _, before = request("GET", f"/api/projects/{pid}")
    bad = [
        ("a picture of the wrong size", [{"pngBase64": b64(png_rgba(640, 360, [])), "ranges": [[0, 1]]}],
         "different video size"),
        ("something that is not a PNG", [{"pngBase64": b64(b"GIF89a" + bytes(40)), "ranges": [[0, 1]]}],
         "could not be read"),
        ("times out of order", [{"pngBase64": b64(tag), "ranges": [[3, 4], [1, 2]]}], "not valid"),
        ("a negative time", [{"pngBase64": b64(tag), "ranges": [[-1, 2]]}], "not valid"),
        ("an end before the start", [{"pngBase64": b64(tag), "ranges": [[2, 1]]}], "not valid"),
        ("NaN (sent as null)", [{"pngBase64": b64(tag), "ranges": [[None, 2]]}], "not valid"),
        ("51 texts", [{"pngBase64": b64(tag), "ranges": [[0, 1]]}] * 51, "at most 50"),
    ]
    for what, ov, words in bad:
        status, res = request("POST", f"/api/projects/{pid}/exports", {**body, "overlays": ov})
        check(status == 400 and words in res.get("error", ""),
              f"refused {what}: {status} {res.get('error')!r}")
    _, after = request("GET", f"/api/projects/{pid}")
    check(len(after["exports"]) == len(before["exports"]), "nothing queued by refused requests")

    # Export with two text boxes.
    seen = set()
    status, ex = request("POST", f"/api/projects/{pid}/exports", {**body, "overlays": overlays})
    check(status == 201, f"export with text queued {ex}")
    t0 = time.time()
    progress = []

    def done(p):
        e = [e for e in p["exports"] if e["id"] == ex["id"]][0]
        progress.append(e["progress"])
        return e["status"] in ("done", "failed", "cancelled")

    p = wait_for(pid, done, seen=seen)
    ex = [e for e in p["exports"] if e["id"] == ex["id"]][0]
    log(f"export with text took {time.time() - t0:.0f} s: {ex}")
    check(ex["status"] == "done", f"export with text done ({ex.get('error')})")
    check({("ready", "export"), ("ready", "overlay")} <= seen,
          f"steps include Adding text: {sorted(seen, key=str)}")
    check(all(a <= b + 1e-9 for a, b in zip(progress, progress[1:])),
          "export progress only moves forward")
    folder = os.path.join(args.data, "projects", pid, "exports", ex["id"])
    check(os.listdir(folder) == [ex["fileName"]], f"only the video is left: {os.listdir(folder)}")

    out = os.path.join(args.work, "export-text.mp4")
    status, _, video = request("GET", f"/api/projects/{pid}/exports/{ex['id']}/file", raw=True)
    open(out, "wb").write(video)
    v = ffprobe(out, "stream=width,height,nb_read_packets,codec_name")["streams"][0]
    a = ffprobe(out, "stream=codec_name", stream="a:0")["streams"]
    dur = float(ffprobe(out, "format=duration")["format"]["duration"])
    check(v["width"] == w and v["height"] == h and v["codec_name"] == "h264"
          and int(v["nb_read_packets"]) == kept and abs(dur - kept / fps) < 0.1 and len(a) == 1,
          f"export with text: {v}, {dur:.3f} s, audio {a}")
    check(0 <= video.find(b"moov") < video.find(b"mdat"), "export with text is faststart")

    # Frame by frame against the same export without text.
    plain = {k: patches(plain_video, *xy) for k, xy in
             {"stripe": (210, 67), "box": (330, 90), "tag": (w - 160, h - 85), "free": (w // 2, h // 2)}.items()}
    text = {k: patches(out, *xy) for k, xy in
            {"stripe": (210, 67), "box": (330, 90), "tag": (w - 160, h - 85), "free": (w // 2, h // 2)}.items()}
    check(all(len(x) == kept for x in list(plain.values()) + list(text.values())), "patches of every frame")
    magenta = lambda c: c[0] > 200 and c[1] < 80 and c[2] > 200
    cyan = lambda c: c[0] < 80 and c[1] > 200 and c[2] > 200
    wrong = []
    title_on = range(60, 150)
    tag_on = list(range(0, 30)) + list(range(240, 285))
    for k in range(kept):
        darker = luma(plain["box"][k]) - luma(text["box"][k])
        if k in title_on:
            ok = magenta(text["stripe"][k]) and darker > 0.5 * luma(plain["box"][k]) - 12
        else:
            ok = not magenta(text["stripe"][k]) and abs(darker) < 15
        if k in tag_on:
            ok = ok and cyan(text["tag"][k])
        else:
            ok = ok and not cyan(text["tag"][k]) and abs(luma(plain["tag"][k]) - luma(text["tag"][k])) < 15
        ok = ok and abs(luma(plain["free"][k]) - luma(text["free"][k])) < 15
        if not ok:
            wrong.append((k, text["stripe"][k], plain["box"][k], text["box"][k], text["tag"][k]))
    check(not wrong, f"text shows on exactly frames 60-149 (title) and 0-29, 240-284 (tag) of {kept}; "
          f"wrong: {wrong[:5]}")
    log(f"  title frame 59/60/149/150 stripe: {[text['stripe'][k] for k in (59, 60, 149, 150)]}; "
        f"box luma plain/text at 100: {luma(plain['box'][100]):.0f}/{luma(text['box'][100]):.0f}")

    # Stop while adding text: cancelled, nothing left behind.
    status, ex3 = request("POST", f"/api/projects/{pid}/exports",
                          {**body, "quality": "high", "overlays": overlays})
    check(status == 201, "second export with text queued")
    deadline = time.time() + 1800
    while time.time() < deadline:
        _, p = request("GET", f"/api/projects/{pid}")
        job = p.get("job") or {}
        if job.get("step") == "overlay" and (job.get("framesDone") or 0) > 0:
            break
        time.sleep(0.05)
    e3 = [e for e in p["exports"] if e["id"] == ex3["id"]][0]
    check(job.get("step") == "overlay" and job.get("message") == "Adding text" and e3["progress"] >= 0.6,
          f"caught it adding text: {job.get('framesDone')}/{job.get('framesTotal')} frames, "
          f"export at {e3['progress']:.2f}")
    request("POST", f"/api/projects/{pid}/cancel")
    p = wait_for(pid, lambda p: p["job"] is None)
    e3 = [e for e in p["exports"] if e["id"] == ex3["id"]][0]
    folder3 = os.path.join(args.data, "projects", pid, "exports", ex3["id"])
    check(e3["status"] == "cancelled" and not os.path.exists(folder3),
          "stopped while adding text, its folder removed")

    for e in (ex, e3):
        status, p = request("DELETE", f"/api/projects/{pid}/exports/{e['id']}")
    check(status == 200 and len(p["exports"]) == 1, "text exports deleted")


if __name__ == "__main__":
    main()

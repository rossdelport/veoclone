#!/usr/bin/env python3
"""End-to-end test of a running-from-scratch veoclone-helper over HTTP.

Starts the helper binary, uploads two videos, processes them, checks the
editor data, exports two segments, and exercises cancel, delete, restart
recovery, CORS and the Host check. Python 3 standard library only; needs
ffprobe on PATH.

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


def upload(pid, side, path):
    conn = http.client.HTTPConnection("127.0.0.1", PORT, timeout=600)
    size = os.path.getsize(path)
    conn.putrequest("PUT", f"/api/projects/{pid}/files/{side}", skip_host=True)
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

    def start(self):
        cmd = [self.args.helper, "--no-open", "--port", str(PORT),
               "--data-dir", self.args.data, "--model", self.args.model]
        if self.args.web_dir:
            cmd += ["--web-dir", self.args.web_dir]
        self.proc = subprocess.Popen(cmd, stdout=open(self.args.log, "a"),
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
    args = ap.parse_args()
    shutil.rmtree(args.work, ignore_errors=True)
    os.makedirs(args.work)
    args.data = os.path.join(args.work, "data")
    args.log = os.path.join(args.work, "helper.log")
    helper = Helper(args)
    helper.start()
    try:
        run(args, helper)
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

    status, lenses = request("GET", "/api/lenses")
    check(status == 200 and len(lenses) > 50, f"{len(lenses)} iPhone lenses, first {lenses[0]}")

    # Create + upload.
    status, p = request("POST", "/api/projects", {"name": "E2E match", "style": "broadcast"})
    check(status == 201 and p["status"] == "new", "project created")
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

    # Re-run AI with another style and cancel it during tracking.
    request("PATCH", f"/api/projects/{pid}", {"style": "action"})
    request("POST", f"/api/projects/{pid}/process")
    wait_for(pid, lambda p: (p.get("job") or {}).get("step") == "track"
             and (p["job"].get("framesDone") or 0) > 10)
    request("POST", f"/api/projects/{pid}/cancel")
    p = wait_for(pid, lambda p: p["status"] in ("cancelled", "ready", "failed"))
    check(p["status"] == "cancelled" and p["error"] is None, "processing cancelled")

    # Restart while processing: the project must come back as failed.
    request("POST", f"/api/projects/{pid}/process")
    wait_for(pid, lambda p: p["status"] == "processing")
    helper.kill()
    log("helper killed during processing; restarting")
    helper.start()
    _, p = request("GET", f"/api/projects/{pid}")
    check(p["status"] == "failed" and "closed" in p["error"]["message"] and p["job"] is None,
          f"interrupted job marked failed: {p['error']}")

    # Try again (calibration + preview are reused, AI re-runs).
    request("POST", f"/api/projects/{pid}/process")
    p = wait_for(pid, lambda p: p["status"] in ("ready", "failed", "cancelled"))
    check(p["status"] == "ready" and p["style"] == "action", "Try again succeeds")

    # Choosing an iPhone model re-calibrates with that lens profile.
    lens = lenses[0]
    status, p = request("PATCH", f"/api/projects/{pid}", {"lensId": lens["id"]})
    check(status == 200 and p["lensId"] == lens["id"] and "calibration" not in p,
          "lens chosen, calibration will be redone")
    request("POST", f"/api/projects/{pid}/process")
    seen = set()
    p = wait_for(pid, lambda p: p["status"] in ("ready", "failed", "cancelled"), seen=seen)
    check(p["status"] == "ready" and p["calibration"]["lens"] == lens["label"]
          and ("processing", "calibrate") in seen and ("processing", "proxy") in seen,
          f"re-processed with lens {p.get('calibration')}, warnings {p['warnings']}")

    # Delete.
    folder = os.path.join(args.data, "projects", pid)
    status, _ = request("DELETE", f"/api/projects/{pid}")
    check(status == 200 and not os.path.exists(folder), "project deleted with its folder")
    status, _ = request("GET", f"/api/projects/{pid}")
    check(status == 404, "deleted project is gone")


def data_path(poses):
    return b"".join(struct.pack("<3f", *p) for p in poses)


if __name__ == "__main__":
    main()

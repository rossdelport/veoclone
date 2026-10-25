#!/usr/bin/env python3
"""End-to-end test of VeoClone updating itself (DESIGN.md 4.11), on Linux.

Builds the helper twice with different build identities (an "old" and a
"new" version, as CI would embed them), puts the old one in a pretend
VeoClone folder, serves a pretend release (latest.json + VeoClone-windows.zip
holding the new one) from a local web server, and checks that:

  A. a damaged download is refused: the old version keeps running, nothing in
     the folder changes, nothing is left behind;
  B. the right one is downloaded, checked, swapped in and started by itself
     (no change made through the API, so no quiet time to wait for); the new
     version runs from the same folder with the same options plus
     --updated-from, opens no second browser tab, and removes the old files
     (only the old version's own files; the user's file stays);
  C. while a video is being received the update waits ("Install now" says
     busy), and installs on "Install now" once it is done; the match and its
     video are still there afterwards;
  D. a new version that does not start is undone: the old one keeps running
     with its own files.

Python 3 standard library only.

Usage (from the repository root; the ONNX Runtime variables as for
`cargo test -p veoclone-helper`):
  update_e2e.py --work /tmp/veoclone-update-e2e
  update_e2e.py --old-bin A --new-bin B   # skip the builds (A and B built with
                                          # the SHAs and dates below)
"""

import argparse
import http.client
import http.server
import json
import hashlib
import os
import shutil
import signal
import subprocess
import sys
import threading
import time
import zipfile

PORT = 47881
OLD_SHA = "1111111111111111111111111111111111111111"
OLD_DATE = "2026-10-01T08:00:00Z"
NEW_SHA = "2222222222222222222222222222222222222222"
NEW_DATE = "2026-10-20T08:00:00Z"
EXE = "VeoClone"  # app_exe() on Linux


def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def check(cond, what):
    if not cond:
        raise SystemExit(f"FAILED: {what}")
    log(f"ok: {what}")


def request(method, path, body=None, timeout=30):
    conn = http.client.HTTPConnection("127.0.0.1", PORT, timeout=timeout)
    headers = {"Host": f"127.0.0.1:{PORT}"}
    if isinstance(body, (dict, list)):
        body = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    conn.request(method, path, body=body, headers=headers)
    res = conn.getresponse()
    data = res.read()
    conn.close()
    try:
        return res.status, json.loads(data) if data else None
    except ValueError:
        return res.status, data


def health():
    try:
        status, body = request("GET", "/api/health", timeout=3)
        return body if status == 200 else None
    except OSError:
        return None


def wait_for(what, cond, timeout=90):
    start = time.time()
    while time.time() - start < timeout:
        value = cond()
        if value:
            return value
        time.sleep(0.2)
    raise SystemExit(f"FAILED: timed out waiting for {what}")


def build(repo, sha, date, out):
    env = dict(os.environ, VEOCLONE_BUILD_SHA=sha, VEOCLONE_BUILD_DATE=date)
    log(f"building the helper as {sha[:7]} ({date})")
    subprocess.run(["cargo", "build", "-p", "veoclone-helper"], cwd=repo, env=env, check=True)
    shutil.copy2(os.path.join(repo, "target", "debug", "veoclone-helper"), out)
    version = subprocess.run([out, "--version"], capture_output=True, text=True, check=True).stdout
    check(f"build {sha[:7]}" in version, f"{os.path.basename(out)} --version names its build: {version.strip()}")


# ---------------------------------------------------------------------------
# The pretend release
# ---------------------------------------------------------------------------

RELEASE = {}  # path -> bytes


class Release(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body = RELEASE.get(self.path)
        if body is None:
            self.send_response(404)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        self.send_response(200)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


def make_zip(path, files):
    """files: {relative name: (bytes, executable)} below VeoClone/."""
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        for name, (data, executable) in sorted(files.items()):
            info = zipfile.ZipInfo(f"VeoClone/{name}", date_time=(2026, 10, 20, 8, 0, 0))
            info.create_system = 3
            info.external_attr = (0o100755 if executable else 0o100644) << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            z.writestr(info, data)


def version_json(sha, names):
    return json.dumps({"sha": sha, "date": "x", "files": sorted(set(names) | {"version.json"})}).encode()


def publish(zip_bytes, sha, date, described=None):
    described = zip_bytes if described is None else described
    RELEASE["/rel/VeoClone-windows.zip"] = zip_bytes
    RELEASE["/rel/latest.json"] = json.dumps({
        "sha": sha,
        "date": date,
        "zipSize": len(described),
        "zipSha256": hashlib.sha256(described).hexdigest(),
    }).encode()


def new_release(work, new_bin, program=None):
    files = {
        EXE: (program if program is not None else open(new_bin, "rb").read(), True),
        "web/index.html": (b"<html>new editor</html>", False),
        "new-only.dll": (b"new dll", False),
    }
    files["version.json"] = (version_json(NEW_SHA, files), False)
    path = os.path.join(work, "release.zip")
    make_zip(path, files)
    return open(path, "rb").read()


# ---------------------------------------------------------------------------
# The pretend VeoClone folder and the running helper
# ---------------------------------------------------------------------------

def make_install(work, name, old_bin):
    root = os.path.join(work, name)
    shutil.rmtree(root, ignore_errors=True)
    install = os.path.join(root, "VeoClone")
    os.makedirs(os.path.join(install, "web"))
    shutil.copy2(old_bin, os.path.join(install, EXE))
    files = {
        "web/index.html": b"<html>old editor</html>",
        "old-only.dll": b"old dll",
    }
    for rel, data in files.items():
        with open(os.path.join(install, rel), "wb") as f:
            f.write(data)
    with open(os.path.join(install, "version.json"), "wb") as f:
        f.write(version_json(OLD_SHA, [EXE, *files]))
    # Not VeoClone's: must never be touched.
    with open(os.path.join(install, "my notes.txt"), "w") as f:
        f.write("mine")
    data = os.path.join(root, "data")
    os.makedirs(data)
    with open(os.path.join(data, "my video.mp4"), "wb") as f:
        f.write(b"precious")
    return install, data


def snapshot(install):
    """Every file of the folder with its contents (not the update's own folder and lock)."""
    out = {}
    for base, dirs, files in os.walk(install):
        dirs[:] = [d for d in dirs if d != ".veoclone-update"]
        for name in files:
            if name == ".veoclone-update.lock":
                continue
            p = os.path.join(base, name)
            out[os.path.relpath(p, install)] = open(p, "rb").read()
    return out


def processes_using(data):
    """PIDs whose command line contains `data` (the run's data folder)."""
    found = []
    for pid in os.listdir("/proc"):
        if not pid.isdigit():
            continue
        try:
            cmd = open(f"/proc/{pid}/cmdline", "rb").read().split(b"\0")
        except OSError:
            continue
        if data.encode() in cmd:
            found.append((int(pid), [c.decode(errors="replace") for c in cmd if c]))
    return found


def stop_all(data):
    for pid, _ in processes_using(data):
        try:
            os.kill(pid, signal.SIGKILL)
        except OSError:
            pass
    wait_for("the helpers to stop", lambda: not processes_using(data), 20)


def start(install, data, env, open_browser=False):
    args = [os.path.join(install, EXE), "--port", str(PORT), "--data-dir", data]
    if not open_browser:
        args.append("--no-open")
    log_file = open(os.path.join(os.path.dirname(install), "helper.log"), "ab")
    p = subprocess.Popen(args, env=env, stdout=log_file, stderr=subprocess.STDOUT, cwd=os.path.dirname(install))
    h = wait_for("the helper to answer", health)
    return p, h


def update_state(want):
    def cond():
        h = health()
        return h if h and h["update"]["state"] in want else None
    return cond


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--work", default="/tmp/veoclone-update-e2e")
    ap.add_argument("--repo", default=os.getcwd())
    ap.add_argument("--old-bin")
    ap.add_argument("--new-bin")
    a = ap.parse_args()
    work = os.path.abspath(a.work)
    os.makedirs(work, exist_ok=True)

    old_bin = a.old_bin or os.path.join(work, "old-bin")
    new_bin = a.new_bin or os.path.join(work, "new-bin")
    if not a.old_bin:
        build(a.repo, OLD_SHA, OLD_DATE, old_bin)
    if not a.new_bin:
        build(a.repo, NEW_SHA, NEW_DATE, new_bin)

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Release)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{server.server_address[1]}/rel"

    # A pretend browser: the helper opens tabs with xdg-open.
    fake_bin = os.path.join(work, "fake-bin")
    os.makedirs(fake_bin, exist_ok=True)
    opened = os.path.join(work, "browser-opened.txt")
    with open(os.path.join(fake_bin, "xdg-open"), "w") as f:
        f.write(f'#!/bin/sh\necho "$@" >> "{opened}"\n')
    os.chmod(os.path.join(fake_bin, "xdg-open"), 0o755)

    env = {k: v for k, v in os.environ.items() if "proxy" not in k.lower()}
    env["VEOCLONE_UPDATE_URL"] = url
    env["PATH"] = fake_bin + os.pathsep + env.get("PATH", "")
    env["RUST_LOG"] = "info"

    release = new_release(work, new_bin)
    new_program = open(new_bin, "rb").read()
    old_program = open(old_bin, "rb").read()

    # ------------------------------------------------------------------
    log("A. a damaged download is refused")
    install, data = make_install(work, "a", old_bin)
    before = snapshot(install)
    damaged = bytearray(release)
    damaged[len(damaged) // 2] ^= 0xFF
    publish(bytes(damaged), NEW_SHA, NEW_DATE, described=release)
    if os.path.exists(opened):
        os.remove(opened)
    p, h = start(install, data, env, open_browser=True)
    try:
        check(h["version"]["sha"] == OLD_SHA, "the old version runs")
        check(h["version"]["date"] == OLD_DATE, "with its build date")
        check(h["update"]["canUpdate"] is True and h["update"]["auto"] is True, "it can update itself")
        h = wait_for("the check", update_state({"failed"}), 60)
        check("didn't download properly" in h["update"]["message"], f"plain message: {h['update']['message']}")
        check(h["version"]["sha"] == OLD_SHA and p.poll() is None, "the old version still runs")
        check(snapshot(install) == before, "nothing in the VeoClone folder changed")
        check(os.listdir(os.path.join(data, "updates")) == [], "the damaged download was deleted")
        wait_for("the browser tab", lambda: os.path.exists(opened), 10)

        # --------------------------------------------------------------
        log("B. the right one installs by itself")
        publish(release, NEW_SHA, NEW_DATE)
        status, body = request("POST", "/api/update/check")
        check(status == 200, "Check for updates is accepted")
        seen = set()

        def updated():
            h = health()
            if h:
                seen.add(h["update"]["state"])
                if h["version"]["sha"] == NEW_SHA:
                    return h
            return None
        h = wait_for("the new version", updated, 120)
        check({"ready", "installing"} & seen, f"it said so on the way ({sorted(seen)})")
        check(p.wait(10) == 0, "the old version ended by itself")
        check(h["version"]["date"] == NEW_DATE, "the new version answers on the same port")
        check(h["update"]["message"] == "VeoClone updated itself to the newest version.", "and says it was updated")
        procs = processes_using(data)
        check(len(procs) == 1, f"one VeoClone runs ({procs})")
        cmd = procs[0][1]
        check(cmd[0] == os.path.join(install, EXE), "from the same folder")
        check(cmd[1:5] == ["--port", str(PORT), "--data-dir", data] and cmd[-2:] == ["--updated-from", OLD_SHA],
              f"with the same options plus --updated-from ({cmd[1:]})")
        lines = open(opened).read().splitlines()
        check(len(lines) == 1, "no second browser tab was opened")

        def tidy():
            leftovers = [f for f in snapshot(install) if f.endswith(".old")]
            return not leftovers and not os.path.exists(os.path.join(install, ".veoclone-update"))
        wait_for("the old files to go", tidy, 30)
        after = snapshot(install)
        check(after[EXE] == new_program, "VeoClone is the new program")
        check(after["web/index.html"] == b"<html>new editor</html>", "with the new editor")
        check(after["new-only.dll"] == b"new dll", "new files were added")
        check("old-only.dll" not in after, "files of the old version only were removed")
        check(after["my notes.txt"] == b"mine", "the user's own file was not touched")
        check(json.loads(after["version.json"])["sha"] == NEW_SHA, "version.json is the new one")
        check(open(os.path.join(data, "my video.mp4"), "rb").read() == b"precious", "the data folder is untouched")
        wait_for("the zip to be removed", lambda: os.listdir(os.path.join(data, "updates")) == [], 20)
        h = wait_for("the next check", lambda: (lambda x: x if x and "latest" in x["update"] else None)(health()), 30)
        check(h["update"]["state"] == "up-to-date" and h["update"]["latest"]["sha"] == NEW_SHA,
              "the new version finds itself up to date")
    finally:
        stop_all(data)

    # ------------------------------------------------------------------
    log("C. it waits while a video is being received")
    install, data = make_install(work, "c", old_bin)
    p, h = start(install, data, env)
    try:
        status, project = request("POST", "/api/projects", {"name": "Saturday"})
        check(status == 201, "a match was made")
        h = wait_for("the update to be ready", update_state({"ready"}), 60)
        check(h["update"]["message"].startswith("Update ready"), f"says: {h['update']['message']}")
        # A video being sent, slowly.
        conn = http.client.HTTPConnection("127.0.0.1", PORT, timeout=60)
        conn.putrequest("PUT", f"/api/projects/{project['id']}/files/left", skip_host=True)
        conn.putheader("Host", f"127.0.0.1:{PORT}")
        conn.putheader("Content-Length", "2000000")
        conn.putheader("X-Filename", "left.mp4")
        conn.endheaders()
        conn.send(b"\0" * 1_000_000)
        time.sleep(1)
        status, body = request("POST", "/api/update/install")
        check(status == 409 and "busy" in body["error"], f"Install now waits: {body}")
        time.sleep(12)  # more than one look at whether it is idle
        h = health()
        check(h["version"]["sha"] == OLD_SHA and h["update"]["state"] == "ready",
              "nothing is installed while the video comes in (and changes were made just now)")
        conn.send(b"\0" * 1_000_000)
        res = conn.getresponse()
        res.read()
        check(res.status == 200, "the video arrived")
        status, body = request("POST", "/api/update/install")
        check(status == 202, "Install now is accepted once it is idle")
        h = wait_for("the new version", lambda: (lambda x: x if x and x["version"]["sha"] == NEW_SHA else None)(health()), 60)
        status, projects = request("GET", "/api/projects")
        check(len(projects) == 1 and projects[0]["files"]["left"]["sizeBytes"] == 2_000_000,
              "the match and its video are still there")
    finally:
        stop_all(data)

    # ------------------------------------------------------------------
    log("D. a new version that does not start is undone")
    install, data = make_install(work, "d", old_bin)
    broken = new_release(work, new_bin, program=b"#!/bin/sh\nexit 3\n")
    publish(broken, NEW_SHA, NEW_DATE)
    before = snapshot(install)
    p, h = start(install, data, env)
    try:
        h = wait_for("the try", update_state({"failed"}), 90)
        check("didn't start" in h["update"]["message"], f"plain message: {h['update']['message']}")
        check(h["version"]["sha"] == OLD_SHA and p.poll() is None, "the old version still runs")
        after = snapshot(install)
        check(after == before, "its files are all back")
        check(snapshot(install)[EXE] == old_program, "the old program is in place")
    finally:
        stop_all(data)

    server.shutdown()
    log("All update tests passed")


if __name__ == "__main__":
    main()

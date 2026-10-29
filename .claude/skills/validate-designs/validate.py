#!/usr/bin/env python3
"""Validate the design comparison page (designs/index.html) in a real browser.

Drives headless Chrome over the DevTools protocol (stdlib only, no Playwright)
in *real time* -- `chrome --screenshot` freezes CSS transitions and SSE, which
hides exactly the bugs this exists to catch. For every data-mode button on the
page (Live, Load sweep, Peak, Sensors missing, ...) it:

  * clicks the button, waits, and probes every tile's iframe (same origin, so
    the DOM is readable): document loaded, no 404, no broken <img>, not stale,
    readouts bound (not dashes) or deliberately blanked (null mode), values
    moving over time, no page overflow, no clipped text, iframe scale correct;
  * watches the network: failed requests, and requests that never complete --
    the signature of Chrome's 6-connections-per-host limit being eaten by
    long-lived EventSource streams;
  * collects console errors and uncaught exceptions from the page and frames;
  * saves an overview screenshot plus one 1024-wide shot per tile for a human
    (or Claude) to look at.

Exit status: 0 all pass (warnings allowed), 1 any FAIL, 2 could not run.

usage: validate.py [--base URL] [--out DIR] [--wait S] [--no-tiles]
"""

import argparse
import base64
import json
import os
import re
import select
import shutil
import socket
import struct
import subprocess
import sys
import tempfile
import time
import urllib.request

STALL_S = 3.0        # a non-stream request older than this with no response is stalled
MAX_LIVE_DASHES = 6  # a bound panel may legitimately dash a few absent sensors
MIN_NULL_DASHES = 8  # with every sensor null, most readouts must show a dash
CONN_LIMIT = 6       # Chrome's HTTP/1.1 connections per host


# --------------------------------------------------------------------- CDP --

class CDP:
    """Just enough of a WebSocket + DevTools client to drive one page."""

    def __init__(self, ws_url):
        hostport, path = ws_url[len("ws://"):].split("/", 1)
        host, port = hostport.rsplit(":", 1)
        self.sock = socket.create_connection((host, int(port)))
        key = base64.b64encode(os.urandom(16)).decode()
        self.sock.sendall(
            f"GET /{path} HTTP/1.1\r\nHost: {hostport}\r\nUpgrade: websocket\r\n"
            f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\n"
            "Sec-WebSocket-Version: 13\r\n\r\n".encode())
        buf = b""
        while b"\r\n\r\n" not in buf:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise ConnectionError("DevTools websocket handshake failed")
            buf += chunk
        head, self.buf = buf.split(b"\r\n\r\n", 1)
        if b" 101 " not in head.split(b"\r\n", 1)[0]:
            raise ConnectionError("DevTools refused websocket: " + head.decode(errors="replace"))
        self.next_id = 0
        self.listeners = []

    def _exact(self, n):
        while len(self.buf) < n:
            chunk = self.sock.recv(1 << 20)
            if not chunk:
                raise ConnectionError("DevTools socket closed")
            self.buf += chunk
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def _message(self):
        data = b""
        while True:
            b0, b1 = self._exact(2)
            n = b1 & 0x7F
            if n == 126:
                n = struct.unpack(">H", self._exact(2))[0]
            elif n == 127:
                n = struct.unpack(">Q", self._exact(8))[0]
            if b1 & 0x80:
                self._exact(4)          # servers don't mask, but be tolerant
            payload = self._exact(n)
            op = b0 & 0x0F
            if op == 8:
                raise ConnectionError("DevTools closed the websocket")
            if op in (9, 10):
                continue
            data += payload
            if b0 & 0x80:
                return json.loads(data)

    def _read(self, timeout):
        # Only start a frame once bytes are waiting, so a timeout can never
        # leave half a frame consumed.
        if not self.buf:
            ready, _, _ = select.select([self.sock], [], [], max(0.0, timeout))
            if not ready:
                return None
        return self._message()

    def _send(self, obj):
        data = json.dumps(obj).encode()
        n = len(data)
        if n < 126:
            hdr = bytes([0x81, 0x80 | n])
        elif n < 65536:
            hdr = bytes([0x81, 0x80 | 126]) + struct.pack(">H", n)
        else:
            hdr = bytes([0x81, 0x80 | 127]) + struct.pack(">Q", n)
        mask = os.urandom(4)
        self.sock.sendall(hdr + mask + bytes(b ^ mask[i & 3] for i, b in enumerate(data)))

    def _dispatch(self, msg):
        for fn in self.listeners:
            fn(msg["method"], msg.get("params", {}))

    def call(self, method, params=None, timeout=30):
        self.next_id += 1
        mid = self.next_id
        self._send({"id": mid, "method": method, "params": params or {}})
        deadline = time.time() + timeout
        while True:
            msg = self._read(deadline - time.time())
            if msg is None:
                raise TimeoutError(f"{method} timed out")
            if msg.get("id") == mid:
                if "error" in msg:
                    raise RuntimeError(f"{method}: {msg['error'].get('message')}")
                return msg.get("result", {})
            if "method" in msg:
                self._dispatch(msg)

    def pump(self, seconds):
        """Let the page run for `seconds` of real time, handling events."""
        deadline = time.time() + seconds
        while True:
            left = deadline - time.time()
            if left <= 0:
                return
            msg = self._read(left)
            if msg is None:
                return
            if "method" in msg:
                self._dispatch(msg)

    def eval(self, expr):
        r = self.call("Runtime.evaluate",
                      {"expression": expr, "returnByValue": True, "awaitPromise": True})
        if "exceptionDetails" in r:
            d = r["exceptionDetails"]
            raise RuntimeError("page JS failed: " + (d.get("exception", {}).get("description") or d.get("text", "")))
        return r["result"].get("value")

    def screenshot(self, path, clip=None):
        params = {"format": "png", "captureBeyondViewport": True}
        if clip:
            params["clip"] = clip
        data = self.call("Page.captureScreenshot", params, timeout=60)["data"]
        with open(path, "wb") as fh:
            fh.write(base64.b64decode(data))


# ---------------------------------------------------------------- monitors --

class Monitor:
    """Network + console activity, bucketed from a mark so each mode is judged alone."""

    def __init__(self):
        self.reqs = {}
        self.console = []
        self.mark_at = 0.0

    def mark(self):
        self.mark_at = time.time()
        self.console = []

    def on(self, method, p):
        now = time.time()
        if method == "Network.requestWillBeSent":
            self.reqs[p["requestId"]] = {"url": p["request"]["url"], "type": p.get("type"),
                                         "t": now, "done": False, "status": None, "error": None}
        elif method == "Network.responseReceived":
            r = self.reqs.get(p["requestId"])
            if r:
                r["status"] = p["response"]["status"]
                r["responded_at"] = now
        elif method == "Network.loadingFinished":
            r = self.reqs.get(p["requestId"])
            if r:
                r["done"] = True
        elif method == "Network.loadingFailed":
            r = self.reqs.get(p["requestId"])
            if r:
                r["done"] = True
                r["error"] = "canceled" if p.get("canceled") else p.get("errorText")
        elif method == "Runtime.exceptionThrown":
            d = p["exceptionDetails"]
            self.console.append(("exception", (d.get("exception", {}).get("description") or d.get("text", ""))[:300]))
        elif method == "Runtime.consoleAPICalled" and p.get("type") in ("error", "assert"):
            text = " ".join(str(a.get("value", a.get("description", ""))) for a in p.get("args", []))
            self.console.append(("console.error", text[:300]))
        elif method == "Log.entryAdded" and p["entry"].get("level") == "error":
            e = p["entry"]
            self.console.append(("log", (e.get("text", "") + " " + e.get("url", "")).strip()[:300]))

    def since_mark(self):
        return [r for r in self.reqs.values() if r["t"] >= self.mark_at]

    def open_streams(self):
        return [r for r in self.reqs.values()
                if r["type"] == "EventSource" and not r["done"] and r["status"] == 200]


# ------------------------------------------------------------------- probe --

PROBE = r"""
(() => {
  const DASH = /^[–—]/;
  const figs = [...document.querySelectorAll("#grid figure")];
  const tiles = figs.map((f) => {
    const ifr = f.querySelector("iframe"), frame = f.querySelector(".frame");
    const t = { name: (f.querySelector("figcaption b") || {}).textContent || "?",
                src: ifr ? ifr.getAttribute("src") : null };
    if (!ifr) { t.error = "tile has no iframe"; return t; }
    const m = /scale\(([\d.]+)\)/.exec(ifr.style.transform || "");
    t.scale = m ? +m[1] : null;
    t.expectedScale = frame ? frame.clientWidth / 1024 : null;
    let doc = null;
    try { doc = ifr.contentDocument; } catch (e) { t.error = "iframe not readable: " + e.message; return t; }
    if (!doc || !doc.body) { t.error = "iframe has no document"; return t; }
    const win = doc.defaultView;
    t.readyState = doc.readyState;
    t.notFound = /Error response|Error code: 404/.test((doc.body.innerText || "").slice(0, 300));
    t.images = doc.images.length;
    t.brokenImages = [...doc.images].filter((i) => !i.complete || i.naturalWidth === 0)
                                    .map((i) => i.getAttribute("src"));
    t.stale = doc.body.classList.contains("stale");
    const texts = [];
    const w = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = w.nextNode())) {
      const s = n.nodeValue.trim();
      const el = n.parentElement;
      if (!s || !el || el.closest("script,style,[hidden]")) continue;
      const cs = win.getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden") continue;
      texts.push(s);
    }
    const dashed = texts.filter((s) => DASH.test(s));
    t.dashes = dashed.length;
    t.dashSamples = dashed.slice(0, 6);
    t.numbers = texts.filter((s) => /\d/.test(s)).length;
    t.signature = texts.filter((s) => /\d/.test(s)).join("|");
    const de = doc.documentElement;
    t.overflow = de.scrollWidth > de.clientWidth + 1 || de.scrollHeight > de.clientHeight + 1;
    t.clipped = [];
    for (const el of doc.body.querySelectorAll("*")) {
      if (t.clipped.length >= 6) break;
      if (!el.clientWidth || el.scrollWidth <= el.clientWidth + 2) continue;
      if (![...el.childNodes].some((c) => c.nodeType === 3 && c.nodeValue.trim())) continue;
      const cs = win.getComputedStyle(el);
      if (cs.overflowX === "visible" && cs.textOverflow !== "ellipsis") continue;
      t.clipped.push((el.id ? "#" + el.id : el.tagName.toLowerCase() + "." + [...el.classList].join("."))
                     + ' "' + el.textContent.trim().slice(0, 30) + '"');
    }
    return t;
  });
  return {
    tiles,
    pressedMode: [...document.querySelectorAll("#mode button")].filter((b) => b.getAttribute("aria-pressed") === "true").map((b) => b.dataset.mode),
  };
})()
"""


def slug(s):
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-") or "x"


def path_of(url):
    return re.sub(r"^https?://[^/]+", "", url)


# ------------------------------------------------------------------ checks --

def judge(mode, label, first, second, mon):
    """Return [(level, scope, message)] for one mode."""
    out = []
    if first["pressedMode"] != [mode]:
        out.append(("FAIL", "page", f"mode button state is {first['pressedMode']}, expected [{mode!r}]"))

    # network: anything that started in this mode and never came back
    now = time.time()
    stalled, failed = [], []
    for r in mon.since_mark():
        if r["type"] == "EventSource":
            if r["status"] is None and now - r["t"] > STALL_S:
                stalled.append(r)
            continue
        if not r["done"] and now - r["t"] > STALL_S:
            stalled.append(r)
        elif r["error"] and r["error"] != "canceled":
            failed.append(r)
        elif r["status"] and r["status"] >= 400:
            failed.append(r)
    streams = mon.open_streams()
    if stalled:
        urls = sorted({path_of(r["url"]) for r in stalled})
        out.append(("FAIL", "network",
                    f"{len(stalled)} request(s) never completed after {STALL_S:.0f}s "
                    f"({len(streams)} EventSource streams open; Chrome allows {CONN_LIMIT} "
                    f"connections per host): " + ", ".join(urls[:8])))
    if failed:
        out.append(("FAIL", "network", "failed requests: " + ", ".join(
            f"{path_of(r['url'])} ({r['status'] or r['error']})" for r in failed[:8])))
    if len(streams) >= CONN_LIMIT - 1:
        out.append(("WARN", "network", f"{len(streams)} long-lived EventSource streams open "
                                       f"-- at {CONN_LIMIT} every other request blocks"))
    for kind, text in mon.console[:10]:
        out.append(("FAIL", "console", f"{kind}: {text}"))

    before = {t["name"]: t for t in first["tiles"]}
    for t in second["tiles"]:
        scope = t["name"]
        problems = []
        if t.get("error"):
            out.append(("FAIL", scope, t["error"]))
            continue
        original = not (t["src"] or "").startswith("/designs/")
        if t.get("notFound"):
            problems.append(("FAIL", f"page is a 404 ({t['src']})"))
        if t["readyState"] != "complete":
            problems.append(("FAIL", f"document still '{t['readyState']}' -- resources not loading"))
        if not original:
            want = f"demo={mode}" if mode else None
            if want and want not in t["src"]:
                problems.append(("FAIL", f"iframe src {t['src']} does not carry ?{want}"))
            if not want and "demo=" in t["src"]:
                problems.append(("FAIL", f"iframe src {t['src']} still in demo mode"))
        if t["brokenImages"]:
            problems.append(("FAIL", f"{len(t['brokenImages'])}/{t['images']} images not loaded: "
                                     + ", ".join(t["brokenImages"][:6])))
        if t["stale"]:
            problems.append(("FAIL", "body.stale is set -- the data feed stopped"))
        null_mode = mode == "null" and not original
        if null_mode:
            if t["dashes"] < MIN_NULL_DASHES:
                problems.append(("FAIL", f"only {t['dashes']} readouts dashed with every sensor null "
                                         "-- missing values are not rendered as missing"))
        elif t["dashes"] > MAX_LIVE_DASHES:
            problems.append(("FAIL", f"{t['dashes']} readouts show a dash -- data never bound "
                                     f"(e.g. {t['dashSamples'][:4]})"))
        prev = before.get(t["name"])
        if prev and not null_mode and prev["signature"] == t["signature"]:
            level = "FAIL" if (mode in ("load", "peak") and not original) else "WARN"
            problems.append((level, "no readout changed over 3 s -- values are frozen"))
        if t["overflow"]:
            problems.append(("WARN", "document scrolls -- content overflows 1024x600"))
        if t["clipped"]:
            problems.append(("WARN", "clipped text: " + "; ".join(t["clipped"])))
        if t["scale"] is None or t["expectedScale"] is None or abs(t["scale"] - t["expectedScale"]) > 0.01:
            problems.append(("FAIL", f"iframe scale {t['scale']} != frame width/1024 "
                                     f"({t['expectedScale'] and round(t['expectedScale'], 3)})"))
        if not problems:
            out.append(("PASS", scope, f"{t['numbers']} numeric readouts, {t['dashes']} dashed"))
        out.extend((lvl, scope, msg) for lvl, msg in problems)
    return out


# -------------------------------------------------------------------- main --

def launch_chrome(profile, width, height):
    exe = (shutil.which("google-chrome-stable") or shutil.which("google-chrome")
           or shutil.which("chromium") or shutil.which("chromium-browser"))
    if not exe:
        raise RuntimeError("no Chrome/Chromium on PATH")
    proc = subprocess.Popen(
        [exe, "--headless=new", "--hide-scrollbars", "--mute-audio", "--no-first-run",
         "--no-default-browser-check", "--remote-debugging-port=0",
         f"--user-data-dir={profile}", f"--window-size={width},{height}", "about:blank"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    port_file = os.path.join(profile, "DevToolsActivePort")
    for _ in range(150):
        if os.path.exists(port_file):
            lines = open(port_file).read().split()
            if lines:
                port = int(lines[0])
                break
        time.sleep(0.1)
    else:
        proc.kill()
        raise RuntimeError("Chrome did not open a DevTools port")
    for _ in range(50):
        try:
            tabs = json.load(urllib.request.urlopen(f"http://127.0.0.1:{port}/json/list"))
            page = next(t for t in tabs if t["type"] == "page")
            return proc, page["webSocketDebuggerUrl"]
        except Exception:
            time.sleep(0.1)
    proc.kill()
    raise RuntimeError("Chrome exposed no page target")


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--base", default="http://localhost:8777")
    ap.add_argument("--out", default=os.path.join(tempfile.gettempdir(), "designs-validation"))
    ap.add_argument("--wait", type=float, default=6.0, help="seconds to let each mode settle")
    ap.add_argument("--no-tiles", action="store_true", help="skip per-tile screenshots")
    args = ap.parse_args()

    base = args.base.rstrip("/")
    page_url = base + "/designs/index.html"
    for url, what in ((base + "/metrics", "collector /metrics"), (page_url, "designs page")):
        try:
            urllib.request.urlopen(url, timeout=5).read()
        except Exception as e:
            print(f"CANNOT RUN: {what} unreachable at {url} ({e}). Is the collector running?")
            return 2

    os.makedirs(args.out, exist_ok=True)
    profile = tempfile.mkdtemp(prefix="chrome-", dir=args.out)
    proc, ws = launch_chrome(profile, 1600, 1700)
    report = {"page": page_url, "modes": []}
    try:
        cdp = CDP(ws)
        mon = Monitor()
        loaded = {"v": False}

        def on_event(m, p):
            mon.on(m, p)
            if m == "Page.loadEventFired":
                loaded["v"] = True
        cdp.listeners.append(on_event)
        for domain in ("Page", "Network", "Runtime", "Log"):
            cdp.call(domain + ".enable")

        mon.mark()
        cdp.call("Page.navigate", {"url": page_url})
        for _ in range(150):
            if loaded["v"]:
                break
            cdp.pump(0.1)
        if not loaded["v"]:
            print("CANNOT RUN: designs page never fired load")
            return 2

        modes = cdp.eval("[...document.querySelectorAll('#mode button')]"
                         ".map(b => ({mode: b.dataset.mode, label: b.textContent.trim()}))")
        if not modes:
            print("CANNOT RUN: no #mode buttons found on the page")
            return 2

        for m in modes:
            mode, label = m["mode"], m["label"]
            mdir = os.path.join(args.out, slug(label))
            os.makedirs(mdir, exist_ok=True)
            mon.mark()
            cdp.eval("document.querySelector('#cols button[data-cols=\"2\"]').click();"
                     f"[...document.querySelectorAll('#mode button')].find(b => b.dataset.mode === {json.dumps(mode)}).click()")
            cdp.pump(args.wait)
            first = cdp.eval(PROBE)
            cdp.pump(3.0)
            second = cdp.eval(PROBE)
            findings = judge(mode, label, first, second, mon)

            overview = os.path.join(mdir, "overview.png")
            size = cdp.call("Page.getLayoutMetrics")["cssContentSize"]
            cdp.screenshot(overview, {"x": 0, "y": 0, "width": size["width"],
                                      "height": size["height"], "scale": 1})
            shots = []
            if not args.no_tiles:
                cdp.eval("document.querySelector('#cols button[data-cols=\"1\"]').click()")
                cdp.pump(1.5)
                rects = cdp.eval("[...document.querySelectorAll('#grid .frame')].map(f => {"
                                 "const r = f.getBoundingClientRect();"
                                 "return {x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height,"
                                 "name: f.closest('figure').querySelector('figcaption b').textContent}; })")
                for r in rects:
                    shot = os.path.join(mdir, slug(r["name"]) + ".png")
                    cdp.screenshot(shot, {"x": r["x"], "y": r["y"], "width": r["w"],
                                          "height": r["h"], "scale": 1024 / r["w"]})
                    shots.append(shot)
                cdp.eval("document.querySelector('#cols button[data-cols=\"2\"]').click()")
            report["modes"].append({"mode": mode, "label": label, "overview": overview,
                                    "tiles": shots, "findings": findings, "probe": second})
    finally:
        proc.terminate()
        try:
            proc.wait(5)
        except subprocess.TimeoutExpired:
            proc.kill()
        shutil.rmtree(profile, ignore_errors=True)

    with open(os.path.join(args.out, "report.json"), "w") as fh:
        json.dump(report, fh, indent=2, default=str)

    fails = warns = 0
    print(f"Designs page validation -- {page_url}\n")
    for m in report["modes"]:
        print(f"== {m['label']} (demo={m['mode'] or 'off'})   screenshots: {os.path.dirname(m['overview'])}")
        for lvl, scope, msg in m["findings"]:
            fails += lvl == "FAIL"
            warns += lvl == "WARN"
            print(f"  {lvl:<4}  {scope:<14} {msg}")
        print()
    print(f"RESULT: {'FAIL' if fails else 'PASS'} -- {fails} failure(s), {warns} warning(s)"
          f"   report: {os.path.join(args.out, 'report.json')}")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())

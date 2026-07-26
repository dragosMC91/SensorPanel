#!/usr/bin/env python3
"""
Sensor-panel collector.

Reads real hardware sensors once per second and serves them to the frontend:
  GET /metrics  -> JSON snapshot (single reading)
  GET /stream   -> Server-Sent Events, one JSON object pushed per interval
  GET /         -> index.html  (and static assets: *.css *.js *.png *.gif)

Dependency-light on purpose: Python stdlib + psutil only. Config is a TOML file
(read with the stdlib tomllib). Every individual sensor read is wrapped so that a
missing/broken sensor yields null for that field and never crashes the server.

Nothing here is hardcoded to this machine beyond the defaults in config.toml —
all hwmon chips, drives and the network interface are discovered at runtime.
"""

import glob
import json
import mimetypes
import os
import sys
import threading
import time
from collections import defaultdict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

try:
    import tomllib  # Python 3.11+
except ModuleNotFoundError:  # pragma: no cover
    tomllib = None

try:
    import psutil
except ImportError:
    sys.exit("psutil is required:  pip install --user psutil  (or: pacman -S python-psutil)")


BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(BASE_DIR, "config.toml")


# --------------------------------------------------------------------------- #
# Low-level sysfs helpers                                                      #
# --------------------------------------------------------------------------- #

def _read(path):
    """Read a sysfs file, returning its stripped text or None on any error."""
    try:
        with open(path, "r") as fh:
            return fh.read().strip()
    except Exception:
        return None


def _read_float(path, divisor=1.0):
    raw = _read(path)
    if raw is None:
        return None
    try:
        return float(raw) / divisor
    except (ValueError, ZeroDivisionError):
        return None


def _as_list(x):
    """Normalise a config value to a list (str -> [str], None -> [])."""
    if x is None:
        return []
    return list(x) if isinstance(x, (list, tuple)) else [x]


def find_hwmon(name):
    """Return the hwmon directories whose `name` file equals `name`."""
    dirs = []
    for d in glob.glob("/sys/class/hwmon/hwmon*"):
        if _read(os.path.join(d, "name")) == name:
            dirs.append(d)
    return sorted(dirs)


def hwmon_temp(name, label, divisor=1000.0):
    """Temperature (°C) from an hwmon chip by name + sensor label.

    `name` and `label` may each be a string or a list of candidates (tried in
    order) — so e.g. CPU temp can come from either k10temp/Tctl or
    zenpower/Tdie depending on which driver is loaded. If none of the requested
    labels match on a chip that exists, falls back to that chip's temp1_input.
    """
    labels = _as_list(label)
    for nm in _as_list(name):
        for d in find_hwmon(nm):
            for lbl_file in sorted(glob.glob(os.path.join(d, "temp*_label"))):
                if _read(lbl_file) in labels:
                    v = _read_float(lbl_file.replace("_label", "_input"), divisor)
                    if v is not None:
                        return v
            v = _read_float(os.path.join(d, "temp1_input"), divisor)  # fallback
            if v is not None:
                return v
    return None


def hwmon_value(name, attr, divisor=1.0):
    """Raw hwmon attribute from the first matching chip.

    `name` and `attr` may each be a string or list of candidates (tried in
    order), e.g. power from zenpower/power1_input or amdgpu/power1_average.
    """
    for nm in _as_list(name):
        for d in find_hwmon(nm):
            for a in _as_list(attr):
                v = _read_float(os.path.join(d, a), divisor)
                if v is not None:
                    return v
    return None


# --------------------------------------------------------------------------- #
# GPU (amdgpu) discovery                                                       #
# --------------------------------------------------------------------------- #

def discover_gpu_card(preferred=""):
    """Find the DRM card path exposing gpu_busy_percent (AMD).

    Honours a preferred card name from config (e.g. "card1") but verifies it,
    falling back to auto-detection so the mapping stays portable.
    """
    candidates = []
    if preferred:
        candidates.append(f"/sys/class/drm/{preferred}/device")
    candidates += [
        p for p in sorted(glob.glob("/sys/class/drm/card*/device"))
    ]
    for dev in candidates:
        if os.path.exists(os.path.join(dev, "gpu_busy_percent")):
            return dev
    return None


# --------------------------------------------------------------------------- #
# Drive temperatures                                                           #
# --------------------------------------------------------------------------- #

def drive_temps():
    """Map UPPER-CASE drive model -> temperature (°C).

    Covers NVMe (nvme hwmon) and SATA (drivetemp hwmon). SATA temps only appear
    once the `drivetemp` kernel module is loaded; until then that drive is absent
    from the map (and the panel shows a dash for it).
    """
    result = {}

    def model_for(hwmon_dir):
        # The hwmon `device` symlink points at the controller/SCSI device,
        # which exposes a `model` attribute for both nvme and drivetemp.
        for rel in ("device/model", "device/device/model"):
            m = _read(os.path.join(hwmon_dir, rel))
            if m:
                return m.strip().upper()
        return None

    for chip in ("nvme", "drivetemp"):
        for d in find_hwmon(chip):
            model = model_for(d)
            temp = _read_float(os.path.join(d, "temp1_input"), 1000.0)
            if model and temp is not None:
                # keep the lowest sane reading if a model appears twice
                if model not in result or temp < result[model]:
                    result[model] = temp
    return result


# --------------------------------------------------------------------------- #
# Drive space usage                                                            #
# --------------------------------------------------------------------------- #

def drive_usage():
    """Map UPPER-CASE drive model -> (used_bytes, total_bytes).

    Sums every mounted filesystem living on that physical disk. A filesystem
    mounted at several places (btrfs subvolumes) is counted once, keyed by its
    source partition. Drives with nothing mounted are absent from the map.
    """
    # physical disk name (sda, nvme0n1, ...) -> model string
    models = {}
    for dev_dir in glob.glob("/sys/block/*"):
        m = _read(os.path.join(dev_dir, "device", "model"))
        if m:
            models[os.path.basename(dev_dir)] = m.strip().upper()

    per_model = {}
    seen_parts = set()
    try:
        partitions = psutil.disk_partitions(all=False)
    except Exception:
        return per_model
    for p in partitions:
        name = os.path.basename(p.device)
        if not p.device.startswith("/dev/") or name in seen_parts:
            continue
        # resolve the partition to its parent disk via sysfs
        # (/sys/class/block/nvme0n1p2 -> .../nvme0n1/nvme0n1p2)
        real = os.path.realpath(os.path.join("/sys/class/block", name))
        disk = os.path.basename(os.path.dirname(real))
        model = models.get(disk) or models.get(name)
        if not model:
            continue
        try:
            u = psutil.disk_usage(p.mountpoint)
        except Exception:
            continue
        seen_parts.add(name)
        used, total = per_model.get(model, (0, 0))
        per_model[model] = (used + u.used, total + u.total)
    return per_model


# --------------------------------------------------------------------------- #
# CPU active-core count                                                        #
# --------------------------------------------------------------------------- #

_CORE_MAP = None


def _core_map():
    """Cache logical-cpu -> (package, core_id) so we can count physical cores."""
    global _CORE_MAP
    if _CORE_MAP is not None:
        return _CORE_MAP
    mapping = {}
    for cpu_dir in glob.glob("/sys/devices/system/cpu/cpu[0-9]*"):
        try:
            n = int(os.path.basename(cpu_dir)[3:])
        except ValueError:
            continue
        core_id = _read(os.path.join(cpu_dir, "topology", "core_id"))
        pkg = _read(os.path.join(cpu_dir, "topology", "physical_package_id"))
        if core_id is not None:
            mapping[n] = (pkg or "0", core_id)
    _CORE_MAP = mapping
    return mapping


def active_cores(percpu, threshold):
    """(active_physical_cores, total_physical_cores) from per-logical usage."""
    cmap = _core_map()
    core_max = defaultdict(float)
    for i, usage in enumerate(percpu):
        key = cmap.get(i, ("0", str(i)))
        core_max[key] = max(core_max[key], usage)
    total = len(core_max) or len(percpu)
    active = sum(1 for v in core_max.values() if v >= threshold)
    return active, total


# --------------------------------------------------------------------------- #
# Collector                                                                    #
# --------------------------------------------------------------------------- #

class Collector:
    def __init__(self, config):
        self.cfg = config
        self.lock = threading.Lock()
        self.latest = {}
        self._net_prev = None       # (bytes_sent, bytes_recv, monotonic_ts)
        self._disk_prev = None      # (read_bytes, write_bytes, monotonic_ts)
        self.gpu_dev = discover_gpu_card(config.get("gpu", {}).get("card", ""))
        # Prime psutil counters so the first real sample is meaningful.
        psutil.cpu_percent(percpu=True)
        self._sample_net()
        self._sample_disk()

    # -- individual sources -------------------------------------------------- #

    def _sample_net(self):
        iface = self._pick_iface()
        counters = psutil.net_io_counters(pernic=True)
        now = time.monotonic()
        up = down = None
        if iface and iface in counters:
            c = counters[iface]
            if self._net_prev is not None:
                prev_sent, prev_recv, prev_ts = self._net_prev
                dt = now - prev_ts
                if dt > 0:
                    up = max(0.0, (c.bytes_sent - prev_sent) / dt)
                    down = max(0.0, (c.bytes_recv - prev_recv) / dt)
            self._net_prev = (c.bytes_sent, c.bytes_recv, now)
        return iface, up, down

    def _sample_disk(self):
        """Aggregate read/write bytes-per-second across all physical disks."""
        try:
            c = psutil.disk_io_counters()
        except Exception:
            c = None
        if c is None:
            return None, None
        now = time.monotonic()
        read = write = None
        if self._disk_prev is not None:
            prev_read, prev_write, prev_ts = self._disk_prev
            dt = now - prev_ts
            if dt > 0:
                read = max(0.0, (c.read_bytes - prev_read) / dt)
                write = max(0.0, (c.write_bytes - prev_write) / dt)
        self._disk_prev = (c.read_bytes, c.write_bytes, now)
        return read, write

    def _pick_iface(self):
        override = self.cfg.get("network", {}).get("interface", "")
        if override:
            return override
        # default route first
        try:
            with open("/proc/net/route") as fh:
                for line in fh.readlines()[1:]:
                    parts = line.split()
                    if len(parts) > 1 and parts[1] == "00000000":
                        return parts[0]
        except Exception:
            pass
        # else busiest non-loopback interface
        stats = psutil.net_io_counters(pernic=True)
        best, best_bytes = None, -1
        for name, c in stats.items():
            if name == "lo":
                continue
            total = c.bytes_sent + c.bytes_recv
            if total > best_bytes:
                best, best_bytes = name, total
        return best

    def _cpu(self):
        cpu = self.cfg.get("cpu", {})
        percpu = psutil.cpu_percent(percpu=True)
        overall = sum(percpu) / len(percpu) if percpu else None
        active, total = active_cores(percpu, cpu.get("active_threshold", 10.0))
        power = None
        if cpu.get("power_hwmon"):
            power = hwmon_value(cpu["power_hwmon"], cpu.get("power_attr", "power1_input"),
                                cpu.get("power_divisor", 1_000_000.0))
        # Fastest core right now (MHz) — the boost clock, like most panels show.
        clock = None
        try:
            freqs = psutil.cpu_freq(percpu=True)
            if freqs:
                clock = max(f.current for f in freqs)
        except Exception:
            pass
        return {
            "usage": round(overall, 1) if overall is not None else None,
            "temp": hwmon_temp(cpu.get("temp_hwmon", "k10temp"), cpu.get("temp_label", "Tctl")),
            "power": round(power, 1) if power is not None else None,
            "clock": round(clock, 0) if clock is not None else None,
            "active": active,
            "cores": total,
        }

    def _gpu(self):
        gpu = self.cfg.get("gpu", {})
        dev = self.gpu_dev
        usage = clock = vram_used = vram_total = None
        if dev:
            usage = _read_float(os.path.join(dev, "gpu_busy_percent"))
            vram_used = _read_float(os.path.join(dev, "mem_info_vram_used"))
            vram_total = _read_float(os.path.join(dev, "mem_info_vram_total"))
        clock = hwmon_value(gpu.get("hwmon", "amdgpu"), gpu.get("clock_attr", "freq1_input"),
                            1_000_000.0)  # Hz -> MHz
        power = hwmon_value(gpu.get("hwmon", "amdgpu"), gpu.get("power_attr", "power1_average"),
                            1_000_000.0)  # uW -> W
        vram_pct = None
        if vram_used is not None and vram_total:
            vram_pct = vram_used / vram_total * 100.0
        return {
            "usage": round(usage, 0) if usage is not None else None,
            "temp": hwmon_temp(gpu.get("hwmon", "amdgpu"), gpu.get("temp_label", "edge")),
            "power": round(power, 1) if power is not None else None,
            "clock": round(clock, 0) if clock is not None else None,
            "vram_used_gb": round(vram_used / 1024**3, 1) if vram_used is not None else None,
            "vram_total_gb": round(vram_total / 1024**3, 1) if vram_total is not None else None,
            "vram_pct": round(vram_pct, 0) if vram_pct is not None else None,
        }

    def _drives(self):
        temps = drive_temps()
        usage = drive_usage()
        out = []
        for d in self.cfg.get("drives", []):
            match = d.get("match", "").upper()
            temp = used = total = pct = None
            if match:
                for model, t in temps.items():
                    if match in model:
                        temp = t
                        break
                for model, (u, tot) in usage.items():
                    if match in model and tot:
                        used, total, pct = u, tot, u / tot * 100.0
                        break
            out.append({"label": d.get("label", "?"),
                        "temp": round(temp, 0) if temp is not None else None,
                        "used_gb": round(used / 1024**3, 1) if used is not None else None,
                        "total_gb": round(total / 1024**3, 1) if total is not None else None,
                        "used_pct": round(pct, 0) if pct is not None else None})
        return out

    def _mobo(self):
        mb = self.cfg.get("mobo", {})
        if not mb.get("temp_hwmon"):
            return None
        return hwmon_temp(mb["temp_hwmon"], mb.get("temp_label", ""))

    # -- one full reading ---------------------------------------------------- #

    def sample(self):
        try:
            vm = psutil.virtual_memory()
            mem = {"percent": round(vm.percent, 0),
                   "used_gb": round(vm.used / 1024**3, 1),
                   "total_gb": round(vm.total / 1024**3, 1)}
        except Exception:
            mem = {"percent": None, "used_gb": None, "total_gb": None}

        iface, up, down = self._sample_net()
        disk_read, disk_write = self._sample_disk()

        def safe(fn):
            try:
                return fn()
            except Exception as exc:  # never let one sensor kill the sample
                sys.stderr.write(f"[collector] {fn.__name__} failed: {exc}\n")
                return None

        return {
            "ts": time.time(),
            "cpu": safe(self._cpu) or {},
            "gpu": safe(self._gpu) or {},
            "mem": mem,
            "net": {"iface": iface,
                    "up_bps": up, "down_bps": down},
            "disk": {"read_bps": disk_read, "write_bps": disk_write},
            "drives": safe(self._drives) or [],
            "mobo_temp": safe(self._mobo),
        }

    def run(self, interval):
        while True:
            reading = self.sample()
            with self.lock:
                self.latest = reading
            time.sleep(interval)

    def snapshot(self):
        with self.lock:
            return dict(self.latest)


# --------------------------------------------------------------------------- #
# HTTP / SSE server                                                            #
# --------------------------------------------------------------------------- #

ALLOWED_EXT = {".html", ".css", ".js", ".png", ".gif", ".jpg", ".jpeg",
               ".svg", ".woff", ".woff2", ".ttf", ".otf", ".ico"}


def make_handler(collector, interval):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *args):  # keep stdout quiet
            pass

        def _send_json(self, obj, status=200):
            body = json.dumps(obj).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def _serve_static(self, rel):
            rel = rel.lstrip("/") or "index.html"
            path = os.path.normpath(os.path.join(BASE_DIR, rel))
            if not path.startswith(BASE_DIR) or not os.path.isfile(path):
                self.send_error(404)
                return
            if os.path.splitext(path)[1].lower() not in ALLOWED_EXT:
                self.send_error(403)
                return
            ctype = mimetypes.guess_type(path)[0] or "application/octet-stream"
            try:
                with open(path, "rb") as fh:
                    data = fh.read()
            except OSError:
                self.send_error(404)
                return
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)

        def _serve_stream(self):
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "keep-alive")
            self.end_headers()
            try:
                while True:
                    payload = json.dumps(collector.snapshot())
                    self.wfile.write(f"data: {payload}\n\n".encode())
                    self.wfile.flush()
                    time.sleep(interval)
            except (BrokenPipeError, ConnectionResetError):
                return

        def do_GET(self):
            route = self.path.split("?", 1)[0]
            if route == "/metrics":
                self._send_json(collector.snapshot())
            elif route == "/stream":
                self._serve_stream()
            else:
                self._serve_static(route)

    return Handler


def load_config():
    if tomllib is None:
        sys.exit("Python 3.11+ with tomllib is required to read config.toml")
    try:
        with open(CONFIG_PATH, "rb") as fh:
            return tomllib.load(fh)
    except FileNotFoundError:
        sys.stderr.write(f"[collector] {CONFIG_PATH} not found, using defaults\n")
        return {}


def main():
    cfg = load_config()
    server_cfg = cfg.get("server", {})
    host = server_cfg.get("host", "127.0.0.1")
    port = int(server_cfg.get("port", 8777))
    interval = float(server_cfg.get("interval", 1.0))

    collector = Collector(cfg)
    threading.Thread(target=collector.run, args=(interval,), daemon=True).start()
    # Give the poller one cycle so the first HTTP hit has data.
    time.sleep(min(interval, 1.0))

    httpd = ThreadingHTTPServer((host, port), make_handler(collector, interval))
    print(f"[collector] serving on http://{host}:{port}  (interval {interval}s)")
    print(f"[collector] GPU card: {collector.gpu_dev or 'not found'}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()

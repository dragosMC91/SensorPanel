/* Pulse — data binding only.
   Each reading is pushed into a 120-sample rolling buffer; charts turn the
   buffer into clip-path polygons (pixel units) and slide in each new sample
   with a 1 s linear transform. Text readouts ease toward each reading on an
   animation frame (same idea as the production app.js). Heat is pushed as two
   colours (--c accent, --tc text) that CSS transitions. Any null renders a
   dimmed dash, and leaves a gap in its trace. */

(() => {
  "use strict";

  const DASH = "–";
  const N = 120;                      // samples kept: 2 min at 1 Hz
  const $ = (id) => document.getElementById(id);
  const clamp01 = (v) => Math.max(0, Math.min(1, v));
  const isNum = (v) => typeof v === "number" && Number.isFinite(v);

  /* ---- fit the fixed 1024x600 stage into the viewport ---- */
  function fitStage() {
    const s = Math.min(window.innerWidth / 1024, window.innerHeight / 600);
    $("stage").style.transform = `scale(${s})`;
    document.body.style.width = (1024 * s) + "px";
    document.body.style.height = (600 * s) + "px";
  }
  window.addEventListener("resize", fitStage);
  fitStage();

  /* ==================================================================== heat
     Same [cool, warm, hot] ramps as the production panel. */
  const RAMP = {
    cpuTemp:   [58, 78, 92],
    gpuTemp:   [58, 80, 95],
    driveTemp: [42, 58, 70],
    moboTemp:  [36, 48, 60],
    load:      [70, 88, 100],
    space:     [72, 88, 97],
    power:     [0.55, 0.80, 1.0],
  };
  const CPU_POWER_MAX = 142, GPU_POWER_MAX = 230;
  const CPU_CLOCK_MAX = 4650, GPU_CLOCK_MAX = 2600;

  function ramp(v, [cool, warm, hot]) {
    if (!isNum(v) || v <= cool) return 0;
    if (v >= hot) return 1;
    return v < warm ? (v - cool) / (warm - cool) * 0.5
                    : 0.5 + (v - warm) / (hot - warm) * 0.5;
  }

  const TEXT = [234, 240, 248];
  const WARM = [255, 190, 92];
  const HOT  = [255, 84, 92];
  const HUES = { cpu: [70, 228, 214], gpu: [176, 140, 255], mem: [108, 176, 255],
                 ice: [150, 200, 255] };
  const mix = (a, b, t) => a.map((x, i) => Math.round(x + (b[i] - x) * t));
  const warmth = (base, t) => (t <= 0.5 ? mix(base, WARM, t * 2) : mix(WARM, HOT, (t - 0.5) * 2));
  const rgb = (c) => `rgb(${c[0]},${c[1]},${c[2]})`;

  /* Heat moves in 1/16 steps, so a colour changes -- and runs its 1.2 s CSS
     fade -- only when a reading crosses a step, not on every 0.1 degree wobble.
     Each fade repaints its text every frame; under sustained load continuous
     heat kept a dozen of them running all the time. */
  const HEAT_STEPS = 16;
  const qheat = (t) => Math.round(clamp01(t || 0) * HEAT_STEPS) / HEAT_STEPS;

  // Always set (never remove) so a cool child never inherits a hot parent.
  function heat(el, t, base) {
    if (!el) return;
    t = qheat(t);
    el.style.setProperty("--c", rgb(warmth(base || HUES.ice, t)));
    el.style.setProperty("--tc", rgb(warmth(TEXT, t)));
  }

  /* ================================================================= tween
     Each readout eases from what it shows to the new reading over EASE_MS
     (ease-out), then stops. Frames are requested only while something is
     still moving, and a text node is written only when its text changes. The
     panel runs around the clock: an always-on animation loop rewriting every
     readout kept Chrome repainting at 60 fps and cost ~a third of a core. */
  const EASE_MS = 450;
  const bindings = new Map();

  function bind(id, value, fmt) {
    const el = $(id);
    if (!el) return;
    let b = bindings.get(id);
    if (!b) {
      b = { el, v: el.querySelector(".v"), unit: el.querySelector(".u"),
            cur: null, from: null, target: null, t0: 0, text: null };
      bindings.set(id, b);
    }
    b.fmt = fmt;                       // may close over fresh context (e.g. total GB)
    b.target = isNum(value) ? value : null;
    b.from = b.cur;                    // ease from wherever the readout is now
    b.t0 = performance.now();
    // Nothing visible would move (same digits at both ends): snap, no frames.
    if (b.from !== null && b.target !== null && textOf(fmt(b.from)) === textOf(fmt(b.target))) b.from = null;
    kick();
  }

  const textOf = (out) => (typeof out === "object" ? out.text : out);

  function setText(b, s) {
    if (b.text === s) return;
    b.text = s;
    if (b.v) b.v.textContent = s; else b.el.textContent = s;
  }

  const easeOut = (p) => 1 - (1 - p) ** 3;

  // Paint every readout at time `now`; true while any is still easing.
  function paint(now) {
    let moving = false;
    bindings.forEach((b) => {
      const el = b.el;
      if (b.target === null) {
        b.cur = null;
        el.classList.add("na");
        el.classList.remove("idle", "wide");
        setText(b, DASH);
        return;
      }
      el.classList.remove("na");
      const p = Math.min(1, (now - b.t0) / EASE_MS);
      if (b.from === null || p >= 1) b.cur = b.target;
      else { b.cur = b.from + (b.target - b.from) * easeOut(p); moving = true; }
      const out = b.fmt(b.cur);
      const obj = typeof out === "object";
      setText(b, obj ? out.text : out);
      if (b.unit && obj && out.unit && b.unit.textContent !== out.unit) b.unit.textContent = out.unit;
      el.classList.toggle("idle", obj && !!out.idle);
      if (obj && out.wide !== undefined) el.classList.toggle("wide", out.wide);
    });
    return moving;
  }

  let raf = 0;
  function frame(now) {
    raf = 0;
    if (paint(now)) raf = requestAnimationFrame(frame);
  }
  function kick() { if (!raf) raf = requestAnimationFrame(frame); }

  /* ============================================================ formatters */
  const int = (v) => Math.round(v).toString();
  const usageFmt = (v) => { const t = Math.round(v).toString(); return { text: t, wide: t.length >= 3 }; };
  const KB = 1024, MB = 1024 ** 2, GB = 1024 ** 3;

  function rate(v) {
    const a = Math.abs(v);
    if (a >= GB) return { text: (v / GB).toFixed(2), unit: "GB/s" };
    if (a >= MB) { const m = v / MB; return { text: m >= 100 ? m.toFixed(0) : m.toFixed(1), unit: "MB/s" }; }
    if (a >= KB) return { text: (v / KB).toFixed(0), unit: "KB/s" };
    return { text: v.toFixed(0), unit: "B/s", idle: a < 1 };
  }
  // A compact label for a chart's full-scale value, e.g. "50 MB/s".
  function rateLabel(v) {
    const r = rate(v);
    return (+r.text).toString() + " " + r.unit;
  }
  // Round a rolling maximum up to a 1-2-5 step in its unit, so scale labels
  // stay tidy and don't change every second.
  function niceCeil(v) {
    const floor = 16 * KB;
    v = Math.max(floor, v);
    const unit = v >= GB ? GB : v >= MB ? MB : KB;
    const x = v / unit;
    const p = 10 ** Math.floor(Math.log10(x));
    const m = x / p;
    const step = m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10;
    // 1000 KB/s reads worse than 1 MB/s: roll over into the next unit
    return step * p >= 1000 ? unit * 1024 : step * p * unit;
  }

  /* ================================================================ history */
  const hist = {};
  function push(key, v) {
    const a = hist[key] || (hist[key] = []);
    a.push(isNum(v) ? v : null);
    if (a.length > N) a.shift();
    return a;
  }
  function stats(a) {
    let max = -Infinity, at = -1, sum = 0, n = 0;
    a.forEach((v, i) => {
      if (v === null) return;
      if (v >= max) { max = v; at = i; }
      sum += v; n++;
    });
    return n ? { max, at, ago: a.length - 1 - at, avg: sum / n, n } : null;
  }

  /* ================================================================== charts
     A chart owns a .plot (clipped box) with a .layers group that slides; each
     series adds an area and/or a line layer. Geometry is in px of the
     element's layout box (unaffected by the stage's scale transform). */
  function polyArea(pts, base) {
    // pts: [[x, y] | null]; the polygon walks the baseline between segments,
    // so gaps and the closing edge have zero area.
    const out = [];
    let open = false, lastX = 0;
    pts.forEach((p) => {
      if (p) {
        if (!open) { out.push([p[0], base]); open = true; }
        out.push(p);
        lastX = p[0];
      } else if (open) {
        out.push([lastX, base]);
        open = false;
      }
    });
    if (open) out.push([lastX, base]);
    return out;
  }

  function polyBand(pts, half) {
    // Thin band around each segment. Forward along the tops, back along the
    // bottoms; segments are joined through their centre points, so every
    // bridge is walked once each way and encloses nothing.
    const segs = [];
    let cur = null;
    pts.forEach((p) => {
      if (p) { (cur || (cur = [], segs.push(cur), cur)).push(p); }
      else cur = null;
    });
    if (!segs.length) return [];
    const top = [], bot = [];
    segs.forEach((s) => {
      if (s.length === 1) s = [[s[0][0] - 1.5, s[0][1]], [s[0][0] + 1.5, s[0][1]]];
      const T = [], B = [];
      s.forEach((p, i) => {
        // keep perpendicular thickness on steep slopes
        const a = s[Math.max(0, i - 1)], b = s[Math.min(s.length - 1, i + 1)];
        const m = (b[1] - a[1]) / Math.max(0.5, b[0] - a[0]);
        const h = half * Math.min(5, Math.sqrt(1 + m * m));
        T.push([p[0], p[1] - h]);
        B.push([p[0], p[1] + h]);
      });
      const c0 = s[0], c1 = s[s.length - 1];
      top.push(c0, ...T, c1);
      bot.unshift(c1, ...B.reverse(), c0);
    });
    return top.concat(bot);
  }

  const toClip = (pts) => pts.length < 3 ? "polygon(0 0, 0 0, 0 0)"
    : "polygon(" + pts.map((p) => p[0].toFixed(1) + "px " + p[1].toFixed(1) + "px").join(",") + ")";

  function makeChart(el, series, opts = {}) {
    const plot = document.createElement("div");
    plot.className = "plot";
    const layers = document.createElement("div");
    layers.className = "layers";
    plot.appendChild(layers);
    el.insertBefore(plot, el.firstChild);
    el.classList.add("empty");

    const W = el.clientWidth, H = el.clientHeight;
    const step = W / (N - 1);
    const s = series.map((cfg) => {
      const o = Object.assign({ min: 0, max: 100, lw: 1.2, area: true, dir: "up" }, cfg);
      if (o.area) {
        o.areaEl = document.createElement("i");
        o.areaEl.className = "series area " + (o.cls || "");
        layers.appendChild(o.areaEl);
      }
      const wrap = opts.glow ? document.createElement("div") : layers;
      if (opts.glow) { wrap.className = "glow"; layers.appendChild(wrap); }
      o.lineEl = document.createElement("i");
      o.lineEl.className = "series line " + (o.cls || "");
      wrap.appendChild(o.lineEl);
      if (opts.glow) wrap.style.setProperty("--glow", getComputedStyle(o.lineEl).getPropertyValue("--hue"));
      o.dot = document.createElement("b");
      o.dot.className = "now " + (o.dotCls || o.cls || "");
      el.appendChild(o.dot);
      if (o.peak) {
        o.pk = document.createElement("b");
        o.pk.className = "pk";
        layers.appendChild(o.pk);
      }
      // vertical mapping: baseline y0 and signed span
      if (o.dir === "up") { o.y0 = H - 0.5; o.span = H - 4; }
      else if (o.dir === "mid-up") { o.y0 = H / 2; o.span = H / 2 - 3; }
      else { o.y0 = H / 2; o.span = -(H / 2 - 3); }
      return o;
    });

    let lastAt = 0;
    return {
      el,
      update(scaleOverride) {
        let any = false;
        s.forEach((o) => {
          const a = hist[o.key] || [];
          const max = (scaleOverride && scaleOverride[o.key]) || o.max;
          const y = (v) => o.y0 - clamp01((v - o.min) / (max - o.min)) * o.span;
          const L = a.length;
          const pts = a.map((v, i) => (v === null ? null : [W - (L - 1 - i) * step, y(v)]));
          if (pts.some(Boolean)) any = true;
          if (o.areaEl) o.areaEl.style.clipPath = toClip(polyArea(pts, o.y0));
          o.lineEl.style.clipPath = toClip(polyBand(pts, o.lw));
          const last = L ? a[L - 1] : null;
          o.dot.classList.toggle("on", last !== null);
          if (last !== null) {
            o.dot.style.transform = `translateY(${y(last).toFixed(1)}px)`;
            if (o.base) o.dot.style.setProperty("--dot", rgb(warmth(o.base, o.heat ? qheat(o.heat(last)) : 0)));
          }
          if (o.pk) {
            const st = stats(a);
            const show = st && st.n > 3 && st.ago > 1;
            o.pk.classList.toggle("on", !!show);
            if (show) {
              o.pk.style.left = pts[st.at][0].toFixed(1) + "px";
              o.pk.style.top = pts[st.at][1].toFixed(1) + "px";
            }
          }
        });
        // no samples yet: "collecting"; samples but every one null: "no data"
        const seen = s.some((o) => (hist[o.key] || []).length > 0);
        el.classList.toggle("empty", !any && !seen);
        el.classList.toggle("void", !any && seen);
        // slide the new sample in from the right over the sample interval
        const now = performance.now();
        const dur = lastAt ? Math.max(500, Math.min(1500, now - lastAt)) : 1000;
        lastAt = now;
        if (any) {
          layers.getAnimations().forEach((an) => an.cancel());
          layers.animate([{ transform: `translateX(${step.toFixed(2)}px)` }, { transform: "none" }],
                         { duration: dur, easing: "linear" });
        }
      },
    };
  }

  /* ========================================================== static DOM */
  const drivesEl = $("drives");
  for (let i = 0; i < 4; i++) {
    const row = document.createElement("div");
    row.className = "drive";
    row.innerHTML =
      `<span class="dn"><span class="dname" id="drive${i}-name">${DASH}</span>` +
      `<span class="bar" id="drive${i}-bar"><i></i></span></span>` +
      `<span class="dpct" id="drive${i}-pct"><span class="v">${DASH}</span><span class="u">%</span></span>` +
      `<span class="dtemp" id="drive${i}-temp"><span class="v">${DASH}</span><span class="u">°C</span></span>`;
    drivesEl.appendChild(row);
  }

  const charts = [];
  const C = (id, series, opts) => { const c = makeChart($(id), series, opts); charts.push(c); return c; };
  const TEMP_HUE = [236, 240, 250];
  const loadHeat = (v) => ramp(v, RAMP.load);
  ["cpu", "gpu"].forEach((u) => {
    const base = HUES[u];
    const tempHeat = (v) => ramp(v, u === "cpu" ? RAMP.cpuTemp : RAMP.gpuTemp);
    const pMax = u === "cpu" ? CPU_POWER_MAX : GPU_POWER_MAX;
    C(u + "-chart", [
      { key: u + "Load", cls: "s-load", lw: 1.3, peak: true, base, heat: loadHeat },
      { key: u + "Temp", cls: "tline", min: 20, max: 100, area: false, lw: 1.1, dotCls: "t",
        base: TEMP_HUE, heat: tempHeat },
    ], { glow: true });
    C(u + "-temp-spark",  [{ key: u + "Temp", cls: "tline", min: 20, max: 100, area: false, lw: 1,
                             dotCls: "t", base: TEMP_HUE, heat: tempHeat }]);
    C(u + "-power-spark", [{ key: u + "Power", max: pMax, lw: 1, base,
                             heat: (v) => ramp(v / pMax, RAMP.power) }]);
    C(u + "-clock-spark", [{ key: u + "Clock", max: u === "cpu" ? CPU_CLOCK_MAX : GPU_CLOCK_MAX, lw: 1, base }]);
  });
  C("cpu-active-spark", [{ key: "cpuActive", cls: "s-load", max: 12, lw: 1, base: HUES.cpu,
                           heat: (v) => loadHeat(v / 12 * 100) }]);
  C("gpu-vram-spark",   [{ key: "gpuVram",   cls: "s-load", max: 100, lw: 1, base: HUES.gpu, heat: loadHeat }]);
  C("mem-chart", [{ key: "mem", lw: 1.2, base: HUES.mem, heat: loadHeat }]);
  const netChart = C("net-chart", [
    { key: "netDown", cls: "s-in",  dir: "mid-up", lw: 1 },
    { key: "netUp",   cls: "s-out", dir: "mid-down", lw: 1 },
  ]);
  const diskChart = C("disk-chart", [
    { key: "diskR", cls: "s-in",  dir: "mid-up", lw: 1 },
    { key: "diskW", cls: "s-out", dir: "mid-down", lw: 1 },
  ]);
  charts.splice(charts.indexOf(netChart), 1);
  charts.splice(charts.indexOf(diskChart), 1);

  /* ============================================================== render */
  function chipText(usage, h, any) {
    if (!any) return "NO DATA";
    if (h >= 0.75) return "HOT";
    if (h >= 0.4) return "WARM";
    if (isNum(usage) && usage < 8) return "IDLE";
    return "NOMINAL";
  }

  function agoText(s) {
    if (s < 2) return "just now";
    if (s < 60) return `${s} s ago`;
    return `${Math.floor(s / 60)} min ${s % 60} s ago`;
  }

  function trendText(a) {
    // change over the last 30 s (or as much history as there is, from 10 s)
    const L = a.length, cur = a[L - 1];
    if (cur === null || cur === undefined) return "";
    for (let back = Math.min(30, L - 1); back >= 10; back--) {
      const then = a[L - 1 - back];
      if (then === null) continue;
      const d = cur - then;
      if (Math.abs(d) < 1.5) return "steady";
      return (d > 0 ? "▲ " : "▼ ") + Math.abs(d).toFixed(0) + "°";
    }
    return "";
  }

  function unit(u, s, maxPower, tempRamp) {
    const panel = $(u);
    const base = HUES[u];
    const tUse = ramp(s.usage, RAMP.load);
    const tTemp = ramp(s.temp, tempRamp);
    const tPow = isNum(s.power) ? ramp(s.power / maxPower, RAMP.power) : 0;
    const h = Math.max(tUse, tTemp, tPow);

    const load = hist[u + "Load"], temps = hist[u + "Temp"], pow = hist[u + "Power"];

    bind(u + "-usage", s.usage, usageFmt);
    heat($(u + "-usage"), tUse);
    heat(panel, h, base);
    panel.classList.toggle("hot", h >= 0.75);
    const any = [s.usage, s.temp, s.power, s.clock].some(isNum);
    panel.classList.toggle("nodata", !any);
    $(u + "-chip").textContent = chipText(s.usage, h, any);

    // peak / average over the window
    const st = stats(load);
    const pk = $(u + "-peak"), avg = $(u + "-avg");
    pk.textContent = st ? Math.round(st.max) + "%" : DASH;
    avg.textContent = st ? Math.round(st.avg) + "%" : DASH;
    pk.classList.toggle("na", !st);
    avg.classList.toggle("na", !st);
    $(u + "-peak-ago").textContent = st ? agoText(st.ago) : "";
    heat(pk.parentElement, st ? ramp(st.max, RAMP.load) : 0);
    pk.style.color = "var(--tc)";

    bind(u + "-temp", s.temp, int);
    heat($(u + "-temp-s"), tTemp);
    $(u + "-temp-trend").textContent = trendText(temps);

    bind(u + "-power", s.power, int);
    heat($(u + "-power-s"), tPow);
    const ps = stats(pow);
    $(u + "-power-peak").textContent = ps && ps.n > 3 ? "max " + Math.round(ps.max) : "";

    bind(u + "-clock", s.clock, int);
    heat($(u + "-clock-s"), 0);
  }

  /* Every series a reading feeds, in one place, so the collector's /history
     can be replayed into the buffers without painting anything. A reading
     already in the window (same ts) is not pushed twice: the live feed's first
     delivery usually repeats the last /history entry. */
  const coresOf = (cpu) => (isNum(cpu.cores) ? cpu.cores : 12);
  function vramPctOf(gpu) {
    const ok = isNum(gpu.vram_used_gb) && isNum(gpu.vram_total_gb) && gpu.vram_total_gb > 0;
    if (!ok) return null;
    return isNum(gpu.vram_pct) ? gpu.vram_pct : gpu.vram_used_gb / gpu.vram_total_gb * 100;
  }
  const seenTs = [], seen = new Set();
  function record(d) {
    if (!d || !d.cpu) return false;
    if (isNum(d.ts)) {
      if (seen.has(d.ts)) return false;
      seen.add(d.ts);
      seenTs.push(d.ts);
      if (seenTs.length > N) seen.delete(seenTs.shift());
    }
    const cpu = d.cpu || {}, gpu = d.gpu || {}, mem = d.mem || {},
          net = d.net || {}, disk = d.disk || {};
    [["cpu", cpu], ["gpu", gpu]].forEach(([u, x]) => {
      push(u + "Load", x.usage);
      push(u + "Temp", x.temp);
      push(u + "Power", x.power);
      push(u + "Clock", x.clock);
    });
    push("cpuActive", isNum(cpu.active) ? cpu.active / coresOf(cpu) * 12 : null);
    push("gpuVram", vramPctOf(gpu));
    push("mem", mem.percent);
    push("netDown", net.down_bps);
    push("netUp", net.up_bps);
    push("diskR", disk.read_bps);
    push("diskW", disk.write_bps);
    return true;
  }

  let painted = false;
  function render(d) {
    if (!d || !d.cpu) return;
    if (!record(d) && painted) return;   // a repeat: nothing new to draw
    painted = true;
    const cpu = d.cpu || {}, gpu = d.gpu || {}, mem = d.mem || {},
          net = d.net || {}, disk = d.disk || {};

    unit("cpu", cpu, CPU_POWER_MAX, RAMP.cpuTemp);
    unit("gpu", gpu, GPU_POWER_MAX, RAMP.gpuTemp);

    // active cores
    const cores = coresOf(cpu);
    bind("cpu-active", cpu.active, int);
    $("cpu-active").querySelector(".u").textContent = "/" + cores;
    heat($("cpu-active-s"), isNum(cpu.active) ? ramp(cpu.active / cores * 100, RAMP.load) : 0);

    // VRAM
    const vramPct = vramPctOf(gpu), vramOk = vramPct !== null;
    bind("gpu-vram", vramOk ? gpu.vram_used_gb : null, (v) => v.toFixed(1));
    $("gpu-vram-total").textContent = vramOk ? "of " + gpu.vram_total_gb.toFixed(0) : "";
    heat($("gpu-vram-s"), ramp(vramPct, RAMP.load));

    // memory
    bind("mem-pct", mem.percent, int);
    heat($("mem"), ramp(mem.percent, RAMP.load), HUES.mem);
    $("mem-pct").style.color = "var(--tc)";
    bind("mem-gb", mem.used_gb, (v) => ({
      text: v.toFixed(1),
      unit: "/ " + (isNum(mem.total_gb) ? mem.total_gb.toFixed(1) : DASH) + " GB",
    }));

    // network + disk, each auto-scaled to its own rolling maximum
    $("net-iface").textContent = net.iface || "";
    const io = (keyIn, vIn, keyOut, vOut, idIn, idOut, chart, pre) => {
      const aIn = hist[keyIn], aOut = hist[keyOut];
      bind(idIn, vIn, rate);
      bind(idOut, vOut, rate);
      const mIn = niceCeil(Math.max(0, ...aIn.filter(isNum)));
      const mOut = niceCeil(Math.max(0, ...aOut.filter(isNum)));
      const anyIn = aIn.some(isNum), anyOut = aOut.some(isNum);
      $(pre + "-scale-in").textContent = anyIn ? rateLabel(mIn) : "";
      $(pre + "-scale-out").textContent = anyOut ? rateLabel(mOut) : "";
      chart.update({ [keyIn]: mIn, [keyOut]: mOut });
    };
    io("netDown", net.down_bps, "netUp", net.up_bps, "net-down", "net-up", netChart, "net");
    io("diskR", disk.read_bps, "diskW", disk.write_bps, "disk-read", "disk-write", diskChart, "disk");

    // drives
    const drives = d.drives || [];
    for (let i = 0; i < 4; i++) {
      const drv = drives[i] || {};
      $(`drive${i}-name`).textContent = drv.label || DASH;
      bind(`drive${i}-pct`, drv.used_pct, int);
      const bar = $(`drive${i}-bar`);
      bar.classList.toggle("na", !isNum(drv.used_pct));
      bar.style.setProperty("--p", isNum(drv.used_pct) ? Math.max(0, Math.min(100, drv.used_pct)).toFixed(1) : "0");
      const ts = ramp(drv.used_pct, RAMP.space);
      heat(bar, ts, HUES.ice);
      heat($(`drive${i}-pct`), ts);
      bind(`drive${i}-temp`, drv.temp, int);
      heat($(`drive${i}-temp`), ramp(drv.temp, RAMP.driveTemp));
    }

    // motherboard
    bind("mobo", d.mobo_temp, int);
    heat($("mobo-s"), ramp(d.mobo_temp, RAMP.moboTemp));

    charts.forEach((c) => c.update());

    // heartbeat + clock
    const beat = $("beat");
    beat.classList.remove("on");
    void beat.offsetWidth;
    beat.classList.add("on");
    const t = new Date(isNum(d.ts) ? d.ts * 1000 : Date.now());
    $("clock").textContent = t.toTimeString().slice(0, 8);
  }

  // Backfill the charts from the collector's recent readings, then go live.
  PanelFeed.history()
    .then((past) => past.forEach(record))
    .finally(() => PanelFeed.subscribe(render));
})();

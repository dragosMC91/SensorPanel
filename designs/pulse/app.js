/* Pulse — data binding only.
   Each reading is pushed into a 120-sample rolling buffer; charts turn the
   buffer into clip-path polygons (pixel units) once per reading. Readouts,
   heat colours (--c accent, --tc text) and chart positions all snap to each
   reading: the page asks Chrome for one frame per second and nothing in
   between (see style.css). Any null renders a dimmed dash, and leaves a gap in
   its trace. */

(() => {
  "use strict";

  const DASH = "–";
  const N = 120;                      // samples kept: 2 min at 1 Hz
  const els = new Map();
  const $ = (id) => {
    let el = els.get(id);
    if (el === undefined) { el = document.getElementById(id); els.set(id, el); }
    return el;
  };
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
     Same [cool, warm, hot] ramps as the production panel, plus the GPU's
     extra sensors. */
  const RAMP = {
    cpuTemp:   [58, 78, 92],
    gpuTemp:   [58, 80, 95],
    hotspot:   [70, 92, 105],     // RX 6800 junction; throttles at 110 °C
    vramTemp:  [76, 90, 100],     // GDDR6
    driveTemp: [42, 58, 70],
    moboTemp:  [36, 48, 60],
    load:      [70, 88, 100],
    space:     [72, 88, 97],
    power:     [0.55, 0.80, 1.0],
  };
  const CPU_POWER_MAX = 142, GPU_POWER_MAX = 230;   // package PPT / board power
  const GPU_CLOCK_MAX = 2600;
  const FAN_MAX_RPM = 3300;                         // fallback when the GPU doesn't say

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
                 ice: [150, 200, 255], temp: [236, 240, 250] };
  const mix = (a, b, t) => a.map((x, i) => Math.round(x + (b[i] - x) * t));
  const warmth = (base, t) => (t <= 0.5 ? mix(base, WARM, t * 2) : mix(WARM, HOT, (t - 0.5) * 2));
  const rgb = (c) => `rgb(${c[0]},${c[1]},${c[2]})`;

  /* Heat moves in 1/16 steps, so a colour changes only when a reading crosses
     a step, not on every 0.1 degree wobble: fewer style recalcs and repaints. */
  const HEAT_STEPS = 16;
  const qheat = (t) => Math.round(clamp01(t || 0) * HEAT_STEPS) / HEAT_STEPS;

  /* ============================================================ DOM writes
     Every write goes through a cache and is skipped when nothing changed, so
     a steady reading costs no style invalidation at all. */
  const props = new WeakMap();
  function setProp(el, name, val) {
    let m = props.get(el);
    if (!m) { m = Object.create(null); props.set(el, m); }
    if (m[name] === val) return;
    m[name] = val;
    el.style.setProperty(name, val);
  }
  function setText(el, s) { if (el.textContent !== s) el.textContent = s; }

  // Always set (never remove) so a cool child never inherits a hot parent.
  function heat(el, t, base) {
    if (!el) return;
    t = qheat(t);
    setProp(el, "--c", rgb(warmth(base || HUES.ice, t)));
    setProp(el, "--tc", rgb(warmth(TEXT, t)));
  }

  /* A readout: an element holding .v (digits) and optionally .u (unit). The
     value snaps to each reading; easing between 1 Hz readings showed numbers
     the sensor never reported and cost ~30 frames a second per readout. */
  function show(id, value, fmt) {
    const el = $(id);
    if (!el) return;
    const v = el.querySelector(".v") || el, u = el.querySelector(".u");
    if (!isNum(value)) {
      el.classList.add("na");
      el.classList.remove("idle", "wide");
      setText(v, DASH);
      return;
    }
    el.classList.remove("na");
    const out = fmt(value);
    const obj = typeof out === "object";
    setText(v, obj ? out.text : out);
    if (u && obj && out.unit) setText(u, out.unit);
    el.classList.toggle("idle", obj && !!out.idle);
    if (obj && out.wide !== undefined) el.classList.toggle("wide", out.wide);
  }

  /* ============================================================ formatters */
  const int = (v) => Math.round(v).toString();
  // hero numbers: three digits ("100", "105") switch to the smaller .wide size
  const heroFmt = (v) => { const t = Math.round(v).toString(); return { text: t, wide: t.length >= 3 }; };
  const ghz = (mhz) => (mhz / 1000).toFixed(2);
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
    (a || []).forEach((v, i) => {
      if (v === null) return;
      if (v >= max) { max = v; at = i; }
      sum += v; n++;
    });
    return n ? { max, at, ago: a.length - 1 - at, avg: sum / n, n } : null;
  }

  /* Zoomed scales. A fixed 20-100 °C axis flattens a 40 °C idle into a line
     with no detail, so temperature (and the CPU clock) instead get a scale
     fitted to the window: four gridline steps of `step` units, the smallest
     step from `steps` that holds the data, centred on it. The scale is kept
     while the data still fits it at that zoom, and a tighter zoom must fit
     comfortably before it's taken, so the axis doesn't flip every second. */
  function fitRange(lo, hi, steps, cur) {
    for (const st of steps) {
      const span = 4 * st, m = st * 0.1;
      if (hi - lo + 2 * m > span) continue;
      if (cur && lo - m >= cur.lo && hi + m <= cur.hi) {
        if (cur.step === st) return cur;
        if (cur.step > st && hi - lo + 2 * m > 0.85 * span) return cur;
      }
      const cands = [Math.round(((lo + hi) / 2 - span / 2) / st) * st,
                     Math.floor((lo - m) / st) * st,
                     Math.ceil((hi + m) / st) * st - span];
      const base = cands.find((b) => b <= lo - m && b + span >= hi + m);
      if (base !== undefined) return { lo: base, hi: base + span, step: st };
    }
    const st = steps[steps.length - 1], base = Math.floor(lo / st) * st;
    return { lo: base, hi: Math.max(base + 4 * st, Math.ceil(hi / st) * st), step: st };
  }

  /* ================================================================== charts
     A chart owns a .plot (clipped box) with a .layers group; each series adds
     an area and/or a line layer. Geometry is in px of the element's layout
     box (unaffected by the stage's scale transform). The charts step once per
     reading: the old 1 s slide moved them ~0.04 px a frame, invisible, and kept
     Chrome compositing at 60 fps around the clock. */
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
      o.els = [];
      if (o.area) {
        o.areaEl = document.createElement("i");
        o.areaEl.className = "series area " + (o.cls || "");
        layers.appendChild(o.areaEl);
        o.els.push(o.areaEl);
      }
      const wrap = opts.glow ? document.createElement("div") : layers;
      if (opts.glow) { wrap.className = "glow"; layers.appendChild(wrap); }
      o.lineEl = document.createElement("i");
      o.lineEl.className = "series line " + (o.cls || "");
      wrap.appendChild(o.lineEl);
      o.els.push(o.lineEl);
      if (opts.glow) wrap.style.setProperty("--glow", getComputedStyle(o.lineEl).getPropertyValue("--hue"));
      o.dot = document.createElement("b");
      o.dot.className = "now " + (o.dotCls || o.cls || "");
      el.appendChild(o.dot);
      if (o.peak) {
        o.pk = document.createElement("b");
        o.pk.className = "pk";
        o.pkv = document.createElement("span");
        o.pkv.className = "pkv";
        o.pk.appendChild(o.pkv);
        layers.appendChild(o.pk);
      }
      // vertical mapping: baseline y0 and signed span
      if (o.dir === "up") { o.y0 = H - 0.5; o.span = H - 4; }
      else if (o.dir === "mid-up") { o.y0 = H / 2; o.span = H / 2 - 3; }
      else { o.y0 = H / 2; o.span = -(H / 2 - 3); }
      return o;
    });

    return {
      el,
      update(scaleOverride) {
        let any = false;
        s.forEach((o) => {
          const a = hist[o.key] || [];
          let min = o.min, max = (scaleOverride && scaleOverride[o.key]) || o.max;
          if (o.auto) {
            let lo = Infinity, hi = -Infinity;
            a.forEach((v) => { if (v !== null) { if (v < lo) lo = v; if (v > hi) hi = v; } });
            if (lo !== Infinity) o.range = fitRange(lo, hi, o.auto, o.range);
            if (o.range) { min = o.range.lo; max = o.range.hi; }
            if (o.onRange) o.onRange(lo !== Infinity ? o.range : null);
          }
          const f = (v) => (v - min) / (max - min);
          const y = (v) => o.y0 - clamp01(f(v)) * o.span;
          // heat bands at the heights where the ramp's values fall on this scale
          if (o.bands) {
            const pct = (v) => ((H - (o.y0 - f(v) * o.span)) / H * 100).toFixed(1) + "%";
            const [s1, s2, s3] = o.bands.map(pct);
            o.els.forEach((e) => { setProp(e, "--s1", s1); setProp(e, "--s2", s2); setProp(e, "--s3", s3); });
          }
          const L = a.length;
          const pts = a.map((v, i) => (v === null ? null : [W - (L - 1 - i) * step, y(v)]));
          if (pts.some(Boolean)) any = true;
          if (o.areaEl) o.areaEl.style.clipPath = toClip(polyArea(pts, o.y0));
          o.lineEl.style.clipPath = toClip(polyBand(pts, o.lw));
          const last = L ? a[L - 1] : null;
          o.dot.classList.toggle("on", last !== null);
          if (last !== null) {
            setProp(o.dot, "transform", `translateY(${y(last).toFixed(1)}px)`);
            if (o.base) setProp(o.dot, "--dot", rgb(warmth(o.base, o.heat ? qheat(o.heat(last)) : 0)));
          }
          if (o.pk) {
            const st = stats(a);
            const on = !!(st && st.n > 3 && st.ago > 1);
            o.pk.classList.toggle("on", on);
            if (on) {
              const [px, py] = pts[st.at];
              setProp(o.pk, "left", px.toFixed(1) + "px");
              setProp(o.pk, "top", py.toFixed(1) + "px");
              o.pk.classList.toggle("left", px > W - 52);
              // keep the label inside the plot when the peak sits at the very top
              setProp(o.pkv, "margin-top", Math.max(0, 10 - py).toFixed(0) + "px");
              setText(o.pkv, o.peakFmt ? o.peakFmt(st.max) : int(st.max));
            }
          }
        });
        // no samples yet: "collecting"; samples but every one null: "no data"
        const seen = s.some((o) => (hist[o.key] || []).length > 0);
        el.classList.toggle("empty", !any && !seen);
        el.classList.toggle("void", !any && seen);
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

  // the alert chips: a state word and, for a heat alert, what's hot
  ["cpu", "gpu"].forEach((u) => {
    const chip = $(u + "-chip");
    chip.innerHTML = '<span class="st">NO DATA</span><span class="why"></span>';
  });

  /* Per-core bars, one per physical core, grouped by the L3 cache (CCX) the
     collector reports. Rebuilt only if the grouping changes. */
  const coresEl = $("cpu-cores");
  let coreBars = [], coreSig = "";
  function buildCores(groups) {
    const sig = groups.join(",");
    if (sig === coreSig) return;
    coreSig = sig;
    coresEl.textContent = "";
    coreBars = [];
    groups.forEach((n) => {
      const g = document.createElement("span");
      g.className = "grp";
      for (let i = 0; i < n; i++) {
        const c = document.createElement("span");
        c.className = "core";
        const b = document.createElement("b");
        c.appendChild(b);
        g.appendChild(c);
        coreBars.push(b);
      }
      coresEl.appendChild(g);
    });
  }
  buildCores([3, 3, 3, 3]);

  const charts = [];
  const C = (id, series, opts) => { const c = makeChart($(id), series, opts); charts.push(c); return c; };
  const loadHeat = (v) => ramp(v, RAMP.load);
  const TEMP_STEPS = [5, 10, 20, 25];

  ["cpu", "gpu"].forEach((u) => {
    const base = HUES[u];
    const tRamp = u === "cpu" ? RAMP.cpuTemp : RAMP.gpuTemp;
    const pMax = u === "cpu" ? CPU_POWER_MAX : GPU_POWER_MAX;
    const axR = [...$(u + "-chart").querySelectorAll(".ax.r")];   // 75 / 50 / 25 % heights
    C(u + "-chart", [
      { key: u + "Load", cls: "s-load", lw: 1.3, peak: true, peakFmt: (v) => Math.round(v) + "%",
        base, heat: loadHeat, bands: RAMP.load },
      { key: u + "Temp", cls: "tline", area: false, lw: 1.2, dotCls: "t", auto: TEMP_STEPS,
        bands: tRamp, base: HUES.temp, heat: (v) => ramp(v, tRamp),
        onRange: (r) => axR.forEach((el, i) => setText(el, r ? (r.lo + (3 - i) * r.step) + "°" : "")) },
    ], { glow: true });
    C(u + "-power-spark", [{ key: u + "Power", max: pMax, lw: 1, base,
                             bands: RAMP.power.map((x) => x * pMax),
                             heat: (v) => ramp(v / pMax, RAMP.power) }]);
  });
  C("cpu-clock-spark", [{ key: "cpuClock", lw: 1, base: HUES.cpu, auto: [100, 250, 500, 1000, 1250] }]);
  C("gpu-clock-spark", [{ key: "gpuClock", max: GPU_CLOCK_MAX, lw: 1, base: HUES.gpu }]);
  C("gpu-hotspot-spark", [{ key: "gpuHot", cls: "tline", area: false, lw: 1, dotCls: "t", auto: TEMP_STEPS,
                            bands: RAMP.hotspot, base: HUES.temp, heat: (v) => ramp(v, RAMP.hotspot) }]);
  C("gpu-vram-spark", [{ key: "gpuVram", cls: "s-load", max: 100, lw: 1, base: HUES.gpu,
                         bands: RAMP.load, heat: loadHeat }]);
  C("mem-chart", [{ key: "mem", lw: 1.2, base: HUES.mem, bands: RAMP.load, heat: loadHeat }]);
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

  /* ================================================================ GPU fan
     The one thing that moves between readings, and only while the real fan
     spins. It is a compositor-only rotation with a stepped easing: Chrome
     draws a frame only when the rotor steps (~15 a second), not 60. One
     iteration turns the rotor by one blade pitch, which looks continuous;
     playbackRate follows the fan speed. In zero-RPM fan stop it stands still. */
  const fanEl = $("gpu-fan");
  const PITCH = 360 / 7;
  const fanAnim = fanEl.querySelector(".rotor").animate(
    [{ transform: "rotate(0deg)" }, { transform: `rotate(${PITCH}deg)` }],
    { duration: 1000, iterations: Infinity, easing: "steps(4, end)" });
  fanAnim.pause();
  let fanRate = 0, fanRpm = null, fanMax = null;
  function fan() {
    const ok = isNum(fanRpm);
    fanEl.classList.toggle("na", !ok);
    const spin = ok && fanRpm > 0 && !document.body.classList.contains("stale");
    fanEl.classList.toggle("spin", spin);
    if (!spin) { if (fanAnim.playState === "running") fanAnim.pause(); return; }
    const f = clamp01(fanRpm / (isNum(fanMax) && fanMax > 0 ? fanMax : FAN_MAX_RPM));
    const r = Math.round((1.2 + 4.8 * f) * 4) / 4;           // blade pitches per second
    if (r !== fanRate) {
      fanRate = r;
      // ~15 steps a second whatever the speed: smooth enough, a quarter the frames
      fanAnim.effect.updateTiming({ easing: `steps(${Math.max(3, Math.min(12, Math.round(15 / r)))}, end)` });
      fanAnim.updatePlaybackRate(r);
    }
    if (fanAnim.playState !== "running") fanAnim.play();
  }
  // stop the fan while the feed is stale (feed.js toggles body.stale)
  new MutationObserver(fan).observe(document.body, { attributes: true, attributeFilter: ["class"] });

  /* ================================================================= alerts
     Levels: 0 idle, 1 nominal, 2 busy, 3 warm, 4 hot. A level counts once it
     has held for two readings in a row, and is shown until five readings pass
     without it, so neither a one-second spike nor a brief dip flips the chip.
     Warm/hot come from temperatures only; full load or power reads as BUSY,
     which is the machine working, not something to worry about. */
  function holder() {
    const lv = [];
    return (raw) => {
      lv.push(raw);
      if (lv.length > 6) lv.shift();
      if (lv.length === 1) return raw;
      let shown = 0;
      for (let i = 1; i < lv.length; i++) shown = Math.max(shown, Math.min(lv[i], lv[i - 1]));
      return shown;
    };
  }
  const hold = { cpu: holder(), gpu: holder(), mem: holder(), store: holder() };
  const heldWhy = { cpu: "", gpu: "" };   // what tripped the alert being held
  const WORD = ["IDLE", "NOMINAL", "BUSY", "WARM", "HOT"];

  function panelAlert(el, level) {
    el.classList.toggle("warn", level === 3);
    el.classList.toggle("alert", level === 4);
  }

  /* ============================================================== render */
  function unit(u, s, maxPower, temps) {
    const panel = $(u);
    const tUse = ramp(s.usage, RAMP.load);
    const tPow = isNum(s.power) ? ramp(s.power / maxPower, RAMP.power) : 0;
    // the hottest temperature sensor, relative to its own ramp
    let tHeat = 0, why = null;
    temps.forEach(([name, v, r]) => {
      const t = ramp(v, r);
      if (isNum(v) && (why === null || t > tHeat)) { tHeat = t; why = name ? `${name} ${Math.round(v)}°` : `${Math.round(v)}°`; }
    });

    show(u + "-usage", s.usage, heroFmt);
    heat($(u + "-usage"), tUse);
    show(u + "-temp", s.temp, heroFmt);
    heat($(u + "-temp"), ramp(s.temp, temps[0][2]));
    heat(panel, Math.max(tUse, tHeat, tPow), HUES[u]);

    const any = [s.usage, s.temp, s.power, s.clock].some(isNum);
    panel.classList.toggle("nodata", !any);
    const raw = tHeat >= 0.75 ? 4 : tHeat >= 0.4 ? 3
              : Math.max(tUse, tPow) >= 0.5 ? 2
              : isNum(s.usage) && s.usage < 8 ? 0 : 1;
    const level = hold[u](any ? raw : 0);
    // While an alert is held after the reading eased off, keep naming the
    // reading that tripped it, not today's cooler value.
    if (raw >= level) heldWhy[u] = why || "";
    const chip = $(u + "-chip");
    setText(chip.firstChild, any ? WORD[level] : "NO DATA");
    setText(chip.lastChild, any && level >= 3 && heldWhy[u] ? " · " + heldWhy[u] : "");
    panelAlert(panel, any ? level : 0);

    show(u + "-power", s.power, int);
    heat($(u + "-power-s"), tPow);
    const ps = stats(hist[u + "Power"]);
    setText($(u + "-power-peak"), ps && ps.n > 3 ? "max " + Math.round(ps.max) : "");
  }

  /* Every series a reading feeds, in one place, so the collector's /history
     can be replayed into the buffers without painting anything. A reading
     already in the window (same ts) is not pushed twice: the live feed's first
     delivery usually repeats the last /history entry. */
  const cpuClockOf = (cpu) => (isNum(cpu.clock_avg) ? cpu.clock_avg : cpu.clock);
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
    });
    push("cpuClock", cpuClockOf(cpu));
    push("gpuClock", gpu.clock);
    push("gpuHot", gpu.hotspot);
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

    unit("cpu", cpu, CPU_POWER_MAX, [[null, cpu.temp, RAMP.cpuTemp]]);
    unit("gpu", gpu, GPU_POWER_MAX, [[null, gpu.temp, RAMP.gpuTemp],
                                     ["HOTSPOT", gpu.hotspot, RAMP.hotspot],
                                     ["VRAM", gpu.mem_temp, RAMP.vramTemp]]);

    // CPU clock: the average over every core, with the fastest one beside it
    const clk = cpuClockOf(cpu);
    show("cpu-clock", clk, ghz);
    setText($("cpu-clock-max"), isNum(cpu.clock_avg) && isNum(cpu.clock) ? "max " + ghz(cpu.clock) : "");
    heat($("cpu-clock-s"), 0);

    // per-core load
    const loads = Array.isArray(cpu.core_loads) ? cpu.core_loads : null;
    if (loads && Array.isArray(cpu.core_groups) && cpu.core_groups.reduce((a, b) => a + b, 0) === loads.length) {
      buildCores(cpu.core_groups);
    }
    coresEl.classList.toggle("na", !loads);
    coreBars.forEach((b, i) => {
      const v = loads ? loads[i] : null;
      setProp(b, "transform", `scaleY(${isNum(v) ? Math.max(0.04, clamp01(v / 100)).toFixed(3) : 0})`);
      setProp(b, "--bc", rgb(warmth(HUES.cpu, qheat(ramp(v, RAMP.load)))));
    });
    setText($("cpu-active"), isNum(cpu.active) ? `${cpu.active}/${isNum(cpu.cores) ? cpu.cores : 12} active` : "");

    // GPU hotspot, clock, VRAM, fan
    show("gpu-hotspot", gpu.hotspot, int);
    heat($("gpu-hotspot-s"), ramp(gpu.hotspot, RAMP.hotspot));
    show("gpu-clock", gpu.clock, int);
    heat($("gpu-clock-s"), 0);
    const vramPct = vramPctOf(gpu), vramOk = vramPct !== null;
    show("gpu-vram", vramOk ? gpu.vram_used_gb : null, (v) => v.toFixed(1));
    setText($("gpu-vram-total"), vramOk ? "of " + gpu.vram_total_gb.toFixed(0) : "");
    heat($("gpu-vram-s"), ramp(vramPct, RAMP.load));
    fanRpm = gpu.fan_rpm; fanMax = gpu.fan_max_rpm;
    fan();

    // memory
    show("mem-pct", mem.percent, int);
    heat($("mem"), ramp(mem.percent, RAMP.load), HUES.mem);
    show("mem-gb", mem.used_gb, (v) => ({
      text: v.toFixed(1),
      unit: "/ " + (isNum(mem.total_gb) ? mem.total_gb.toFixed(1) : DASH) + " GB",
    }));
    const mp = mem.percent;
    panelAlert($("mem"), hold.mem(isNum(mp) ? (mp >= 95 ? 4 : mp >= 88 ? 3 : 0) : 0));

    // network + disk, each auto-scaled to its own rolling maximum
    setText($("net-iface"), net.iface || "");
    const io = (keyIn, vIn, keyOut, vOut, idIn, idOut, chart, pre) => {
      const aIn = hist[keyIn], aOut = hist[keyOut];
      show(idIn, vIn, rate);
      show(idOut, vOut, rate);
      const mIn = niceCeil(Math.max(0, ...aIn.filter(isNum)));
      const mOut = niceCeil(Math.max(0, ...aOut.filter(isNum)));
      setText($(pre + "-scale-in"), aIn.some(isNum) ? rateLabel(mIn) : "");
      setText($(pre + "-scale-out"), aOut.some(isNum) ? rateLabel(mOut) : "");
      chart.update({ [keyIn]: mIn, [keyOut]: mOut });
    };
    io("netDown", net.down_bps, "netUp", net.up_bps, "net-down", "net-up", netChart, "net");
    io("diskR", disk.read_bps, "diskW", disk.write_bps, "disk-read", "disk-write", diskChart, "disk");

    // drives + board; the storage panel alerts on a hot drive/board or a full drive
    const drives = d.drives || [];
    let storeLevel = 0;
    const lvl = (t) => (t >= 1 ? 4 : t >= 0.5 ? 3 : 0);
    for (let i = 0; i < 4; i++) {
      const drv = drives[i] || {};
      setText($(`drive${i}-name`), drv.label || DASH);
      show(`drive${i}-pct`, drv.used_pct, int);
      const bar = $(`drive${i}-bar`);
      bar.classList.toggle("na", !isNum(drv.used_pct));
      setProp(bar, "--p", isNum(drv.used_pct) ? Math.max(0, Math.min(100, drv.used_pct)).toFixed(1) : "0");
      const ts = ramp(drv.used_pct, RAMP.space), tt = ramp(drv.temp, RAMP.driveTemp);
      heat(bar, ts, HUES.ice);
      heat($(`drive${i}-pct`), ts);
      show(`drive${i}-temp`, drv.temp, int);
      heat($(`drive${i}-temp`), tt);
      storeLevel = Math.max(storeLevel, lvl(ts), lvl(tt));
    }
    show("mobo", d.mobo_temp, int);
    const tb = ramp(d.mobo_temp, RAMP.moboTemp);
    heat($("mobo-s"), tb);
    panelAlert($("store"), hold.store(Math.max(storeLevel, lvl(tb))));

    charts.forEach((c) => c.update());
  }

  // Backfill the charts from the collector's recent readings, then go live.
  PanelFeed.history()
    .then((past) => past.forEach(record))
    .finally(() => PanelFeed.subscribe(render));
})();

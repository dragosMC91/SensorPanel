/* Sensor panel frontend.
   Connects to the collector's SSE /stream and binds each value to a DOM node.
   Falls back to polling /metrics if the stream drops. Any null value renders
   as an em-dash and the node is dimmed — the panel never blanks out.

   Two things happen between a reading and the glass:
     * every numeric readout eases toward the new value on an animation frame
       instead of snapping once a second (see "tween");
     * hot/loaded values drift from the panel's cyan through amber to red, and
       the GIF orbs brighten and warm with them (see "heat"). */

(() => {
  "use strict";

  const DASH = "–";
  const $ = (id) => document.getElementById(id);
  const clamp01 = (v) => Math.max(0, Math.min(1, v));
  const norm = (v, lo, hi) => clamp01((v - lo) / (hi - lo));

  /* ---- scale the fixed 1024x600 stage into whatever viewport we're in ----
     On the real Waveshare (1024x600) scale = 1. In a desktop preview window it
     shrinks to fit without scrollbars. */
  function fitStage() {
    const stage = $("stage");
    const s = Math.min(window.innerWidth / 1024, window.innerHeight / 600);
    stage.style.transform = `scale(${s})`;
    document.body.style.width = (1024 * s) + "px";
    document.body.style.height = (600 * s) + "px";
  }
  window.addEventListener("resize", fitStage);
  fitStage();

  /* ==================================================================== heat ==
     A number's colour carries its own warning: cyan while everything is calm,
     amber as a sensor approaches its comfortable ceiling, red past it. Each
     metric declares a [cool, warm, hot] ramp in its own units. Tune these — the
     defaults suit a Ryzen 3900X / RX 6800 with a 62 GB pool. */
  const COOL = [169, 244, 255];   // --cyan, the resting colour of the panel
  const WARM = [255, 203, 108];
  const HOT  = [255,  86, 108];

  const RAMP = {
    cpuTemp:   [58, 78, 92],
    gpuTemp:   [58, 80, 95],
    driveTemp: [42, 58, 70],
    moboTemp:  [36, 48, 60],
    load:      [70, 88, 100],   // usage %, memory %, active-core ratio
    space:     [72, 88, 97],    // drive fullness %
    power:     [0.55, 0.80, 1.0], // fraction of the part's power ceiling
  };
  // Rough package / board power ceilings; only used to scale the power orbs.
  const CPU_POWER_MAX = 142, GPU_POWER_MAX = 230;

  /* 0 at "cool", .5 at "warm", 1 at "hot" — a two-segment linear ramp so the
     amber knee lands exactly where the middle stop says it should. */
  function ramp(v, stops) {
    if (v === null || v === undefined || Number.isNaN(v)) return 0;
    const [cool, warm, hot] = stops;
    if (v <= cool) return 0;
    if (v >= hot) return 1;
    return v < warm ? (v - cool) / (warm - cool) * 0.5
                    : 0.5 + (v - warm) / (hot - warm) * 0.5;
  }

  const mix = (a, b, t) => a.map((x, i) => Math.round(x + (b[i] - x) * t));
  const heatRGB = (t) => (t <= 0.5 ? mix(COOL, WARM, t * 2) : mix(WARM, HOT, (t - 0.5) * 2));
  const rgb = (c, a) => (a === undefined ? `rgb(${c[0]},${c[1]},${c[2]})`
                                         : `rgba(${c[0]},${c[1]},${c[2]},${a})`);

  // Colour + glow for heat t (0..1). t ~ 0 hands the element back to the
  // stylesheet so a calm panel looks exactly as designed.
  function paintHeat(el, t) {
    if (!el) return;
    if (!(t > 0.01)) {
      el.style.removeProperty("color");
      el.style.removeProperty("text-shadow");
      return;
    }
    const c = heatRGB(t);
    el.style.color = rgb(c);
    el.style.textShadow = `0 0 6px ${rgb(c, .9)}, 0 0 ${(14 + 12 * t).toFixed(0)}px ${rgb(c, .55)}`;
  }

  // Bar fills warm at their right edge as they fill up; "" restores the CSS gradient.
  function paintBar(fill, pct, t) {
    if (!fill) return;
    fill.style.width = Math.max(0, Math.min(100, pct)) + "%";
    fill.style.background = t > 0.01 ? `linear-gradient(90deg, #52d0ff, ${rgb(heatRGB(t))})` : "";
  }

  /* =================================================================== tween ==
     The collector samples once a second. Painting those steps raw makes every
     number pop; easing toward them on an animation frame makes the panel read
     as continuously alive without inventing data — the target is always the
     last real reading. */
  const TAU = 170;                 // ms to cover ~63% of the remaining distance
  const bindings = new Map();
  let dirty = true;                // something still needs painting this frame

  /* id      element to drive (its first child must be the text node)
     value   latest reading, or null for "sensor not available"
     fmt     (v) -> string | {text, unit, idle}
     heatOf  (v) -> 0..1, optional */
  function bind(id, value, fmt, heatOf) {
    const el = $(id);
    if (!el) return;
    let b = bindings.get(id);
    if (!b) { b = { el, unit: el.querySelector(".u"), cur: null, target: null }; bindings.set(id, b); }
    b.fmt = fmt;
    b.heatOf = heatOf;
    b.target = (value === null || value === undefined || Number.isNaN(value)) ? null : value;
    dirty = true;
  }

  function paintBindings(dt) {
    // Once every tween has settled there is nothing to redraw until the next
    // reading — the panel runs for weeks at a time, so don't touch the DOM
    // sixty times a second for no reason.
    if (!dirty) return;
    let moving = false;
    const k = 1 - Math.exp(-dt / TAU);
    bindings.forEach((b) => {
      const el = b.el;
      if (b.target === null) {
        b.cur = null;
        el.classList.add("na");
        el.classList.remove("idle");
        paintHeat(el, 0);
        el.childNodes[0].nodeValue = DASH;
        return;
      }
      el.classList.remove("na");
      if (b.cur === null || Math.abs(b.target - b.cur) < 1e-3) b.cur = b.target;
      else { b.cur += (b.target - b.cur) * k; moving = true; }

      const out = b.fmt(b.cur);
      const obj = typeof out === "object";
      const text = obj ? out.text : out;
      el.childNodes[0].nodeValue = text;
      if (b.unit && obj && out.unit) b.unit.textContent = out.unit;
      el.classList.toggle("idle", obj && !!out.idle);
      // "100%" is wider than the orb it sits in — shrink the big readouts a
      // notch rather than let the unit slide off the edge of the panel
      if (el.classList.contains("r-big")) el.classList.toggle("wide", text.length >= 3);
      // Heat follows the reading, not the tween, so colour never lags behind.
      if (b.heatOf) paintHeat(el, b.heatOf(b.target));
    });
    dirty = moving;
  }

  let lastFrame = performance.now();
  requestAnimationFrame(function frame(now) {
    const dt = Math.min(120, now - lastFrame);
    lastFrame = now;
    paintBindings(dt);
    requestAnimationFrame(frame);
  });

  /* ---- formatters ---- */
  const fixed = (digits) => (v) => v.toFixed(digits);

  /* Bytes/s with a unit that follows the magnitude. The old fixed "MB/s" meant
     everyday traffic — a few hundred KB/s — always read as a dead 0.0. */
  function rate(v) {
    const abs = Math.abs(v);
    // three significant figures at most: "700 MB/s" fits the row, "700.0" doesn't
    if (abs >= 1024 ** 3) return { text: (v / 1024 ** 3).toFixed(2), unit: "GB/s" };
    if (abs >= 1024 ** 2) {
      const mb = v / 1024 ** 2;
      return { text: mb >= 100 ? mb.toFixed(0) : mb.toFixed(1), unit: "MB/s" };
    }
    if (abs >= 1024)      return { text: (v / 1024).toFixed(0),      unit: "KB/s" };
    return { text: v.toFixed(0), unit: "B/s", idle: abs < 1 };
  }

  /* ---- reactive orbs -------------------------------------------------------
     The GIF spheres carry the reading too: brighter with load, warmer (hue
     pushed from magenta toward red) with heat. CSS does the mapping from these
     two custom properties, so the feel is tunable in the stylesheet. */
  function orb(cls, level, heat) {
    const el = document.querySelector(".sphere." + cls);
    if (!el) return;
    el.style.setProperty("--lvl", clamp01(level).toFixed(3));
    el.style.setProperty("--heat", clamp01(heat).toFixed(3));
  }

  /* ---- render one snapshot ---- */
  let lastData = 0;

  function render(d) {
    if (!d || !d.cpu) return;
    lastData = performance.now();
    document.body.classList.remove("stale");

    const cpu = d.cpu || {}, gpu = d.gpu || {}, mem = d.mem || {}, net = d.net || {},
          disk = d.disk || {};

    // CPU
    bind("cpu-usage", cpu.usage, fixed(0), (v) => ramp(v, RAMP.load));
    bind("cpu-temp",  cpu.temp,  fixed(0), (v) => ramp(v, RAMP.cpuTemp));
    bind("cpu-power", cpu.power, fixed(0), (v) => ramp(v / CPU_POWER_MAX, RAMP.power));
    bind("cpu-clock", cpu.clock, fixed(0));
    const act = $("cpu-active");
    if (cpu.active !== undefined && cpu.cores) {
      act.classList.remove("na");
      act.textContent = `${cpu.active}/${cpu.cores}`;
      paintHeat(act, ramp(cpu.active / cpu.cores * 100, RAMP.load));
    } else { act.classList.add("na"); act.textContent = DASH; paintHeat(act, 0); }

    // GPU
    bind("gpu-usage", gpu.usage, fixed(0), (v) => ramp(v, RAMP.load));
    bind("gpu-temp",  gpu.temp,  fixed(0), (v) => ramp(v, RAMP.gpuTemp));
    bind("gpu-power", gpu.power, fixed(0), (v) => ramp(v / GPU_POWER_MAX, RAMP.power));
    bind("gpu-clock", gpu.clock, fixed(0));
    const vram = $("gpu-vram");
    if (gpu.vram_used_gb !== null && gpu.vram_used_gb !== undefined && gpu.vram_total_gb) {
      vram.classList.remove("na");
      // drop the decimal past 10 GB so the value never grows into the baked
      // "VRAM" label to its left
      const used = gpu.vram_used_gb;
      vram.textContent = `${used >= 10 ? used.toFixed(0) : used.toFixed(1)}/${gpu.vram_total_gb.toFixed(0)} GB`;
      paintHeat(vram, ramp(gpu.vram_pct, RAMP.load));
    } else { vram.classList.add("na"); vram.textContent = DASH; paintHeat(vram, 0); }

    // orbs follow their cluster
    orb("cpu-usage-orb", (cpu.usage ?? 0) / 100,        ramp(cpu.usage, RAMP.load));
    orb("gpu-usage-orb", (gpu.usage ?? 0) / 100,        ramp(gpu.usage, RAMP.load));
    orb("cpu-power-orb", (cpu.power ?? 0) / CPU_POWER_MAX, ramp((cpu.power ?? 0) / CPU_POWER_MAX, RAMP.power));
    orb("gpu-power-orb", (gpu.power ?? 0) / GPU_POWER_MAX, ramp((gpu.power ?? 0) / GPU_POWER_MAX, RAMP.power));
    orb("cpu-temp-orb",  norm(cpu.temp ?? 30, 30, 85),  ramp(cpu.temp, RAMP.cpuTemp));
    orb("gpu-temp-orb",  norm(gpu.temp ?? 30, 30, 90),  ramp(gpu.temp, RAMP.gpuTemp));

    // memory
    if (mem.percent !== null && mem.percent !== undefined) {
      const t = ramp(mem.percent, RAMP.load);
      bind("mem-pct", mem.percent, (v) => Math.round(v) + "%", () => t);
      paintBar($("mem-bar"), mem.percent, t);
      const memEl = $("mem");
      if (mem.used_gb != null) memEl.title = `${mem.used_gb} / ${mem.total_gb} GB`;
    } else {
      bind("mem-pct", null, (v) => v + "%");
    }

    // network + disk I/O — unit scales with the traffic
    bind("net-down",   net.down_bps,   rate);
    bind("net-up",     net.up_bps,     rate);
    bind("disk-read",  disk.read_bps,  rate);
    bind("disk-write", disk.write_bps, rate);

    // drives: temp and space-used bar are separate, independently-placed
    // elements (#drive{i}-temp / #drive{i}-space). Either may be absent — the
    // SATA drives show space only, so #drive{i}-temp doesn't exist for them.
    (d.drives || []).forEach((drv, i) => {
      const tempEl = document.querySelector("#drive" + i + "-temp .dtemp");
      if (tempEl) {
        if (drv.temp === null || drv.temp === undefined) {
          tempEl.classList.add("na"); tempEl.textContent = DASH; paintHeat(tempEl, 0);
        } else {
          tempEl.classList.remove("na");
          tempEl.textContent = Math.round(drv.temp) + "°C";
          paintHeat(tempEl, ramp(drv.temp, RAMP.driveTemp));
        }
      }
      const spaceEl = $("drive" + i + "-space");
      if (!spaceEl) return;
      const pct = spaceEl.querySelector(".dpct");
      const fill = spaceEl.querySelector(".bar-fill");
      if (drv.used_pct === null || drv.used_pct === undefined) {
        pct.classList.add("na"); pct.textContent = DASH; paintHeat(pct, 0);
        fill.style.width = "0%";
        spaceEl.classList.remove("has-bar");
      } else {
        const t = ramp(drv.used_pct, RAMP.space);
        pct.classList.remove("na");
        pct.textContent = Math.round(drv.used_pct) + "%";
        pct.title = `${drv.used_gb} / ${drv.total_gb} GB`;
        paintHeat(pct, t);
        paintBar(fill, drv.used_pct, t);
        spaceEl.classList.add("has-bar");
      }
    });

    // mobo
    bind("mobo", d.mobo_temp, fixed(0), (v) => ramp(v, RAMP.moboTemp));
  }

  /* ---- connection: SSE with polling fallback ---- */
  const status = $("status");
  let sse = null, pollTimer = null;

  function showStatus(msg, isErr) {
    status.textContent = msg;
    status.classList.toggle("err", !!isErr);
    status.classList.add("show");
    if (!isErr) setTimeout(() => status.classList.remove("show"), 1500);
  }

  /* Stale guard: without this the panel happily displays a frozen snapshot
     forever if the collector dies. After 5 s with no reading the whole stage
     dims so nobody trusts numbers that stopped moving. */
  setInterval(() => {
    if (!lastData) return;
    const stale = performance.now() - lastData > 5000;
    document.body.classList.toggle("stale", stale);
    if (stale) showStatus("no data — collector stalled", true);
  }, 1000);

  function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(async () => {
      try {
        const r = await fetch("/metrics", { cache: "no-store" });
        render(await r.json());
      } catch (e) { showStatus("collector offline", true); }
    }, 1000);
  }
  function stopPolling() { clearInterval(pollTimer); pollTimer = null; }

  // paint once immediately so the panel is never blank while SSE connects
  async function primePaint() {
    try {
      const r = await fetch("/metrics", { cache: "no-store" });
      render(await r.json());
    } catch (e) { /* SSE / polling will cover it */ }
  }
  primePaint();

  function connect() {
    try {
      sse = new EventSource("/stream");
      sse.onopen = () => { stopPolling(); showStatus("live", false); };
      sse.onmessage = (ev) => {
        try { render(JSON.parse(ev.data)); } catch (e) {}
      };
      sse.onerror = () => {
        showStatus("stream lost — polling", true);
        sse.close();
        startPolling();
        setTimeout(connect, 5000); // try to restore the stream
      };
    } catch (e) {
      startPolling();
    }
  }
  connect();

  /* ---- calibration / live tuner ----
     c    : toggle calibrate mode (shows a HUD)
     g    : toggle a 5% grid + centre line
     Tab  : select the next tunable element (spheres, numbers, icons, chip)
     arrows : move selected element (Shift = bigger step)
     + / - : resize selected element
     The HUD shows the exact `left/top/width` to paste into style.css, so you
     can dial each sphere in against the real display and hand me the numbers
     (or just keep them). */
  const hud = document.createElement("div");
  hud.id = "tuner";
  hud.style.cssText = "position:fixed;left:6px;top:6px;z-index:100;background:" +
    "rgba(0,0,0,.85);color:#4dff9e;font:12px/1.5 monospace;padding:6px 9px;" +
    "white-space:pre;display:none;pointer-events:none;border:1px solid #4dff9e;";
  document.body.appendChild(hud);

  const tunables = () =>
    [...document.querySelectorAll(".sphere, .icon, #center, .r")];
  let sel = null, idx = -1;

  const pctLeft = (el) => parseFloat(getComputedStyle(el).left) / 1024 * 100;
  const pctTop  = (el) => parseFloat(getComputedStyle(el).top) / 600 * 100;
  const widthPx  = (el) => parseFloat(getComputedStyle(el).width);
  const heightPx = (el) => parseFloat(getComputedStyle(el).height);

  function updateHud() {
    if (!document.body.classList.contains("calibrate")) { hud.style.display = "none"; return; }
    hud.style.display = "block";
    if (!sel) { hud.textContent = "Tab / Shift+Tab = select an element"; return; }
    const name = sel.id ? "#" + sel.id : "." + [...sel.classList].join(".");
    const resizable = sel.matches(".sphere, .icon, #center");
    hud.textContent =
      name + "\n" +
      `left: ${pctLeft(sel).toFixed(1)}%; top: ${pctTop(sel).toFixed(1)}%;` +
      (resizable ? `\nwidth: ${widthPx(sel).toFixed(0)}px; height: ${heightPx(sel).toFixed(0)}px;` : "") +
      "\nTab=next  Shift+Tab=prev  arrows=move  +/-=size";
  }
  function select(el) {
    if (sel) sel.style.outline = "";
    sel = el;
    if (sel) sel.style.outline = "2px solid #ff3df0";
    updateHud();
  }

  // press "p" to dump every element's current position/size as pasteable CSS
  function dumpAll() {
    const lines = tunables().map((el) => {
      const name = el.id ? "#" + el.id : "." + [...el.classList].join(".");
      const resizable = el.matches(".sphere, .icon, #center");
      return name + " { left: " + pctLeft(el).toFixed(1) + "%; top: " + pctTop(el).toFixed(1) + "%;" +
        (resizable ? " width: " + widthPx(el).toFixed(0) + "px; height: " + heightPx(el).toFixed(0) + "px;" : "") + " }";
    });
    console.log("\n/* --- sensor-panel tuned values (paste to Claude or into style.css) --- */\n" +
      lines.join("\n") + "\n");
  }

  document.addEventListener("keydown", (e) => {
    if (e.key === "g") { $("grid").hidden = !$("grid").hidden; return; }
    if (e.key === "c") {
      const on = document.body.classList.toggle("calibrate");
      if (!on && sel) { sel.style.outline = ""; sel = null; idx = -1; }
      updateHud();
      return;
    }
    if (!document.body.classList.contains("calibrate")) return;

    if (e.key === "p") { dumpAll(); return; }
    if (e.key === "Tab") {
      const list = tunables();
      idx = (idx + (e.shiftKey ? -1 : 1) + list.length) % list.length;
      select(list[idx]);
      e.preventDefault();
      return;
    }
    if (!sel) return;

    const step = e.shiftKey ? 2 : 0.3;
    if (e.key === "ArrowLeft")  sel.style.left = (pctLeft(sel) - step).toFixed(1) + "%";
    else if (e.key === "ArrowRight") sel.style.left = (pctLeft(sel) + step).toFixed(1) + "%";
    else if (e.key === "ArrowUp")    sel.style.top  = (pctTop(sel)  - step).toFixed(1) + "%";
    else if (e.key === "ArrowDown")  sel.style.top  = (pctTop(sel)  + step).toFixed(1) + "%";
    else if ((e.key === "+" || e.key === "=" || e.key === "-") &&
             sel.matches(".sphere, .icon, #center")) {
      const w0 = widthPx(sel), h0 = heightPx(sel);
      const w = Math.max(8, w0 + (e.key === "-" ? -6 : 6));
      sel.style.width = w + "px";
      sel.style.height = (w * h0 / w0) + "px";   // keep the element's aspect ratio
    } else return;
    e.preventDefault();
    updateHud();
  });

  // clicking still logs plain % coords for anything not in the tunable list
  document.addEventListener("click", (e) => {
    if (!document.body.classList.contains("calibrate")) return;
    const x = (e.clientX / window.innerWidth) * 100;
    const y = (e.clientY / window.innerHeight) * 100;
    console.log(`left: ${x.toFixed(1)}%; top: ${y.toFixed(1)}%;`);
  });
})();

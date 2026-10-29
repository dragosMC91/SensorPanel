/* Neon Grid — data binding only. Sets text, classes and custom properties;
   CSS does every pixel of drawing.

   Kept from the production app.js:
     * heat ramps (RAMP) — two-segment cool -> warm -> hot per metric
     * tweening — numbers ease toward each 1 Hz reading on rAF, then stop
       touching the DOM once settled
     * adaptive B/s -> KB/s -> MB/s -> GB/s units
     * null -> dimmed dash, never blank, never crash
     * fixed-width digit boxes (.v, min-width in ch) so units don't jitter */

(() => {
  "use strict";

  const DASH = "–";
  const $ = (id) => document.getElementById(id);
  const clamp01 = (v) => Math.max(0, Math.min(1, v));
  const ok = (v) => v !== null && v !== undefined && !Number.isNaN(v);

  /* ---- scale the fixed 1024x600 stage into the viewport ---- */
  function fitStage() {
    const stage = $("stage");
    const s = Math.min(window.innerWidth / 1024, window.innerHeight / 600);
    stage.style.transform = `scale(${s})`;
    document.body.style.width = (1024 * s) + "px";
    document.body.style.height = (600 * s) + "px";
  }
  window.addEventListener("resize", fitStage);
  fitStage();

  /* ==================================================================== heat */
  const COOL = [246, 241, 255];   // resting near-white of the numbers
  const WARM = [255, 196,  84];
  const HOT  = [255,  64,  40];

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
  const CPU_CLOCK_MAX = 4650, GPU_CLOCK_MAX = 2550;

  function ramp(v, stops) {
    if (!ok(v)) return 0;
    const [cool, warm, hot] = stops;
    if (v <= cool) return 0;
    if (v >= hot) return 1;
    return v < warm ? (v - cool) / (warm - cool) * 0.5
                    : 0.5 + (v - warm) / (hot - warm) * 0.5;
  }
  const mix = (a, b, t) => a.map((x, i) => Math.round(x + (b[i] - x) * t));
  const heatRGB = (t) => (t <= 0.5 ? mix(COOL, WARM, t * 2) : mix(WARM, HOT, (t - 0.5) * 2));

  function paintHeat(el, t) {
    if (!el) return;
    if (!(t > 0.01)) { el.classList.remove("heated"); el.style.removeProperty("--hc"); return; }
    const c = heatRGB(t);
    el.classList.add("heated");
    el.style.setProperty("--hc", `rgb(${c[0]},${c[1]},${c[2]})`);
  }

  /* ================================================================ meters */
  // n = segment count: the fill snaps to whole segments like a real VU.
  function meter(id, frac, n, heat) {
    const el = $(id);
    if (!el) return;
    if (!ok(frac)) {
      el.classList.add("na");
      el.style.setProperty("--lit", "0");
      paintHeat(el, 0);
      return;
    }
    el.classList.remove("na");
    let f = clamp01(frac);
    if (n) f = f > 0 ? Math.max(1, Math.round(f * n)) / n : 0;
    el.style.setProperty("--lit", f.toFixed(4));
    if (heat !== undefined) paintHeat(el, heat);
  }

  /* ================================================================= tween */
  const TAU = 170;
  const bindings = new Map();
  let dirty = true;

  function bind(id, value, fmt, heatOf) {
    const el = $(id);
    if (!el) return;
    let b = bindings.get(id);
    if (!b) {
      b = { el, v: el.querySelector(".v"), unit: el.querySelector(".u"), cur: null, target: null };
      bindings.set(id, b);
    }
    b.fmt = fmt;
    b.heatOf = heatOf;
    b.target = ok(value) ? value : null;
    dirty = true;
  }

  function paintBindings(dt) {
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
        if (b.v.textContent !== DASH) b.v.textContent = DASH;
        return;
      }
      el.classList.remove("na");
      if (b.cur === null || Math.abs(b.target - b.cur) < 1e-3) b.cur = b.target;
      else { b.cur += (b.target - b.cur) * k; moving = true; }

      const out = b.fmt(b.cur);
      const obj = typeof out === "object";
      const text = obj ? out.text : out;
      if (b.v.textContent !== text) b.v.textContent = text;
      if (b.unit && obj && out.unit && b.unit.textContent !== out.unit) b.unit.textContent = out.unit;
      el.classList.toggle("idle", obj && !!out.idle);
      // heat follows the reading, not the tween
      paintHeat(el, b.heatOf ? b.heatOf(b.target) : 0);
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

  /* ============================================================ formatters */
  const fixed = (d) => (v) => v.toFixed(d);

  function rate(v) {
    const abs = Math.abs(v);
    if (abs >= 1024 ** 3) return { text: (v / 1024 ** 3).toFixed(2), unit: "GB/s" };
    if (abs >= 1024 ** 2) {
      const mb = v / 1024 ** 2;
      return { text: mb >= 100 ? mb.toFixed(0) : mb.toFixed(1), unit: "MB/s" };
    }
    if (abs >= 1024) return { text: (v / 1024).toFixed(0), unit: "KB/s" };
    return { text: v.toFixed(0), unit: "B/s", idle: abs < 1 };
  }
  // log-scaled activity bar: 1 KB/s -> 0, `max` -> 1
  const logLevel = (bps, max) => (ok(bps) ? clamp01((Math.log10(Math.max(bps, 1)) - 3) / (Math.log10(max) - 3)) : null);

  // scene/outline heat is quantised so it only touches style when it really moves
  function setProp(el, prop, val) {
    if (!el) return;
    const s = clamp01(val).toFixed(2);
    if (el.style.getPropertyValue(prop) !== s) el.style.setProperty(prop, s);
  }
  const setPanelHeat = (id, t) => setProp($(id), "--ph", t);
  function setText(el, s) { if (el && el.textContent !== s) el.textContent = s; }

  /* ================================================================ render */
  function render(d) {
    const cpu = d.cpu || {}, gpu = d.gpu || {}, mem = d.mem || {}, net = d.net || {},
          disk = d.disk || {};

    // ---------------------------------------------------------------- CPU
    const cTempT = ramp(cpu.temp, RAMP.cpuTemp);
    bind("cpu-usage", cpu.usage, fixed(0), (v) => ramp(v, RAMP.load));
    bind("cpu-temp",  cpu.temp,  fixed(0), () => cTempT);
    bind("cpu-power", cpu.power, fixed(0), (v) => ramp(v / CPU_POWER_MAX, RAMP.power));
    bind("cpu-clock", cpu.clock, fixed(0));
    const cores = cpu.cores || 12;
    bind("cpu-active", ok(cpu.active) ? cpu.active : null, fixed(0),
         (v) => ramp(v / cores * 100, RAMP.load));
    setText($("cpu-active").querySelector(".u"), "/" + cores);

    meter("cpu-vu", ok(cpu.usage) ? cpu.usage / 100 : null, 30);
    meter("cpu-temp-m", ok(cpu.temp) ? (cpu.temp - 25) / 75 : null, 0, cTempT);
    meter("cpu-power-m", ok(cpu.power) ? cpu.power / CPU_POWER_MAX : null, 0,
          ramp(cpu.power / CPU_POWER_MAX, RAMP.power));
    meter("cpu-clock-m", ok(cpu.clock) ? cpu.clock / CPU_CLOCK_MAX : null, 0);
    meter("cpu-active-m", ok(cpu.active) ? cpu.active / cores : null, cores);
    setPanelHeat("p-cpu", Math.max(0, cTempT * 1.6 - 0.6));   // outline only past ~"warm"

    // ---------------------------------------------------------------- GPU
    const gTempT = ramp(gpu.temp, RAMP.gpuTemp);
    bind("gpu-usage", gpu.usage, fixed(0), (v) => ramp(v, RAMP.load));
    bind("gpu-temp",  gpu.temp,  fixed(0), () => gTempT);
    bind("gpu-power", gpu.power, fixed(0), (v) => ramp(v / GPU_POWER_MAX, RAMP.power));
    bind("gpu-clock", gpu.clock, fixed(0));
    const vramT = ramp(gpu.vram_pct, RAMP.load);
    bind("gpu-vram", gpu.vram_used_gb, fixed(1), () => vramT);
    setText($("gpu-vram").querySelector(".u"),
      ok(gpu.vram_total_gb) ? `/${gpu.vram_total_gb.toFixed(0)} GB` : " GB");

    meter("gpu-vu", ok(gpu.usage) ? gpu.usage / 100 : null, 30);
    meter("gpu-temp-m", ok(gpu.temp) ? (gpu.temp - 25) / 75 : null, 0, gTempT);
    meter("gpu-power-m", ok(gpu.power) ? gpu.power / GPU_POWER_MAX : null, 0,
          ramp(gpu.power / GPU_POWER_MAX, RAMP.power));
    meter("gpu-clock-m", ok(gpu.clock) ? gpu.clock / GPU_CLOCK_MAX : null, 0);
    const vpct = ok(gpu.vram_pct) ? gpu.vram_pct
               : (ok(gpu.vram_used_gb) && gpu.vram_total_gb ? gpu.vram_used_gb / gpu.vram_total_gb * 100 : null);
    meter("gpu-vram-m", ok(vpct) ? vpct / 100 : null, 0, vramT);
    setPanelHeat("p-gpu", Math.max(0, gTempT * 1.6 - 0.6));

    // the whole sky warms with the hotter of the two chips
    setProp($("stage"), "--heat", Math.max(cTempT, gTempT));

    // ------------------------------------------------------------- memory
    const memT = ramp(mem.percent, RAMP.load);
    bind("mem-pct", mem.percent, fixed(0), () => memT);
    bind("mem-gb", mem.used_gb, fixed(1), () => memT);
    setText($("mem-gb").querySelector(".u"), ok(mem.total_gb) ? ` / ${mem.total_gb.toFixed(1)} GB` : " GB");
    meter("mem-vu", ok(mem.percent) ? mem.percent / 100 : null, 29);
    setPanelHeat("p-mem", Math.max(0, memT * 1.6 - 0.6));

    // ---------------------------------------------------------------- I/O
    bind("net-down",   net.down_bps,   rate);
    bind("net-up",     net.up_bps,     rate);
    bind("disk-read",  disk.read_bps,  rate);
    bind("disk-write", disk.write_bps, rate);
    meter("net-down-m",   logLevel(net.down_bps, 125e6), 0);
    meter("net-up-m",     logLevel(net.up_bps,   125e6), 0);
    meter("disk-read-m",  logLevel(disk.read_bps,  2e9), 0);
    meter("disk-write-m", logLevel(disk.write_bps, 2e9), 0);
    setText($("net-iface"), net.iface || DASH);

    // ------------------------------------------------------------- drives
    let drvHeat = 0;
    for (let i = 0; i < 4; i++) {
      const drv = (d.drives || [])[i] || {};
      const row = $("drive" + i);
      if (!row) continue;
      if (drv.label) setText(row.querySelector(".dname"), drv.label);
      const pctEl = row.querySelector(".dpct"), tEl = row.querySelector(".dtemp");
      if (!pctEl.id) { pctEl.id = `drive${i}-pct`; tEl.id = `drive${i}-temp`; row.querySelector(".dbar").id = `drive${i}-bar`; }
      const sT = ramp(drv.used_pct, RAMP.space), tT = ramp(drv.temp, RAMP.driveTemp);
      bind(pctEl.id, drv.used_pct, fixed(0), () => sT);
      bind(tEl.id, drv.temp, fixed(0), () => tT);
      meter(`drive${i}-bar`, ok(drv.used_pct) ? drv.used_pct / 100 : null, 10);
      drvHeat = Math.max(drvHeat, tT);
    }
    setPanelHeat("p-drives", Math.max(0, drvHeat * 1.6 - 0.6));

    // --------------------------------------------------------------- mobo
    bind("mobo", d.mobo_temp, fixed(0), (v) => ramp(v, RAMP.moboTemp));
  }

  PanelFeed.subscribe(render);
})();

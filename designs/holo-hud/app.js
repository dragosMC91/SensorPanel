/* Holo HUD — data binding only. CSS draws everything; this file sets text,
   and per-gauge custom properties:
     --p  0..1 fill   --c  heat colour   --n  active cores
   on every element carrying data-g="<gauge>". Numbers ease between 1 Hz
   readings on an animation frame (same approach as the production app.js),
   and the loop goes idle once every tween has settled. */

(() => {
  "use strict";

  const DASH = "–";
  const $ = (id) => document.getElementById(id);
  const clamp01 = (v) => Math.max(0, Math.min(1, v));
  const norm = (v, lo, hi) => clamp01((v - lo) / (hi - lo));
  const ok = (v) => v !== null && v !== undefined && !Number.isNaN(v);

  /* ---- fit the fixed 1024x600 stage into any viewport ---- */
  function fitStage() {
    const stage = $("stage");
    const s = Math.min(window.innerWidth / 1024, window.innerHeight / 600);
    stage.style.transform = `scale(${s})`;
    document.body.style.width = (1024 * s) + "px";
    document.body.style.height = (600 * s) + "px";
  }
  window.addEventListener("resize", fitStage);
  fitStage();

  /* ---- heat: cyan -> amber -> red, thresholds from the production panel ---- */
  const COOL = [111, 240, 255];
  const WARM = [255, 190, 92];
  const HOT  = [255, 72, 72];
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

  function ramp(v, [cool, warm, hot]) {
    if (!ok(v) || v <= cool) return 0;
    if (v >= hot) return 1;
    return v < warm ? (v - cool) / (warm - cool) * 0.5
                    : 0.5 + (v - warm) / (hot - warm) * 0.5;
  }
  const mix = (a, b, t) => a.map((x, i) => Math.round(x + (b[i] - x) * t));
  // cyan holds a little longer before turning amber, so the midpoint reads warm
  // rather than a muddy mint
  const heatRGB = (t) => (t <= 0.5 ? mix(COOL, WARM, (t * 2) ** 1.8) : mix(WARM, HOT, (t - 0.5) * 2));

  /* ---- gauges: every [data-g=name] gets --p / --c / .na ---- */
  const gaugeEls = new Map();
  function gauge(name, p, heat, extra) {
    let els = gaugeEls.get(name);
    if (!els) { els = [...document.querySelectorAll(`[data-g="${name}"]`)]; gaugeEls.set(name, els); }
    const na = !ok(p);
    const c = heatRGB(clamp01(heat || 0));
    els.forEach((el) => {
      el.classList.toggle("na", na);
      el.style.setProperty("--p", na ? "0" : clamp01(p).toFixed(4));
      if (na) el.style.removeProperty("--c");
      else el.style.setProperty("--c", `rgb(${c[0]},${c[1]},${c[2]})`);
      if (extra) for (const k in extra) el.style.setProperty(k, extra[k]);
    });
  }

  /* ---- tweened readouts (".v" holds digits, ".u" the unit) ---- */
  const TAU = 170;
  const binds = new Map();
  let dirty = true;

  function bind(id, value, fmt) {
    const el = $(id);
    if (!el) return;
    let b = binds.get(id);
    if (!b) {
      b = { el, v: el.querySelector(".v") || el, u: el.querySelector(".u"), cur: null, target: null, last: "" };
      binds.set(id, b);
    }
    b.fmt = fmt;
    b.target = ok(value) ? value : null;
    dirty = true;
  }

  function paint(dt) {
    if (!dirty) return;
    let moving = false;
    const k = 1 - Math.exp(-dt / TAU);
    binds.forEach((b) => {
      if (b.target === null) {
        b.cur = null;
        b.el.classList.add("na");
        b.el.classList.remove("idle");
        if (b.last !== DASH) { b.v.textContent = DASH; b.last = DASH; }
        return;
      }
      b.el.classList.remove("na");
      if (b.cur === null || Math.abs(b.target - b.cur) < 1e-3) b.cur = b.target;
      else { b.cur += (b.target - b.cur) * k; moving = true; }
      const out = b.fmt(b.cur);
      const obj = typeof out === "object";
      const text = obj ? out.text : out;
      if (text !== b.last) { b.v.textContent = text; b.last = text; }
      if (b.u && obj && out.unit && b.u.textContent !== out.unit) b.u.textContent = out.unit;
      b.el.classList.toggle("idle", obj && !!out.idle);
    });
    dirty = moving;
  }

  let lastFrame = performance.now();
  requestAnimationFrame(function frame(now) {
    paint(Math.min(120, now - lastFrame));
    lastFrame = now;
    requestAnimationFrame(frame);
  });

  const fixed = (d) => (v) => v.toFixed(d);

  /* bytes/s with a unit that follows the magnitude, max ~4 chars of digits */
  function rate(v) {
    const a = Math.abs(v);
    if (a >= 1024 ** 3) return { text: (v / 1024 ** 3).toFixed(2), unit: "GB/s" };
    if (a >= 1024 ** 2) {
      const mb = v / 1024 ** 2;
      return { text: mb >= 100 ? mb.toFixed(0) : mb.toFixed(1), unit: "MB/s" };
    }
    if (a >= 1024) return { text: (v / 1024).toFixed(0), unit: "KB/s" };
    return { text: v.toFixed(0), unit: "B/s", idle: a < 1 };
  }
  // throughput strip: log scale, ~1 KB/s -> 0, ~2 GB/s -> 1
  const rateLvl = (v) => (ok(v) ? clamp01((Math.log10(Math.max(1, v)) - 3) / 6.3) : null);

  /* ---- hot banner on a unit: names the worst offender ---- */
  function warn(unit, parts) {
    let worst = null;
    parts.forEach(([name, h]) => { if (h >= 0.75 && (!worst || h > worst[1])) worst = [name, h]; });
    $(unit + "-unit").classList.toggle("hot", !!worst);
    $(unit + "-warn").textContent = worst ? "▲ " + worst[0] : "";
  }

  /* ---- render one snapshot ---- */
  const dot = $("dot");
  function render(d) {
    const cpu = d.cpu || {}, gpu = d.gpu || {}, mem = d.mem || {}, net = d.net || {},
          disk = d.disk || {};

    // CPU
    const cuH = ramp(cpu.usage, RAMP.load);
    const ctH = ramp(cpu.temp, RAMP.cpuTemp);
    const cpH = ok(cpu.power) ? ramp(cpu.power / CPU_POWER_MAX, RAMP.power) : 0;
    gauge("cpu-usage", ok(cpu.usage) ? cpu.usage / 100 : null, cuH);
    gauge("cpu-temp",  ok(cpu.temp) ? norm(cpu.temp, 25, 100) : null, ctH);
    gauge("cpu-power", ok(cpu.power) ? cpu.power / CPU_POWER_MAX : null, cpH);
    bind("cpu-usage", cpu.usage, fixed(0));
    bind("cpu-temp",  cpu.temp,  fixed(0));
    bind("cpu-power", cpu.power, fixed(0));
    bind("cpu-clock", cpu.clock, fixed(0));
    const cores = cpu.cores || 12;
    const act = ok(cpu.active) ? cpu.active : null;
    gauge("cpu-active", act === null ? null : act / cores, ramp(act / cores * 100, RAMP.load),
          { "--n": act === null ? 0 : act });
    bind("cpu-active", act, fixed(0));
    $("cpu-active").querySelector(".u").textContent = "/" + cores;
    warn("cpu", [["THERMAL", ctH], ["POWER", cpH], ["MAX LOAD", cuH]]);

    // GPU
    const guH = ramp(gpu.usage, RAMP.load);
    const gtH = ramp(gpu.temp, RAMP.gpuTemp);
    const gpH = ok(gpu.power) ? ramp(gpu.power / GPU_POWER_MAX, RAMP.power) : 0;
    gauge("gpu-usage", ok(gpu.usage) ? gpu.usage / 100 : null, guH);
    gauge("gpu-temp",  ok(gpu.temp) ? norm(gpu.temp, 25, 100) : null, gtH);
    gauge("gpu-power", ok(gpu.power) ? gpu.power / GPU_POWER_MAX : null, gpH);
    bind("gpu-usage", gpu.usage, fixed(0));
    bind("gpu-temp",  gpu.temp,  fixed(0));
    bind("gpu-power", gpu.power, fixed(0));
    bind("gpu-clock", gpu.clock, fixed(0));
    const vOk = ok(gpu.vram_used_gb) && ok(gpu.vram_total_gb) && gpu.vram_total_gb > 0;
    const vPct = vOk ? (ok(gpu.vram_pct) ? gpu.vram_pct : gpu.vram_used_gb / gpu.vram_total_gb * 100) : null;
    gauge("gpu-vram", vOk ? vPct / 100 : null, ramp(vPct, RAMP.load));
    bind("gpu-vram", vOk ? gpu.vram_used_gb : null, fixed(1));
    $("gpu-vram-tot").textContent = "/" + (vOk ? gpu.vram_total_gb.toFixed(0) : "16") + " GB";
    warn("gpu", [["THERMAL", gtH], ["POWER", gpH], ["MAX LOAD", guH]]);

    // memory
    gauge("mem", ok(mem.percent) ? mem.percent / 100 : null, ramp(mem.percent, RAMP.load));
    bind("mem-pct", mem.percent, fixed(0));
    bind("mem-gb", mem.used_gb, fixed(1));
    $("mem-gb").querySelector(".u").textContent =
      "/ " + (ok(mem.total_gb) ? mem.total_gb.toFixed(1) : DASH) + " GB";

    // I/O
    $("iface").textContent = net.iface ? "NET · " + net.iface : "NET · DISK";
    [["net-down", net.down_bps], ["net-up", net.up_bps],
     ["disk-read", disk.read_bps], ["disk-write", disk.write_bps]].forEach(([id, v]) => {
      gauge(id, rateLvl(v), 0);
      bind(id, v, rate);
    });

    // drives
    (d.drives || []).slice(0, 4).forEach((drv, i) => {
      const row = $("drive" + i);
      if (!row) return;
      if (drv.label) row.querySelector(".dl").textContent = drv.label;
      const pEl = row.querySelector(".dp"), tEl = row.querySelector(".dt");
      gauge("d" + i + "s", ok(drv.used_pct) ? drv.used_pct / 100 : null, ramp(drv.used_pct, RAMP.space));
      gauge("d" + i + "t", ok(drv.temp) ? 1 : null, ramp(drv.temp, RAMP.driveTemp));
      pEl.textContent = ok(drv.used_pct) ? Math.round(drv.used_pct) + "%" : DASH;
      tEl.textContent = ok(drv.temp) ? Math.round(drv.temp) + "°C" : DASH;
    });

    // mobo
    gauge("mobo", ok(d.mobo_temp) ? norm(d.mobo_temp, 20, 70) : null, ramp(d.mobo_temp, RAMP.moboTemp));
    bind("mobo", d.mobo_temp, fixed(0));

    // heartbeat
    $("link").textContent = PanelFeed.demo ? "DEMO" : "LIVE";
    dot.animate([{ opacity: 1 }, { opacity: 0.25 }], { duration: 900, easing: "ease-out" });
  }

  /* ---- header clock + stale label ---- */
  const time = $("time");
  function tick() {
    const n = new Date();
    time.textContent = String(n.getHours()).padStart(2, "0") + ":" + String(n.getMinutes()).padStart(2, "0");
    if (document.body.classList.contains("stale")) $("link").textContent = "NO LINK";
  }
  tick();
  setInterval(tick, 1000);

  PanelFeed.subscribe(render);
})();

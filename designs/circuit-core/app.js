/* Circuit Core — data binding only. Text, classes and custom properties; CSS
   does all of the drawing. Ideas carried over from the production app.js:
   heat ramps, eased numbers between 1 Hz readings, magnitude-following rate
   units, fixed-width digit boxes, and a dimmed dash for every missing sensor. */

(() => {
  "use strict";

  const DASH = "–";
  const $ = (id) => document.getElementById(id);
  const stage = $("stage");
  const clamp01 = (v) => Math.max(0, Math.min(1, v));
  const norm = (v, lo, hi) => clamp01((v - lo) / (hi - lo));
  const ok = (v) => v !== null && v !== undefined && !Number.isNaN(v);

  /* ---- fit the fixed 1024x600 stage into the viewport ---- */
  function fitStage() {
    const s = Math.min(window.innerWidth / 1024, window.innerHeight / 600);
    stage.style.transform = `scale(${s})`;
    document.body.style.width = (1024 * s) + "px";
    document.body.style.height = (600 * s) + "px";
  }
  window.addEventListener("resize", fitStage);
  fitStage();

  /* ================================================================ heat == */
  const COOL = [169, 244, 255], WARM = [255, 203, 108], HOT = [255, 86, 108];
  // softer stops for numbers that sit on top of the coloured liquid
  const SOFT = [[244, 251, 255], [255, 222, 150], [255, 150, 160]];
  const RAMP = {
    cpuTemp: [58, 78, 92], gpuTemp: [58, 80, 95], driveTemp: [42, 58, 70],
    moboTemp: [36, 48, 60], load: [70, 88, 100], space: [72, 88, 97],
    power: [0.55, 0.80, 1.0],
  };
  const CPU_POWER_MAX = 142, GPU_POWER_MAX = 230;

  function ramp(v, [cool, warm, hot]) {
    if (!ok(v)) return 0;
    if (v <= cool) return 0;
    if (v >= hot) return 1;
    return v < warm ? (v - cool) / (warm - cool) * 0.5 : 0.5 + (v - warm) / (hot - warm) * 0.5;
  }
  const mix = (a, b, t) => a.map((x, i) => Math.round(x + (b[i] - x) * t));
  const heatRGB = (t, p) => {
    const [c, w, h] = p || [COOL, WARM, HOT];
    return t <= 0.5 ? mix(c, w, t * 2) : mix(w, h, (t - 0.5) * 2);
  };
  const rgb = (c, a) => (a === undefined ? `rgb(${c})` : `rgba(${c},${a})`);

  function paintHeat(el, t, soft) {
    if (!(t > 0.01)) { el.style.removeProperty("color"); el.style.removeProperty("text-shadow"); return; }
    const c = heatRGB(t, soft ? SOFT : null);
    el.style.color = rgb(c);
    el.style.textShadow = soft
      ? `0 0 2px rgba(0,0,0,.9), 0 1px 6px rgba(20,0,40,.9), 0 0 ${10 + 10 * t}px ${rgb(c, .5)}`
      : `0 0 6px ${rgb(c, .85)}, 0 0 ${14 + 12 * t}px ${rgb(c, .5)}`;
  }

  /* =============================================================== tween == */
  const TAU = 170;
  const bindings = new Map();
  let dirty = true;

  /* id: element with .v (digits) and optional .u (unit) children.
     fmt: v -> string | {text, unit, idle}; heat: 0..1 for the target value. */
  function bind(id, value, fmt, heat, soft) {
    const el = $(id);
    if (!el) return;
    let b = bindings.get(id);
    if (!b) {
      b = { el, v: el.querySelector(".v"), u: el.querySelector(".u"),
            wide: +el.dataset.wide || 0, cur: null, target: null, text: null };
      bindings.set(id, b);
    }
    b.fmt = fmt; b.heat = heat || 0; b.soft = soft;
    b.target = ok(value) ? value : null;
    dirty = true;
  }

  function paint(dt) {
    if (!dirty) return;
    let moving = false;
    const k = 1 - Math.exp(-dt / TAU);
    bindings.forEach((b) => {
      const el = b.el;
      if (b.target === null) {
        b.cur = null;
        if (b.text !== DASH) {
          b.text = DASH; b.v.textContent = DASH;
          el.classList.add("na"); el.classList.remove("idle", "wide");
          paintHeat(el, 0);
        }
        return;
      }
      el.classList.remove("na");
      if (b.cur === null || Math.abs(b.target - b.cur) < 1e-3) b.cur = b.target;
      else { b.cur += (b.target - b.cur) * k; moving = true; }
      const out = b.fmt(b.cur);
      const obj = typeof out === "object";
      const text = obj ? out.text : out;
      if (text !== b.text) { b.text = text; b.v.textContent = text; }
      if (b.u && obj && out.unit && b.u.textContent !== out.unit) b.u.textContent = out.unit;
      el.classList.toggle("idle", obj && !!out.idle);
      if (b.wide) el.classList.toggle("wide", text.length >= b.wide);
      paintHeat(el, b.heat, b.soft);
    });
    dirty = moving;
  }

  let last = performance.now();
  requestAnimationFrame(function frame(now) {
    paint(Math.min(120, now - last));
    last = now;
    requestAnimationFrame(frame);
  });

  /* ========================================================== formatters == */
  const fixed = (n) => (v) => v.toFixed(n);
  function rate(v) {
    const a = Math.abs(v);
    if (a >= 1024 ** 3) return { text: (v / 1024 ** 3).toFixed(2), unit: "GB/s" };
    if (a >= 1024 ** 2) { const m = v / 1024 ** 2; return { text: m >= 100 ? m.toFixed(0) : m.toFixed(1), unit: "MB/s" }; }
    if (a >= 1024) return { text: (v / 1024).toFixed(0), unit: "KB/s" };
    return { text: v.toFixed(0), unit: "B/s", idle: a < 1 };
  }

  /* ========================================================= gauges ==== */
  function orb(id, value, fill, heat) {
    const el = $(id);
    const has = ok(value);
    el.style.setProperty("--fill", has ? clamp01(fill).toFixed(3) : "0");
    el.style.setProperty("--heat", has ? clamp01(heat).toFixed(3) : "0");
    el.classList.toggle("na", !has);
    el.classList.toggle("hot", has && heat >= 0.75);
  }

  function setBar(el, pct, t) {
    if (!el) return;
    el.style.setProperty("--pct", ok(pct) ? clamp01(pct / 100).toFixed(3) : "0");
    el.style.setProperty("--hc", rgb(heatRGB(t)));
  }

  function textBind(id, text, t) {
    const el = $(id);
    const has = text !== null;
    el.querySelector(".v").textContent = has ? text : DASH;
    el.classList.toggle("na", !has);
    paintHeat(el, has ? t : 0);
  }

  const cores = [...document.querySelectorAll("#cores i")];

  /* ============================================================ render ==== */
  function render(d) {
    const cpu = d.cpu || {}, gpu = d.gpu || {}, mem = d.mem || {},
          net = d.net || {}, disk = d.disk || {};

    // CPU
    const tCpuU = ramp(cpu.usage, RAMP.load), tCpuT = ramp(cpu.temp, RAMP.cpuTemp);
    const tCpuP = ok(cpu.power) ? ramp(cpu.power / CPU_POWER_MAX, RAMP.power) : 0;
    bind("cpu-usage", cpu.usage, fixed(0), tCpuU, true);
    bind("cpu-temp", cpu.temp, fixed(0), tCpuT, true);
    bind("cpu-power", cpu.power, fixed(0), tCpuP, true);
    bind("cpu-clock", cpu.clock, fixed(0));
    orb("orb-cpu-usage", cpu.usage, (cpu.usage ?? 0) / 100, tCpuU);
    orb("orb-cpu-temp", cpu.temp, norm(cpu.temp ?? 0, 25, 100), tCpuT);
    orb("orb-cpu-power", cpu.power, (cpu.power ?? 0) / CPU_POWER_MAX, tCpuP);

    const act = ok(cpu.active) && cpu.cores ? cpu.active : null;
    const actEl = $("cpu-active");
    actEl.querySelector(".u").textContent = "/" + (cpu.cores || 12);
    textBind("cpu-active", act === null ? null : String(act),
             act === null ? 0 : ramp(act / cpu.cores * 100, RAMP.load));
    const coreCol = rgb(heatRGB(Math.max(tCpuU, tCpuT)));
    cores.forEach((c, i) => c.classList.toggle("on", act !== null && i < act));
    $("cores").style.setProperty("--core", coreCol);

    // GPU
    const tGpuU = ramp(gpu.usage, RAMP.load), tGpuT = ramp(gpu.temp, RAMP.gpuTemp);
    const tGpuP = ok(gpu.power) ? ramp(gpu.power / GPU_POWER_MAX, RAMP.power) : 0;
    bind("gpu-usage", gpu.usage, fixed(0), tGpuU, true);
    bind("gpu-temp", gpu.temp, fixed(0), tGpuT, true);
    bind("gpu-power", gpu.power, fixed(0), tGpuP, true);
    bind("gpu-clock", gpu.clock, fixed(0));
    orb("orb-gpu-usage", gpu.usage, (gpu.usage ?? 0) / 100, tGpuU);
    orb("orb-gpu-temp", gpu.temp, norm(gpu.temp ?? 0, 25, 100), tGpuT);
    orb("orb-gpu-power", gpu.power, (gpu.power ?? 0) / GPU_POWER_MAX, tGpuP);

    const vOk = ok(gpu.vram_used_gb) && gpu.vram_total_gb;
    const tV = vOk ? ramp(gpu.vram_pct ?? gpu.vram_used_gb / gpu.vram_total_gb * 100, RAMP.load) : 0;
    textBind("gpu-vram", vOk ? `${gpu.vram_used_gb.toFixed(1)}/${gpu.vram_total_gb.toFixed(0)}` : null, tV);
    setBar($("vram-bar"), vOk ? gpu.vram_used_gb / gpu.vram_total_gb * 100 : null, tV);

    // ambient intensity + alarm state
    const load = clamp01(((cpu.usage ?? 0) + (gpu.usage ?? 0)) / 200);
    stage.style.setProperty("--load", load.toFixed(2));
    stage.classList.toggle("overheat", tCpuT >= 0.75 || tGpuT >= 0.75);

    // memory
    const tM = ramp(mem.percent, RAMP.load);
    bind("mem-pct", mem.percent, fixed(0), tM);
    bind("mem-gb", mem.used_gb, fixed(1), tM);
    $("mem-total").textContent = ok(mem.total_gb) ? mem.total_gb.toFixed(1) : DASH;
    const tank = $("mem-tank");
    tank.style.setProperty("--fill", ok(mem.percent) ? clamp01(mem.percent / 100).toFixed(3) : "0");
    tank.style.setProperty("--heat", tM.toFixed(3));
    tank.classList.toggle("na", !ok(mem.percent));

    // I/O
    $("net-iface").textContent = net.iface || "";
    bind("net-down", net.down_bps, rate);
    bind("net-up", net.up_bps, rate);
    bind("disk-read", disk.read_bps, rate);
    bind("disk-write", disk.write_bps, rate);

    // drives
    (d.drives || []).slice(0, 4).forEach((drv, i) => {
      const row = $("drv" + i);
      if (!row) return;
      const lab = row.querySelector(".dl");
      if (lab.textContent !== drv.label) lab.textContent = drv.label || DASH;
      const tS = ramp(drv.used_pct, RAMP.space);
      bind(`d${i}-pct`, drv.used_pct, fixed(0), tS);
      bind(`d${i}-temp`, drv.temp, fixed(0), ramp(drv.temp, RAMP.driveTemp));
      setBar(row, drv.used_pct, tS);
      row.classList.toggle("nobar", !ok(drv.used_pct));
    });

    // mobo
    const tB = ramp(d.mobo_temp, RAMP.moboTemp);
    bind("mobo", d.mobo_temp, fixed(0), tB);
    const dial = $("mobo-dial");
    dial.style.setProperty("--pct", ok(d.mobo_temp) ? norm(d.mobo_temp, 20, 70).toFixed(3) : "0");
    dial.style.setProperty("--hc", rgb(heatRGB(tB)));
  }

  PanelFeed.subscribe(render);
})();

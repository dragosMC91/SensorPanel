/* Tactical MFD — data binding only.
   Text readouts ease toward each 1 Hz reading on animation frames (same idea as
   the production app.js); gauges get a custom property (--pct / --t / --r)
   and CSS eases + draws them. Heat colours, caution/warning tags and the
   master annunciator are derived here from the production RAMP thresholds. */

(() => {
  "use strict";

  const DASH = "–";
  const $ = (id) => document.getElementById(id);
  const ok = (v) => v !== null && v !== undefined && !Number.isNaN(v);
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  /* ---- scale the fixed 1024x600 stage into the viewport (see root app.js) */
  function fitStage() {
    const s = Math.min(window.innerWidth / 1024, window.innerHeight / 600);
    $("stage").style.transform = `scale(${s})`;
    document.body.style.width = 1024 * s + "px";
    document.body.style.height = 600 * s + "px";
  }
  window.addEventListener("resize", fitStage);
  fitStage();

  /* ================================================================ heat == */
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
  const CPU_CLK_MAX = 4650, GPU_CLK_MAX = 2475;

  function ramp(v, [cool, warm, hot]) {
    if (!ok(v) || v <= cool) return 0;
    if (v >= hot) return 1;
    return v < warm ? (v - cool) / (warm - cool) * 0.5 : 0.5 + (v - warm) / (hot - warm) * 0.5;
  }
  // phosphor amber -> deep orange -> warning red
  const COOL = [255, 212, 122], WARM = [255, 150, 20], HOT = [255, 59, 43];
  const mix = (a, b, t) => a.map((x, i) => Math.round(x + (b[i] - x) * t));
  const heatRGB = (t) => (t <= 0.5 ? mix(COOL, WARM, t * 2) : mix(WARM, HOT, (t - 0.5) * 2));
  function paintHeat(el, t) {
    if (!el) return;
    if (!(t > 0.01)) { el.style.removeProperty("--c"); return; }
    const c = heatRGB(t);
    el.style.setProperty("--c", `rgb(${c})`);
  }
  // discrete level for tags/blips: 0 nominal, 1 caution (past the ramp's
  // "warm" stop), 2 warning (at or past its "hot" stop)
  const level = (t) => (t >= 0.999 ? 2 : t >= 0.5 ? 1 : 0);
  const caution = (t) => Math.min(1, level(t));   // load/power never go red

  /* =============================================================== tween == */
  const TAU = 170;
  const bindings = new Map();
  let dirty = true;

  function setText(b, s) {
    if (b.pad) {
      if (s === DASH) s = DASH.repeat(b.pad);      // a dashed-out field, MFD style
      const lead = s[0] === DASH ? "" : "0".repeat(Math.max(0, b.pad - s.length));
      if (b.z.textContent !== lead) b.z.textContent = lead;
      if (b.n.textContent !== s) b.n.textContent = s;
    } else if (b.el.textContent !== s) b.el.textContent = s;
  }

  /* id: the .num element; fmt(v) -> string | {text, unit, idle};
     heat: 0..1 for the reading (or null) — coloured on the .num itself */
  function bind(id, value, fmt, heat) {
    const el = $(id);
    if (!el) return;
    let b = bindings.get(id);
    if (!b) {
      b = { el, pad: +el.dataset.pad || 0, z: el.querySelector("s"), n: el.querySelector("b"),
            unit: $(id + "-u"), cur: null };
      bindings.set(id, b);
    }
    b.fmt = fmt;
    b.target = ok(value) ? value : null;
    b.heat = heat || 0;
    dirty = true;
  }

  function paintBindings(dt) {
    if (!dirty) return;
    let moving = false;
    const k = 1 - Math.exp(-dt / TAU);
    bindings.forEach((b) => {
      if (b.target === null) {
        b.cur = null;
        b.el.classList.add("na");
        b.el.classList.remove("idle");
        paintHeat(b.el, 0);
        setText(b, DASH);
        return;
      }
      b.el.classList.remove("na");
      if (b.cur === null || Math.abs(b.target - b.cur) < 1e-3) b.cur = b.target;
      else { b.cur += (b.target - b.cur) * k; moving = true; }
      const out = b.fmt(b.cur);
      const obj = typeof out === "object";
      setText(b, obj ? out.text : out);
      if (b.unit && obj && out.unit && b.unit.textContent !== out.unit) b.unit.textContent = out.unit;
      b.el.classList.toggle("idle", obj && !!out.idle);
      paintHeat(b.el, b.heat);
    });
    dirty = moving;
  }

  let lastFrame = performance.now();
  requestAnimationFrame(function frame(now) {
    paintBindings(Math.min(120, now - lastFrame));
    lastFrame = now;
    requestAnimationFrame(frame);
  });

  /* ---- formatters ---- */
  const fixed = (d) => (v) => v.toFixed(d);
  function rate(v) {
    const a = Math.abs(v);
    if (a >= 1024 ** 3) return { text: (v / 1024 ** 3).toFixed(2), unit: "GB/s" };
    if (a >= 1024 ** 2) { const m = v / 1024 ** 2; return { text: m >= 100 ? m.toFixed(0) : m.toFixed(1), unit: "MB/s" }; }
    if (a >= 1024) return { text: (v / 1024).toFixed(0), unit: "KB/s" };
    return { text: v.toFixed(0), unit: "B/s", idle: a < 1 };
  }

  /* ---- gauges: custom properties, written only when they change ---- */
  function setVar(el, name, v) {
    if (!el) return;
    const s = v.toFixed(2);
    if (el.style.getPropertyValue(name) !== s) el.style.setProperty(name, s);
  }
  function led(id, pct) {
    const el = $(id);
    if (!el) return;
    el.classList.toggle("na", !ok(pct));
    setVar(el, "--pct", ok(pct) ? clamp(pct, 0, 100) : 0);
  }
  function tape(id, temp, lo = 20, hi = 100) {
    const el = $(id);
    el.classList.toggle("na", !ok(temp));
    setVar(el.querySelector(".col"), "--t", ok(temp) ? clamp((temp - lo) / (hi - lo) * 100, 0, 100) : 0);
    setVar(el.querySelector(".ptr"), "--t", ok(temp) ? clamp((temp - lo) / (hi - lo) * 100, 0, 100) : 0);
  }
  // log-scale activity bar for byte rates: 1 KB/s .. max
  const logPct = (bps, max) => (!ok(bps) ? null : bps <= 1024 ? 0 :
    clamp((Math.log10(bps) - 3) / (Math.log10(max) - 3) * 100, 0, 100));

  function blip(id, pct, t) {
    const el = $(id);
    el.classList.toggle("na", !ok(pct));
    setVar(el, "--r", ok(pct) ? clamp(pct, 0, 100) : 0);
    const l = level(t);
    el.classList.toggle("caut", l === 1);
    el.classList.toggle("warn", l === 2);
  }

  const TAGCLS = ["", "caut", "warn"];
  function tag(el, issues, anyData) {
    // issues: [[level, text], ...] — show the worst one
    issues.sort((a, b) => b[0] - a[0]);
    const top = issues[0];
    el.className = "tag " + (!anyData ? "na" : top ? TAGCLS[top[0]] : "");
    el.textContent = !anyData ? "NO DATA" : top ? top[1] : "NOMINAL";
    const pnl = el.closest(".pnl");
    if (pnl) pnl.classList.toggle("alarm", !!(anyData && top && top[0] === 2));
  }

  /* ============================================================== render == */
  const pips = [...document.querySelectorAll("#cpu-pips i")];
  let samples = 0;

  function render(d) {
    const cpu = d.cpu || {}, gpu = d.gpu || {}, mem = d.mem || {}, net = d.net || {},
          disk = d.disk || {}, drives = d.drives || [];
    const alerts = [];   // [level, "SRC TEXT"] for the master annunciator
    let present = 0;     // how many primary sensors reported anything

    /* ---- CPU ---- */
    const cT = ramp(cpu.temp, RAMP.cpuTemp), cL = ramp(cpu.usage, RAMP.load),
          cP = ok(cpu.power) ? ramp(cpu.power / CPU_POWER_MAX, RAMP.power) : 0;
    bind("cpu-load", cpu.usage, fixed(0), cL);
    bind("cpu-temp", cpu.temp, fixed(0), cT);
    bind("cpu-pwr", cpu.power, fixed(0), cP);
    bind("cpu-clk", cpu.clock, fixed(0));
    led("cpu-load-bar", cpu.usage);
    led("cpu-pwr-bar", ok(cpu.power) ? cpu.power / CPU_POWER_MAX * 100 : null);
    led("cpu-clk-bar", ok(cpu.clock) ? cpu.clock / CPU_CLK_MAX * 100 : null);
    tape("cpu-tape", cpu.temp);
    $("cpu-tape").classList.toggle("hot", level(cT) === 2);
    const cores = cpu.cores || 12;
    const act = ok(cpu.active) ? cpu.active : null;
    const aT = act === null ? 0 : ramp(act / cores * 100, RAMP.load);
    bind("cpu-act", act, (v) => `${Math.round(v)}/${cores}`, aT);
    pips.forEach((p, i) => p.classList.toggle("on", act !== null && i < act));
    paintHeat($("cpu-pips"), aT);
    const cIss = [];
    if (level(cT) === 2) cIss.push([2, "OVERTEMP"]); else if (level(cT)) cIss.push([1, "TEMP HI"]);
    if (caution(cL)) cIss.push([1, "MAX LOAD"]);
    if (caution(cP)) cIss.push([1, "PWR HI"]);
    const cAny = [cpu.usage, cpu.temp, cpu.power, cpu.clock].some(ok);
    tag($("cpu-tag"), cIss, cAny);
    cIss.forEach(([l, t]) => alerts.push([l, "CPU " + t]));
    present += cAny;

    /* ---- GPU ---- */
    const gT = ramp(gpu.temp, RAMP.gpuTemp), gL = ramp(gpu.usage, RAMP.load),
          gP = ok(gpu.power) ? ramp(gpu.power / GPU_POWER_MAX, RAMP.power) : 0,
          gV = ramp(gpu.vram_pct, RAMP.load);
    bind("gpu-load", gpu.usage, fixed(0), gL);
    bind("gpu-temp", gpu.temp, fixed(0), gT);
    bind("gpu-pwr", gpu.power, fixed(0), gP);
    bind("gpu-clk", gpu.clock, fixed(0));
    led("gpu-load-bar", gpu.usage);
    led("gpu-pwr-bar", ok(gpu.power) ? gpu.power / GPU_POWER_MAX * 100 : null);
    led("gpu-clk-bar", ok(gpu.clock) ? gpu.clock / GPU_CLK_MAX * 100 : null);
    tape("gpu-tape", gpu.temp);
    $("gpu-tape").classList.toggle("hot", level(gT) === 2);
    const vOk = ok(gpu.vram_used_gb) && ok(gpu.vram_total_gb);
    bind("gpu-vram", vOk ? gpu.vram_used_gb : null, fixed(1), gV);
    $("gpu-vram-u").textContent = ok(gpu.vram_total_gb) ? `/${gpu.vram_total_gb.toFixed(0)} GB` : "/– GB";
    led("gpu-vram-bar", ok(gpu.vram_pct) ? gpu.vram_pct
      : vOk ? gpu.vram_used_gb / gpu.vram_total_gb * 100 : null);
    const gIss = [];
    if (level(gT) === 2) gIss.push([2, "OVERTEMP"]); else if (level(gT)) gIss.push([1, "TEMP HI"]);
    if (caution(gL)) gIss.push([1, "MAX LOAD"]);
    if (caution(gP)) gIss.push([1, "PWR HI"]);
    if (caution(gV)) gIss.push([1, "VRAM HI"]);
    const gAny = [gpu.usage, gpu.temp, gpu.power, gpu.clock].some(ok);
    tag($("gpu-tag"), gIss, gAny);
    gIss.forEach(([l, t]) => alerts.push([l, "GPU " + t]));
    present += gAny;

    /* ---- scope blips: range = load ---- */
    blip("b-cpu", cpu.usage, cL);
    blip("b-gpu", gpu.usage, gL);
    blip("b-vram", ok(gpu.vram_pct) ? gpu.vram_pct : null, gV);
    const mL = ramp(mem.percent, RAMP.load);
    blip("b-mem", mem.percent, mL);

    /* ---- memory ---- */
    bind("mem-pct", mem.percent, fixed(0), mL);
    bind("mem-used", mem.used_gb, fixed(1), mL);
    $("mem-tot").textContent = ` / ${ok(mem.total_gb) ? mem.total_gb.toFixed(1) : DASH} GB`;
    led("mem-bar", mem.percent);
    const mIss = [];
    if (ok(mem.percent) && mem.percent >= 97) mIss.push([2, "MEM CRIT"]);
    else if (level(mL)) mIss.push([1, "MEM HI"]);
    tag($("mem-tag"), mIss, ok(mem.percent));
    mIss.forEach(([l, t]) => alerts.push([l, t]));
    present += ok(mem.percent);

    /* ---- network / disk I/O ---- */
    $("iface").textContent = net.iface ? "IF " + String(net.iface).toUpperCase() : "IF —";
    bind("net-dn", net.down_bps, rate);
    bind("net-up", net.up_bps, rate);
    bind("dsk-rd", disk.read_bps, rate);
    bind("dsk-wr", disk.write_bps, rate);
    led("net-dn-bar", logPct(net.down_bps, 125e6));
    led("net-up-bar", logPct(net.up_bps, 125e6));
    led("dsk-rd-bar", logPct(disk.read_bps, 3.5e9));
    led("dsk-wr-bar", logPct(disk.write_bps, 3.5e9));

    /* ---- drives ---- */
    const dIss = [];
    let dAny = false;
    for (let i = 0; i < 4; i++) {
      const drv = drives[i] || {};
      const cell = $("drv" + i);
      cell.querySelector(".dl").textContent = drv.label ? String(drv.label).toUpperCase() : DASH;
      const tT = ramp(drv.temp, RAMP.driveTemp), sT = ramp(drv.used_pct, RAMP.space);
      bind(`drv${i}-t`, drv.temp, (v) => v.toFixed(0) + "°C", tT);
      bind(`drv${i}-p`, drv.used_pct, (v) => v.toFixed(0) + "%", sT);
      led(`drv${i}-bar`, drv.used_pct);
      const em = cell.querySelector("em");
      const lt = level(tT), ls = level(sT);
      if (lt === 2) { em.className = "warn"; em.textContent = "HOT"; }
      else if (ls === 2) { em.className = "warn"; em.textContent = "FULL"; }
      else if (lt || ls) { em.className = "caut"; em.textContent = lt ? "WARM" : "FILL"; }
      else { em.className = ""; em.textContent = ""; }
      if (lt) dIss.push([lt, `D${i} ${lt === 2 ? "OVERTEMP" : "TEMP HI"}`]);
      if (ls) dIss.push([ls, `D${i} ${ls === 2 ? "FULL" : "SPACE LOW"}`]);
      dAny = dAny || ok(drv.temp) || ok(drv.used_pct);
    }
    tag($("drv-tag"), dIss.map((x) => x.slice()), dAny);
    dIss.forEach((x) => alerts.push(x));

    /* ---- mobo ---- */
    const bT = ramp(d.mobo_temp, RAMP.moboTemp);
    bind("mb-t", d.mobo_temp, fixed(0), bT);
    led("mb-bar", ok(d.mobo_temp) ? (d.mobo_temp - 20) / 60 * 100 : null);
    if (level(bT)) alerts.push([level(bT), level(bT) === 2 ? "MOBO OVERTEMP" : "MOBO TEMP HI"]);

    /* ---- master annunciator ---- */
    const m = $("master");
    alerts.sort((a, b) => b[0] - a[0]);
    if (!present) { m.className = "na"; $("master-t").textContent = "NO SENSOR DATA"; }
    else if (!alerts.length) { m.className = ""; $("master-t").textContent = "ALL SYS NOMINAL"; }
    else {
      const worst = alerts[0][0];
      const n = alerts.filter((a) => a[0] === worst).length;
      m.className = worst === 2 ? "warn" : "caut";
      $("master-t").textContent = (worst === 2 ? "WARN " : "CAUT ") + alerts[0][1] + (n > 1 ? ` +${n - 1}` : "");
    }

    samples = (samples + 1) % 1e6;
    $("smp").textContent = String(samples).padStart(6, "0");
  }

  PanelFeed.subscribe(render);

  /* ---- clock (local time) ---- */
  const clock = $("clock");
  const tick = () => {
    const t = new Date();
    clock.textContent = [t.getHours(), t.getMinutes(), t.getSeconds()]
      .map((x) => String(x).padStart(2, "0")).join(":");
  };
  tick();
  setInterval(tick, 1000);
})();

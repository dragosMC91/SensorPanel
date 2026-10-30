/* Glass Core — data binding only.
   Text readouts ease toward each 1 Hz reading on an animation frame (same idea
   as the production app.js); gauges get a registered custom property (--p) and
   CSS transitions draw the motion. Heat is pushed as two colours (--c accent,
   --tc text) that CSS also transitions. Any null renders a dimmed dash. */

(() => {
  "use strict";

  const DASH = "–";
  const $ = (id) => document.getElementById(id);
  const clamp01 = (v) => Math.max(0, Math.min(1, v));
  const isNum = (v) => typeof v === "number" && !Number.isNaN(v);

  /* ---- fit the fixed 1024x600 stage into the viewport ---- */
  function fitStage() {
    const stage = $("stage");
    const s = Math.min(window.innerWidth / 1024, window.innerHeight / 600);
    stage.style.transform = `scale(${s})`;
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

  function ramp(v, stops) {
    if (!isNum(v)) return 0;
    const [cool, warm, hot] = stops;
    if (v <= cool) return 0;
    if (v >= hot) return 1;
    return v < warm ? (v - cool) / (warm - cool) * 0.5
                    : 0.5 + (v - warm) / (hot - warm) * 0.5;
  }

  const ACCENT = [150, 212, 255];   // ice blue
  const TEXT   = [238, 246, 255];   // cool white
  const WARM   = [255, 190, 92];
  const HOT    = [255, 84, 92];
  const mix = (a, b, t) => a.map((x, i) => Math.round(x + (b[i] - x) * t));
  const warmth = (base, t) => (t <= 0.5 ? mix(base, WARM, t * 2) : mix(WARM, HOT, (t - 0.5) * 2));
  const rgb = (c) => `rgb(${c[0]},${c[1]},${c[2]})`;

  // Always set (never remove) so a cool child never inherits a hot parent.
  function heat(el, t) {
    if (!el) return;
    t = clamp01(t || 0);
    el.style.setProperty("--c", rgb(warmth(ACCENT, t)));
    el.style.setProperty("--tc", rgb(warmth(TEXT, t)));
  }

  /* ================================================================ gauges */
  function gauge(el, pct) {
    if (!el) return;
    const ok = isNum(pct);
    const p = ok ? Math.max(0, Math.min(100, pct)) : 0;
    el.style.setProperty("--p", p.toFixed(2));
    el.classList.toggle("na", !ok);
    el.classList.toggle("lit", ok && p >= 0.5);
  }

  /* ================================================================= tween */
  const TAU = 170;
  const bindings = new Map();
  let dirty = true;

  function bind(id, value, fmt) {
    const el = $(id);
    if (!el) return;
    let b = bindings.get(id);
    if (!b) {
      b = { el, v: el.querySelector(".v"), unit: el.querySelector(".u"),
            cur: null, target: null };
      bindings.set(id, b);
    }
    b.fmt = fmt;
    b.target = isNum(value) ? value : null;
    dirty = true;
  }

  function setText(b, s) {
    if (b.v) b.v.textContent = s; else b.el.textContent = s;
  }

  function paint(dt) {
    if (!dirty) return;
    let moving = false;
    const k = 1 - Math.exp(-dt / TAU);
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
      if (b.cur === null || Math.abs(b.target - b.cur) < 1e-3) b.cur = b.target;
      else { b.cur += (b.target - b.cur) * k; moving = true; }
      const out = b.fmt(b.cur);
      const obj = typeof out === "object";
      const text = obj ? out.text : out;
      setText(b, text);
      if (b.unit && obj && out.unit && b.unit.textContent !== out.unit) b.unit.textContent = out.unit;
      el.classList.toggle("idle", obj && !!out.idle);
      if (obj && out.wide !== undefined) el.classList.toggle("wide", out.wide);
    });
    dirty = moving;
  }

  let last = performance.now();
  requestAnimationFrame(function frame(now) {
    paint(Math.min(120, now - last));
    last = now;
    requestAnimationFrame(frame);
  });

  /* ============================================================ formatters */
  const int = (v) => Math.round(v).toString();
  const usageFmt = (v) => { const t = Math.round(v).toString(); return { text: t, wide: t.length >= 3 }; };

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

  /* ========================================================== static DOM */
  const pills = $("cpu-pills");
  for (let i = 0; i < 12; i++) pills.appendChild(document.createElement("i"));

  const drivesEl = $("drives");
  const driveRows = [];
  for (let i = 0; i < 4; i++) {
    const row = document.createElement("div");
    row.className = "drive";
    row.innerHTML =
      `<span class="dname">${DASH}</span>` +
      `<span class="bar" id="drive${i}-bar"><i class="fill"></i><i class="edge"></i></span>` +
      `<span class="dpct" id="drive${i}-pct"><span class="v w3">${DASH}</span><span class="u">%</span></span>` +
      `<span class="dtemp" id="drive${i}-temp"><span class="v w2">${DASH}</span><span class="u">°C</span></span>`;
    drivesEl.appendChild(row);
    driveRows.push(row);
  }

  /* ============================================================== render */
  function chipText(usage, h, anyData) {
    if (!anyData) return "NO DATA";
    if (h >= 0.75) return "HOT";
    if (h >= 0.4) return "WARM";
    if (isNum(usage) && usage < 8) return "IDLE";
    return "NOMINAL";
  }

  function unit(side, s, maxPower, maxClock, tempRamp) {
    const card = $(side + "-card");
    const tUse = ramp(s.usage, RAMP.load);
    const tTemp = ramp(s.temp, tempRamp);
    const tPow = isNum(s.power) ? ramp(s.power / maxPower, RAMP.power) : 0;

    bind(side + "-usage", s.usage, usageFmt);
    gauge($(side + "-ring"), s.usage);
    heat($(side + "-ring"), tUse);

    bind(side + "-temp", s.temp, int);
    gauge($(side + "-temp-bar"), isNum(s.temp) ? (s.temp - 25) / (100 - 25) * 100 : null);
    heat($(side + "-temp-s"), tTemp);

    bind(side + "-power", s.power, int);
    gauge($(side + "-power-bar"), isNum(s.power) ? s.power / maxPower * 100 : null);
    heat($(side + "-power-s"), tPow);

    bind(side + "-clock", s.clock, int);
    gauge($(side + "-clock-bar"), isNum(s.clock) ? s.clock / maxClock * 100 : null);
    heat($(side + "-clock-s"), 0);

    const h = Math.max(tUse, tTemp, tPow);
    heat(card, h);
    card.classList.toggle("hot", h >= 0.75);
    const any = [s.usage, s.temp, s.power, s.clock].some(isNum);
    $(side + "-chip").textContent = chipText(s.usage, h, any);
    card.classList.toggle("nodata", !any);
    $("warm-" + side).style.setProperty("--hx", (h * 0.95).toFixed(3));
  }

  function render(d) {
    const cpu = d.cpu || {}, gpu = d.gpu || {}, mem = d.mem || {},
          net = d.net || {}, disk = d.disk || {};

    unit("cpu", cpu, CPU_POWER_MAX, CPU_CLOCK_MAX, RAMP.cpuTemp);
    unit("gpu", gpu, GPU_POWER_MAX, GPU_CLOCK_MAX, RAMP.gpuTemp);

    // active cores: 12 pills + "x/12"
    const cores = isNum(cpu.cores) ? cpu.cores : 12;
    const act = $("cpu-active");
    const coresS = $("cpu-cores-s");
    if (isNum(cpu.active)) {
      act.classList.remove("na");
      act.innerHTML = `${cpu.active}<span class="u">/${cores}</span>`;
      [...pills.children].forEach((p, i) => p.classList.toggle("on", i < cpu.active));
      heat(coresS, ramp(cpu.active / cores * 100, RAMP.load));
    } else {
      act.classList.add("na");
      act.textContent = DASH;
      [...pills.children].forEach((p) => p.classList.remove("on"));
      heat(coresS, 0);
    }

    // VRAM
    const vram = $("gpu-vram");
    const vramS = $("gpu-vram-s");
    if (isNum(gpu.vram_used_gb) && isNum(gpu.vram_total_gb) && gpu.vram_total_gb > 0) {
      const pct = isNum(gpu.vram_pct) ? gpu.vram_pct : gpu.vram_used_gb / gpu.vram_total_gb * 100;
      vram.classList.remove("na");
      vram.innerHTML = `${gpu.vram_used_gb.toFixed(1)}<span class="u">/ ${gpu.vram_total_gb.toFixed(0)} GB</span>`;
      gauge($("gpu-vram-bar"), pct);
      heat(vramS, ramp(pct, RAMP.load));
    } else {
      vram.classList.add("na");
      vram.textContent = DASH;
      gauge($("gpu-vram-bar"), null);
      heat(vramS, 0);
    }

    // memory
    bind("mem-pct", mem.percent, int);
    gauge($("mem-bar"), mem.percent);
    heat($("mem-card"), ramp(mem.percent, RAMP.load));
    bind("mem-gb", mem.used_gb, (v) => ({
      text: v.toFixed(1),
      unit: "of " + (isNum(mem.total_gb) ? mem.total_gb.toFixed(1) : DASH) + " GB",
    }));
    $("mem-gb").classList.toggle("na", !isNum(mem.used_gb));

    // I/O
    $("net-iface").textContent = net.iface || "";
    bind("net-down", net.down_bps, rate);
    bind("net-up", net.up_bps, rate);
    bind("disk-read", disk.read_bps, rate);
    bind("disk-write", disk.write_bps, rate);

    // drives
    const drives = d.drives || [];
    driveRows.forEach((row, i) => {
      const drv = drives[i] || {};
      row.querySelector(".dname").textContent = drv.label || DASH;
      bind(`drive${i}-pct`, drv.used_pct, int);
      gauge($(`drive${i}-bar`), drv.used_pct);
      const ts = ramp(drv.used_pct, RAMP.space);
      heat($(`drive${i}-bar`), ts);
      heat($(`drive${i}-pct`), ts);
      bind(`drive${i}-temp`, drv.temp, int);
      heat($(`drive${i}-temp`), ramp(drv.temp, RAMP.driveTemp));
    });

    // motherboard
    bind("mobo", d.mobo_temp, int);
    heat($("mobo-s"), ramp(d.mobo_temp, RAMP.moboTemp));
  }

  PanelFeed.subscribe(render);
})();

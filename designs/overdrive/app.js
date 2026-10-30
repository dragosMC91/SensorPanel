/* Overdrive — data binding only.
   Text readouts ease toward each 1 Hz reading on animation frames (same idea
   as the production app.js); needles, arcs and bars get registered custom
   properties (--p / --t) that CSS transitions. Heat colours, the telltale
   lamps and the trip-computer status are derived here from the production
   RAMP thresholds. Any null renders a dimmed dash and parks its needle. */

(() => {
  "use strict";

  const DASH = "–";
  const $ = (id) => document.getElementById(id);
  const clamp01 = (v) => Math.max(0, Math.min(1, v));
  const isNum = (v) => typeof v === "number" && Number.isFinite(v);

  /* ---- fit the fixed 1024x600 stage into the viewport ---- */
  function fitStage() {
    const s = Math.min(window.innerWidth / 1024, window.innerHeight / 600);
    $("stage").style.transform = `scale(${s})`;
    document.body.style.width = 1024 * s + "px";
    document.body.style.height = 600 * s + "px";
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

  function ramp(v, [cool, warm, hot]) {
    if (!isNum(v) || v <= cool) return 0;
    if (v >= hot) return 1;
    return v < warm ? (v - cool) / (warm - cool) * 0.5
                    : 0.5 + (v - warm) / (hot - warm) * 0.5;
  }

  const ACCENT = [214, 232, 255];  // ice white
  const TEXT   = [242, 244, 248];
  const WARM   = [255, 174, 40];
  const HOT    = [255, 64, 46];
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

  function gauge(el, pct, prop = "--p") {
    if (!el) return;
    const p = isNum(pct) ? Math.max(0, Math.min(100, pct)) : 0;
    el.style.setProperty(prop, p.toFixed(2));
  }

  /* lamp level from a 0..1 heat: amber once the warm stop is reached, red
     most of the way to hot */
  const level = (t) => (t >= 0.85 ? 2 : t >= 0.5 ? 1 : 0);
  function lamp(id, lv) {
    const el = $(id);
    el.classList.toggle("warm", lv === 1);
    el.classList.toggle("hot", lv === 2);
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
      b = { el, v: el.querySelector(".v"), unit: el.querySelector(".u"), cur: null, target: null };
      bindings.set(id, b);
    }
    b.fmt = fmt;
    b.target = isNum(value) ? value : null;
    dirty = true;
  }

  function setText(b, s) {
    const node = b.v || b.el;
    if (node.textContent !== s) node.textContent = s;
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
      setText(b, obj ? out.text : out);
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
  const one = (v) => v.toFixed(1);
  const loadFmt = (v) => { const t = Math.round(v).toString(); return { text: t, wide: t.length >= 3 }; };

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
  // tach numerals 0..100 every 10 %, along the 240° sweep
  document.querySelectorAll(".numerals").forEach((box) => {
    for (let n = 0; n <= 100; n += 10) {
      const s = document.createElement("span");
      s.textContent = n;
      s.style.setProperty("--a", (-120 + n * 2.4) + "deg");
      if (n >= 90) s.className = "red";
      box.appendChild(s);
    }
  });

  const drivesEl = $("drives");
  const driveRows = [];
  for (let i = 0; i < 4; i++) {
    const card = document.createElement("div");
    card.className = "drv";
    card.innerHTML =
      `<div class="dh"><b class="tag">D${i}</b><span class="dname"></span></div>` +
      `<div class="dbody">` +
        `<div class="odo-w"><span class="odo" id="drive${i}-pct"><span class="v">${DASH}</span></span>` +
        `<span class="odu"><b>%</b>used</span></div>` +
        `<span class="dtemp" id="drive${i}-temp"><i class="ico thermo"></i><span class="v">${DASH}</span><span class="u">°C</span></span>` +
      `</div>` +
      `<i class="dbar" id="drive${i}-bar"><b></b></i>`;
    drivesEl.appendChild(card);
    driveRows.push(card);
  }

  /* clock in the top bar */
  function tickClock() {
    const d = new Date();
    $("clock").textContent =
      String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
  }
  tickClock();
  setInterval(tickClock, 5000);

  /* ============================================================== render */
  function tach(side, s, maxPower, tempRamp) {
    const dial = $(side + "-dial");
    const tUse = ramp(s.usage, RAMP.load);
    const tTemp = ramp(s.temp, tempRamp);
    const tPow = isNum(s.power) ? ramp(s.power / maxPower, RAMP.power) : 0;

    bind(side + "-usage", s.usage, loadFmt);
    gauge(dial, s.usage);
    // coolant arc spans 30..100 °C
    gauge(dial, isNum(s.temp) ? (s.temp - 30) / 70 * 100 : null, "--t");
    dial.classList.toggle("na", !isNum(s.usage));
    heat(dial, Math.max(tUse, tTemp));
    $(side + "-usage").style.setProperty("--tc", rgb(warmth(TEXT, tUse)));

    bind(side + "-clock", s.clock, int);

    bind(side + "-temp", s.temp, int);
    heat($(side + "-temp-s"), tTemp);

    bind(side + "-power", s.power, int);
    gauge($(side + "-power-bar"), isNum(s.power) ? s.power / maxPower * 100 : null);
    heat($(side + "-power-s"), tPow);

    const h = Math.max(tUse, tTemp, tPow);
    dial.classList.toggle("hot", h >= 0.75);
    $("amb-" + side).style.setProperty("--hx", (h * 0.9).toFixed(3));
    return { tTemp, tPow };
  }

  function render(d) {
    const cpu = d.cpu || {}, gpu = d.gpu || {}, mem = d.mem || {},
          net = d.net || {}, disk = d.disk || {};

    const c = tach("cpu", cpu, CPU_POWER_MAX, RAMP.cpuTemp);
    const g = tach("gpu", gpu, GPU_POWER_MAX, RAMP.gpuTemp);

    // active cores, gear-indicator style
    const cores = isNum(cpu.cores) ? cpu.cores : 12;
    bind("cpu-active", cpu.active, int);
    $("cpu-active").querySelector(".u").textContent = "/" + cores;
    heat($("cpu-cores-s"), isNum(cpu.active) ? ramp(cpu.active / cores * 100, RAMP.load) : 0);

    // VRAM, fuel-gauge style
    const vramPct = isNum(gpu.vram_pct) ? gpu.vram_pct
      : isNum(gpu.vram_used_gb) && isNum(gpu.vram_total_gb) && gpu.vram_total_gb > 0
        ? gpu.vram_used_gb / gpu.vram_total_gb * 100 : null;
    bind("gpu-vram", gpu.vram_used_gb, one);
    if (isNum(gpu.vram_total_gb)) $("gpu-vram").querySelector(".u").textContent = "/" + gpu.vram_total_gb.toFixed(0);
    gauge($("gpu-vram-bar"), vramPct);
    const tVram = ramp(vramPct, RAMP.load);
    heat($("gpu-vram-s"), tVram);

    // memory
    bind("mem-pct", mem.percent, int);
    gauge($("mem-bar"), mem.percent);
    const tMem = ramp(mem.percent, RAMP.load);
    heat($("mem-s"), tMem);
    bind("mem-gb", mem.used_gb, (v) => ({
      text: v.toFixed(1),
      unit: "/ " + (isNum(mem.total_gb) ? mem.total_gb.toFixed(1) : DASH) + " GB",
    }));

    // I/O
    $("net-iface").textContent = net.iface || "";
    bind("net-down", net.down_bps, rate);
    bind("net-up", net.up_bps, rate);
    bind("disk-read", disk.read_bps, rate);
    bind("disk-write", disk.write_bps, rate);

    // board
    bind("mobo", d.mobo_temp, int);
    heat($("mobo-s"), ramp(d.mobo_temp, RAMP.moboTemp));

    // drives
    const drives = d.drives || [];
    let tSpace = 0, tDrvTemp = 0;
    driveRows.forEach((card, i) => {
      const drv = drives[i] || {};
      card.querySelector(".dname").textContent = drv.label || `drive ${i}`;
      bind(`drive${i}-pct`, drv.used_pct, int);
      gauge($(`drive${i}-bar`), drv.used_pct);
      const ts = ramp(drv.used_pct, RAMP.space);
      heat($(`drive${i}-bar`), ts);
      heat($(`drive${i}-pct`), ts);
      bind(`drive${i}-temp`, drv.temp, int);
      const tt = ramp(drv.temp, RAMP.driveTemp);
      heat($(`drive${i}-temp`), tt);
      tSpace = Math.max(tSpace, ts);
      tDrvTemp = Math.max(tDrvTemp, tt);
    });

    // telltales
    const lv = {
      "lamp-cputemp": level(c.tTemp),
      "lamp-gputemp": level(g.tTemp),
      "lamp-power":   level(Math.max(c.tPow, g.tPow)),
      "lamp-vram":    level(tVram),
      "lamp-ram":     level(tMem),
      "lamp-disk":    level(tSpace),
      "lamp-drvtemp": level(tDrvTemp),
    };
    const key = [cpu.usage, cpu.temp, gpu.usage, gpu.temp, mem.percent];
    const missing = key.filter((v) => !isNum(v)).length;
    lv["lamp-link"] = missing === key.length ? 2 : missing ? 1 : 0;
    Object.entries(lv).forEach(([id, l]) => lamp(id, l));

    // trip-computer status pill
    const levels = Object.values(lv);
    const hot = levels.filter((l) => l === 2).length;
    const warn = levels.filter((l) => l === 1).length;
    const st = $("status");
    st.classList.toggle("off", missing === key.length);
    st.classList.toggle("hot", hot > 0 && missing !== key.length);
    st.classList.toggle("warn", !hot && warn > 0);
    $("status-t").textContent =
      missing === key.length ? "No data"
      : hot ? `${hot} warning${hot > 1 ? "s" : ""}`
      : warn ? `${warn} caution${warn > 1 ? "s" : ""}`
      : "All clear";
  }

  PanelFeed.subscribe(render);
})();

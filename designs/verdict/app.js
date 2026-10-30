/* Verdict — data binding plus the verdict itself.
   Text readouts ease toward each 1 Hz reading on animation frames (same idea
   as the production app.js); bars get --p and CSS glides them. Each tile's
   severity comes from the production RAMP thresholds. The headline names the
   worst problem, the workload line names the dominant activity; both have a
   short dwell so they don't flicker at 1 Hz. Any null renders a dimmed dash. */

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
  const CPU_CLOCK_MAX = 4650, GPU_CLOCK_MAX = 2475;
  // a busy CPU/GPU is not a problem: load tiles warm to amber but never red
  const LOAD_CAP = 0.55;

  function ramp(v, [cool, warm, hot]) {
    if (!isNum(v) || v <= cool) return 0;
    if (v >= hot) return 1;
    return v < warm ? (v - cool) / (warm - cool) * 0.5
                    : 0.5 + (v - warm) / (hot - warm) * 0.5;
  }

  const GREY = [196, 204, 212], TEXT = [236, 240, 243];
  const WARM = [255, 178, 64],  WARM_T = [255, 196, 110];
  const HOT  = [255, 76, 76],   HOT_T  = [255, 150, 140];
  const mix = (a, b, t) => a.map((x, i) => Math.round(x + (b[i] - x) * t));
  const ramp3 = (a, b, c, t) => (t <= 0.5 ? mix(a, b, t * 2) : mix(b, c, (t - 0.5) * 2));
  const rgb = (c) => `rgb(${c[0]},${c[1]},${c[2]})`;

  // Below ~0.15 a tile stays grey; colour only arrives with real warmth.
  function tint(el, t) {
    if (!el) return;
    t = clamp01(t || 0);
    const k = clamp01((t - 0.15) / 0.85);
    el.style.setProperty("--c", rgb(ramp3(GREY, WARM, HOT, k)));
    el.style.setProperty("--tc", rgb(ramp3(TEXT, WARM_T, HOT_T, k)));
    el.style.setProperty("--m", (k * 26).toFixed(1) + "%");
    el.classList.toggle("warm", t >= 0.4 && t < 0.75);
    el.classList.toggle("hot", t >= 0.75);
  }

  function bar(el, pct) {
    if (!el) return;
    el.style.setProperty("--p", (isNum(pct) ? Math.max(0, Math.min(100, pct)) : 0).toFixed(2));
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

  function setText(el, s) { if (el.textContent !== s) el.textContent = s; }

  function paint(dt) {
    if (!dirty) return;
    let moving = false;
    const k = 1 - Math.exp(-dt / TAU);
    bindings.forEach((b) => {
      if (b.target === null) {
        b.cur = null;
        b.el.classList.add("na");
        b.el.classList.remove("idle");
        setText(b.v || b.el, DASH);
        return;
      }
      b.el.classList.remove("na");
      if (b.cur === null || Math.abs(b.target - b.cur) < 1e-3) b.cur = b.target;
      else { b.cur += (b.target - b.cur) * k; moving = true; }
      const out = b.fmt(b.cur);
      const obj = typeof out === "object";
      setText(b.v || b.el, obj ? out.text : out);
      if (b.unit && obj && out.unit) setText(b.unit, out.unit);
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

  /* ============================================================ formatters */
  const int = (v) => Math.round(v).toString();
  const one = (v) => v.toFixed(1);

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
  const rateStr = (v) => { const r = rate(v); return `${r.text} ${r.unit}`; };
  const gb = (v) => (v >= 100 ? v.toFixed(0) : v.toFixed(1));

  // headroom caption: hidden (empty) whenever its reading is missing
  function hr(id, text) {
    const el = $(id);
    if (el) setText(el, text || "");
  }

  /* ========================================================== static DOM */
  const driveRows = [];
  const rowsEl = $("drive-rows");
  for (let i = 0; i < 4; i++) {
    const row = document.createElement("div");
    row.className = "drive";
    row.innerHTML =
      `<span class="dname">Drive ${i + 1}</span>` +
      `<span class="dbar"><i></i></span>` +
      `<span class="dval" id="drive${i}-pct"><span class="v">${DASH}</span><span class="u">%</span></span>` +
      `<span class="dval" id="drive${i}-temp"><span class="v">${DASH}</span><span class="u">°</span></span>`;
    rowsEl.appendChild(row);
    driveRows.push(row);
  }

  function clock() {
    const d = new Date();
    setText($("clock"), `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`);
  }
  clock();
  setInterval(clock, 5000);

  /* ======================================================== verdict logic
     Every reading that can be a *problem* becomes an issue {key, t, ...}.
     Load is deliberately not an issue: a busy machine is fine. */
  function tempIssue(key, who, v, stops) {
    const t = ramp(v, stops);
    const deg = isNum(v) ? ` · ${Math.round(v)}°` : "";
    return {
      key, t,
      chip: `${who} ${isNum(v) ? Math.round(v) : ""}°C`,
      head: t >= 1 ? [`${who} throttle risk`, deg] : t >= 0.75 ? [`${who} hot`, deg] : [`${who} warm`, deg],
    };
  }
  function powerIssue(key, who, v, max) {
    const t = isNum(v) ? ramp(v / max, RAMP.power) : 0;
    return { key, t, chip: `${who} ${isNum(v) ? Math.round(v) : ""} W`,
             head: t >= 1 ? [`${who} at power limit`, ""] : [`${who} power high`, ` · ${isNum(v) ? Math.round(v) : ""} W`] };
  }

  function issues(d) {
    const cpu = d.cpu || {}, gpu = d.gpu || {}, mem = d.mem || {};
    const out = [
      tempIssue("cpu-temp", "CPU", cpu.temp, RAMP.cpuTemp),
      tempIssue("gpu-temp", "GPU", gpu.temp, RAMP.gpuTemp),
      powerIssue("cpu-power", "CPU", cpu.power, CPU_POWER_MAX),
      powerIssue("gpu-power", "GPU", gpu.power, GPU_POWER_MAX),
    ];
    if (isNum(gpu.vram_used_gb) && isNum(gpu.vram_total_gb) && gpu.vram_total_gb > 0) {
      const t = ramp(gpu.vram_used_gb / gpu.vram_total_gb * 100, RAMP.load);
      out.push({ key: "vram", t, chip: `VRAM ${gpu.vram_used_gb.toFixed(1)}/${gpu.vram_total_gb.toFixed(0)} GB`,
                 head: [t >= 1 ? "VRAM full" : "VRAM nearly full", ""] });
    }
    if (isNum(mem.percent)) {
      const t = ramp(mem.percent, RAMP.load);
      out.push({ key: "mem", t, chip: `RAM ${Math.round(mem.percent)}%`,
                 head: [t >= 1 ? "Memory full" : "Memory pressure", ` · ${Math.round(mem.percent)}%`] });
    }
    (d.drives || []).forEach((drv, i) => {
      const name = (drv.label || `Drive ${i + 1}`).toUpperCase();
      if (isNum(drv.used_pct)) {
        const t = ramp(drv.used_pct, RAMP.space);
        out.push({ key: `d${i}-space`, t, chip: `${name} ${Math.round(drv.used_pct)}% full`,
                   head: [t >= 1 ? "Drive full" : "Drive almost full", ""] });
      }
      if (isNum(drv.temp)) {
        const it = tempIssue(`d${i}-temp`, "Drive", drv.temp, RAMP.driveTemp);
        it.chip = `${name} ${Math.round(drv.temp)}°C`;
        if (it.t >= 1) it.head = ["Drive overheating", it.head[1]];
        out.push(it);
      }
    });
    out.push(Object.assign(tempIssue("mobo", "Board", d.mobo_temp, RAMP.moboTemp), {}));
    return out;
  }

  /* what the machine is doing, most specific first */
  function workload(d) {
    const cpu = d.cpu || {}, gpu = d.gpu || {}, net = d.net || {}, disk = d.disk || {};
    const c = isNum(cpu.usage) ? cpu.usage : 0;
    const g = isNum(gpu.usage) ? gpu.usage : 0;
    const io = (isNum(disk.read_bps) ? disk.read_bps : 0) + (isNum(disk.write_bps) ? disk.write_bps : 0);
    const down = isNum(net.down_bps) ? net.down_bps : 0;
    const up = isNum(net.up_bps) ? net.up_bps : 0;
    if (c >= 85 && g >= 85)  return { key: "full", text: "Full load", val: " · CPU + GPU maxed" };
    if (g >= 70 && c < 70)   return { key: "gpu",  text: "GPU-bound", val: " · gaming / render" };
    if (c >= 70 && g < 50)   return { key: "cpu",  text: "CPU-bound", val: " · compiling" };
    if (c >= 70 && g >= 50)  return { key: "both", text: "Heavy load", val: " · CPU + GPU busy" };
    if (io >= 200 * 1024 ** 2) return { key: "io", text: "Heavy disk I/O", val: () => ` · ${rateStr(liveIO())}` };
    if (down >= 5 * 1024 ** 2) return { key: "down", text: "Downloading", val: () => ` · ${rateStr(liveDown())}` };
    if (up >= 2 * 1024 ** 2)   return { key: "up", text: "Uploading", val: () => ` · ${rateStr(liveUp())}` };
    if (c >= 35 || g >= 35)  return { key: "busy", text: "Busy", val: () => ` · CPU ${Math.round(liveCpu())}% · GPU ${Math.round(liveGpu())}%` };
    if (c >= 10 || g >= 10 || io >= 20 * 1024 ** 2 || down >= 512 * 1024)
      return { key: "light", text: "Light use", val: () => ` · CPU ${Math.round(liveCpu())}% · GPU ${Math.round(liveGpu())}%` };
    return { key: "idle", text: "Idle", val: " · nothing much happening" };
  }
  // live values for workload captions that carry a number
  let latest = {};
  const liveIO = () => ((latest.disk || {}).read_bps || 0) + ((latest.disk || {}).write_bps || 0);
  const liveDown = () => (latest.net || {}).down_bps || 0;
  const liveUp = () => (latest.net || {}).up_bps || 0;
  const liveCpu = () => (latest.cpu || {}).usage || 0;
  const liveGpu = () => (latest.gpu || {}).usage || 0;

  /* dwell: once the shown label stops matching the readings it is replaced
     after HOLD readings (even if the alternative keeps changing), so labels
     never flicker at 1 Hz yet never go stale. The headline escalating to a
     more severe level is shown at once. */
  const HOLD = 3;
  const dwell = { head: { cur: null, miss: 0 }, work: { cur: null, miss: 0 } };
  function settle(slot, next, rank) {
    const s = dwell[slot];
    if (!s.cur || next.key === s.cur.key || (rank && rank(next) > rank(s.cur)) || ++s.miss >= HOLD) {
      s.cur = next; s.miss = 0;
    }
    return s.cur;
  }

  // the verdict's severity level: 0 cool, 1 warm, 2 problem, 3 hot
  const level = (t) => (t >= 0.75 ? 3 : t >= 0.45 ? 2 : t >= 0.15 ? 1 : 0);

  const BAND = { cool: [14, 66, 58], warm: [92, 62, 14], hot: [126, 22, 28], none: [34, 38, 44] };
  const ACC  = { cool: [92, 222, 186], warm: [255, 178, 64], hot: [255, 76, 76], none: [130, 140, 150] };
  const PRI = ["cpu-temp", "gpu-temp", "cpu-power", "gpu-power", "vram", "mem"];
  const pri = (k) => { const i = PRI.indexOf(k); return i < 0 ? PRI.length : i; };
  // worst level first; within a level CPU/GPU outrank memory, then the rest
  const bySeverity = (a, b) => (level(b.t) - level(a.t)) || (pri(a.key) - pri(b.key)) || (b.t - a.t);

  function renderVerdict(d, anyData) {
    const body = document.body;
    body.classList.toggle("nodata", !anyData);
    const band = $("band");
    if (!anyData) {
      setHeadline("No sensor data", "");
      setWorkload("Check the collector service", "");
      band.style.setProperty("--band", rgb(BAND.none));
      band.style.setProperty("--acc", rgb(ACC.none));
      body.classList.remove("alarm");
      renderChips([], true, 0, false);
      fitWorkload();
      dwell.head.cur = dwell.work.cur = null;
      return;
    }

    const all = issues(d).filter((x) => x.t > 0).sort(bySeverity);
    const byKey = new Map(all.map((x) => [x.key, x]));
    const worst = all[0];
    const tMax = worst ? worst.t : 0;

    // headline: every issue is a possible headline; the worst one is proposed
    const heads = new Map([["cool", { key: "cool", head: ["All cool", ""], lvl: 0 }],
                           ["warm", { key: "warm", head: ["Running warm", ""], lvl: 1 }]]);
    all.forEach((x) => heads.set(x.key, { key: x.key, head: x.head, lvl: level(x.t), covers: [x.key] }));
    // CPU and GPU both hot read as one sentence
    const ct = byKey.get("cpu-temp"), gt = byKey.get("gpu-temp");
    if (ct && gt && level(ct.t) === 3 && level(gt.t) === 3) {
      heads.set("both-temp", { key: "both-temp", lvl: 3, covers: ["cpu-temp", "gpu-temp"],
        head: ["CPU + GPU hot", ` · ${Math.round(d.cpu.temp)}° / ${Math.round(d.gpu.temp)}°`] });
    }
    const propose = tMax < 0.15 ? "cool" : tMax < 0.45 ? "warm"
                  : heads.has("both-temp") && (worst.key === "cpu-temp" || worst.key === "gpu-temp")
                  ? "both-temp" : worst.key;
    // rank by the *current* reading, so a held label refreshes its numbers
    const rank = (h) => (heads.get(h.key) || { lvl: -1 }).lvl;
    const held = settle("head", heads.get(propose), rank);
    const head = heads.get(held.key) || held;
    setHeadline(head.head[0], head.head[1]);

    // band colour follows the live worst reading, not the dwelled text
    const k = clamp01((tMax - 0.15) / 0.85);
    band.style.setProperty("--band", rgb(ramp3(BAND.cool, BAND.warm, BAND.hot, k)));
    band.style.setProperty("--acc", rgb(ramp3(ACC.cool, ACC.warm, ACC.hot, k)));
    body.classList.toggle("alarm", tMax >= 0.75);

    const work = settle("work", workload(d));
    setWorkload(work.text, typeof work.val === "function" ? work.val() : work.val);

    // chips: everything else that is warm/hot, worst level first and CPU/GPU
    // ahead of drives within a level; then shown in a fixed order. Past
    // three, the last chip becomes a "+N more" count.
    const covered = head.covers || [];
    const rest = all.filter((x) => x.t >= 0.4 && !covered.includes(x.key));
    const take = rest.length > 3 ? 2 : 3;
    const shown = rest.slice(0, take);
    const order = issues(d).map((x) => x.key);
    shown.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
    renderChips(shown, false, rest.length - take, head.key === "cool");
    fitWorkload();
  }

  function setHeadline(text, val) {
    setText($("hl-text"), text);
    setText($("hl-val"), val || "");
    fitHeadline();
  }
  function setWorkload(text, val) {
    setText($("wl-text"), text);
    setText($("wl-val"), val || "");
  }

  // the headline is sized for its longest phrase; shrink only if one overflows
  function fitHeadline() {
    const h = $("headline");
    const room = 1024 - 64;
    let size = 88;
    h.style.fontSize = size + "px";
    while (h.scrollWidth > room && size > 56) { size -= 4; h.style.fontSize = size + "px"; }
  }

  // the workload line shares its row with the chips; shrink it only when a
  // long phrase meets a full row of chips, so the two never collide
  function fitWorkload() {
    const w = $("workload");
    let size = 38;
    w.style.fontSize = size + "px";
    while (w.scrollWidth > w.clientWidth && size > 26) { size -= 2; w.style.fontSize = size + "px"; }
  }

  let chipSig = null;
  function renderChips(list, nodata, more, calm) {
    const sig = nodata ? "nodata" : list.map((x) => x.key + x.chip + (x.t >= 0.75)).join("|") + "+" + more + calm;
    if (sig === chipSig) return;
    chipSig = sig;
    const el = $("chips");
    el.textContent = "";
    if (nodata) return;
    if (!list.length) {
      if (!calm) return;
      const c = document.createElement("span");
      c.className = "chip ok";
      c.textContent = "Nothing needs attention";
      el.appendChild(c);
      return;
    }
    list.forEach((x) => {
      const c = document.createElement("span");
      c.className = "chip" + (x.t >= 0.75 ? " hot" : "");
      c.textContent = x.chip;
      el.appendChild(c);
    });
    if (more > 0) {
      const c = document.createElement("span");
      c.className = "chip more";
      c.textContent = `+${more} more`;
      el.appendChild(c);
    }
  }

  /* ============================================================== render */
  function unit(side, s, maxPower, maxClock, tempStops) {
    bind(side + "-usage", s.usage, int);
    bar($("t-" + side + "-usage"), s.usage);
    tint($("t-" + side + "-usage"), Math.min(LOAD_CAP, ramp(s.usage, RAMP.load)));
    hr(side + "-usage-hr", isNum(s.usage) ? `${Math.max(0, 100 - Math.round(s.usage))}% idle` : "");

    const limit = tempStops[2];
    bind(side + "-temp", s.temp, int);
    bar($("t-" + side + "-temp"), isNum(s.temp) ? (s.temp - 25) / (limit - 25) * 100 : null);
    tint($("t-" + side + "-temp"), ramp(s.temp, tempStops));
    hr(side + "-temp-hr", !isNum(s.temp) ? "" :
       s.temp < limit ? `${Math.round(limit - s.temp)}° left` : `${Math.round(s.temp - limit)}° over`);

    bind(side + "-power", s.power, int);
    bar($("t-" + side + "-power"), isNum(s.power) ? s.power / maxPower * 100 : null);
    tint($("t-" + side + "-power"), isNum(s.power) ? ramp(s.power / maxPower, RAMP.power) : 0);
    hr(side + "-power-hr", isNum(s.power) ? `${Math.max(0, Math.round(maxPower - s.power))} W free` : "");

    bind(side + "-clock", s.clock, int);
    bar($("t-" + side + "-clock"), isNum(s.clock) ? s.clock / maxClock * 100 : null);
    tint($("t-" + side + "-clock"), 0);
    hr(side + "-clock-hr", isNum(s.clock) ? `${Math.min(100, Math.round(s.clock / maxClock * 100))}% max` : "");
  }

  function render(d) {
    latest = d;
    const cpu = d.cpu || {}, gpu = d.gpu || {}, mem = d.mem || {},
          net = d.net || {}, disk = d.disk || {};

    unit("cpu", cpu, CPU_POWER_MAX, CPU_CLOCK_MAX, RAMP.cpuTemp);
    unit("gpu", gpu, GPU_POWER_MAX, GPU_CLOCK_MAX, RAMP.gpuTemp);

    // active cores
    const cores = isNum(cpu.cores) ? cpu.cores : 12;
    bind("cpu-active", cpu.active, (v) => ({ text: int(v), unit: "/" + cores }));
    const actPct = isNum(cpu.active) ? cpu.active / cores * 100 : null;
    bar($("t-cpu-active"), actPct);
    tint($("t-cpu-active"), 0);   // informational: all cores awake is normal
    hr("cpu-active-hr", isNum(cpu.active) ? `${Math.max(0, cores - cpu.active)} parked` : "");

    // VRAM
    const vOk = isNum(gpu.vram_used_gb) && isNum(gpu.vram_total_gb) && gpu.vram_total_gb > 0;
    const vPct = vOk ? gpu.vram_used_gb / gpu.vram_total_gb * 100 : null;
    bind("gpu-vram", vOk ? gpu.vram_used_gb : null,
         (v) => ({ text: one(v), unit: "/" + gpu.vram_total_gb.toFixed(0) + " GB" }));
    bar($("t-gpu-vram"), vPct);
    tint($("t-gpu-vram"), ramp(vPct, RAMP.load));
    hr("gpu-vram-hr", vOk ? `${Math.max(0, gpu.vram_total_gb - gpu.vram_used_gb).toFixed(1)} GB free` : "");

    // memory
    bind("mem-pct", mem.percent, int);
    bind("mem-gb", mem.used_gb, (v) => ({ text: one(v), unit: "GB" }));
    bar($("t-mem"), mem.percent);
    tint($("t-mem"), ramp(mem.percent, RAMP.load));
    hr("mem-hr", isNum(mem.used_gb) && isNum(mem.total_gb)
       ? `${gb(Math.max(0, mem.total_gb - mem.used_gb))} GB free` : "");

    // I/O
    setText($("net-iface"), net.iface || "");
    bind("net-down", net.down_bps, rate);
    bind("net-up", net.up_bps, rate);
    bind("disk-read", disk.read_bps, rate);
    bind("disk-write", disk.write_bps, rate);

    // drives
    const drives = d.drives || [];
    driveRows.forEach((row, i) => {
      const drv = drives[i] || {};
      setText(row.querySelector(".dname"), drv.label || `Drive ${i + 1}`);
      bind(`drive${i}-pct`, drv.used_pct, int);
      bind(`drive${i}-temp`, drv.temp, int);
      bar(row.querySelector(".dbar"), drv.used_pct);
      tint(row, Math.max(ramp(drv.used_pct, RAMP.space), ramp(drv.temp, RAMP.driveTemp)));
    });

    // board
    const mLimit = RAMP.moboTemp[2];
    bind("mobo", d.mobo_temp, int);
    bar($("t-mobo"), isNum(d.mobo_temp) ? (d.mobo_temp - 20) / (mLimit - 20) * 100 : null);
    tint($("t-mobo"), ramp(d.mobo_temp, RAMP.moboTemp));
    hr("mobo-hr", !isNum(d.mobo_temp) ? "" :
       d.mobo_temp < mLimit ? `${Math.round(mLimit - d.mobo_temp)}° left` : `${Math.round(d.mobo_temp - mLimit)}° over`);

    const any = [cpu.usage, cpu.temp, gpu.usage, gpu.temp, mem.percent, d.mobo_temp].some(isNum);
    renderVerdict(d, any);
  }

  PanelFeed.subscribe(render);
})();

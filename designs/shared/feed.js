/* Shared data feed for the design alternatives in designs/*.
   Same transport as the production app.js: SSE /stream, polling /metrics as a
   fallback, and a stale guard that sets body.stale after 5 s without data.

     PanelFeed.subscribe((snapshot) => { ... })   // called once per new reading
     PanelFeed.history().then((readings) => ...)   // recent past, oldest first

   A reading is delivered once: a repeat (same ts, e.g. the polling fallback
   fetching /metrics twice within one sample) is dropped, so a stalled
   collector reads as stale instead of as a frozen-but-live panel.

   ?demo=load swaps the collector for synthetic readings that sweep from idle
   to flat-out over ~40 s, so a design can be judged hot as well as calm.
   ?demo=idle pins everything near idle; ?demo=null blanks every sensor.
   &t=<ms> starts the sweep part-way in. ?demo=peak holds near flat-out (with
   jitter, so values still move) for judging hot states at leisure.

   Inside designs/index.html the live feed comes from the parent's PanelHub
   (one shared stream) instead of a connection per iframe. */

(() => {
  "use strict";

  const subs = [];
  let last = null, lastAt = 0;

  function emit(d) {
    if (!d || !d.cpu) return;
    if (last && d.ts !== undefined && d.ts === last.ts) return;   // already delivered
    last = d;
    lastAt = performance.now();
    document.body.classList.remove("stale");
    subs.forEach((fn) => { try { fn(d); } catch (e) { console.error(e); } });
  }

  setInterval(() => {
    if (!lastAt) return;
    document.body.classList.toggle("stale", performance.now() - lastAt > 5000);
  }, 1000);

  /* ------------------------------------------------------------ demo data */
  const DRIVES = [
    { label: "k sk600",     total_gb: 468.4 },
    { label: "s 850 evo",   total_gb: 468.4 },
    { label: "s 970 evo p", total_gb: 457.4 },
    { label: "s 980 evo p", total_gb: 931.5 },
  ];

  function synth(mode, t) {
    // u: 0..1 load envelope (a slow triangle wave plus jitter)
    const tri = 1 - Math.abs(((t / 20000) % 2) - 1);
    const j = () => (Math.random() - 0.5) * 0.08;
    const u = mode === "idle" ? 0.05
            : mode === "peak" ? 0.96 + j() / 2
            : Math.max(0, Math.min(1, tri + j()));
    const lerp = (a, b, k) => a + (b - a) * Math.max(0, Math.min(1, k));
    if (mode === "null") {
      return { ts: Date.now() / 1000,
        cpu: { usage: null, temp: null, power: null, clock: null },
        gpu: { usage: null, temp: null, power: null, clock: null,
               vram_used_gb: null, vram_total_gb: null, vram_pct: null },
        mem: { percent: null, used_gb: null, total_gb: null },
        net: { iface: null, up_bps: null, down_bps: null },
        disk: { read_bps: null, write_bps: null },
        drives: DRIVES.map((d) => ({ label: d.label, temp: null, used_gb: null,
                                     total_gb: null, used_pct: null })),
        mobo_temp: null };
    }
    const vramUsed = lerp(1.2, 15.4, u + j());
    const memPct = lerp(10, 93, u + j());
    const used = [lerp(4, 97, u), null, lerp(35, 81, u), lerp(8, 64, u)];
    return {
      ts: Date.now() / 1000,
      cpu: { usage: lerp(2, 100, u + j()), temp: lerp(38, 94, u), power: lerp(9, 142, u + j()),
             clock: lerp(2200, 4650, u + j()), active: Math.round(lerp(1, 12, u)), cores: 12 },
      gpu: { usage: lerp(0, 100, u + j()), temp: lerp(40, 96, u), power: lerp(8, 230, u + j()),
             clock: lerp(100, 2475, u + j()), vram_used_gb: vramUsed, vram_total_gb: 16,
             vram_pct: vramUsed / 16 * 100 },
      mem: { percent: memPct, used_gb: +(memPct / 100 * 62.7).toFixed(1), total_gb: 62.7 },
      net: { iface: "wlan0", up_bps: lerp(0, 4e6, u * u) * Math.random(),
             down_bps: lerp(200, 9.5e7, u * u) * Math.random() },
      disk: { read_bps: lerp(0, 1.8e9, u * u * u) * Math.random(),
              write_bps: lerp(0, 6e8, u * u) * Math.random() },
      drives: DRIVES.map((d, i) => ({
        label: d.label,
        temp: i === 1 ? null : lerp(29 + i * 2, 72, u),
        used_gb: used[i] === null ? null : +(used[i] / 100 * d.total_gb).toFixed(1),
        total_gb: d.total_gb,
        used_pct: used[i],
      })),
      mobo_temp: lerp(24, 61, u),
    };
  }

  /* ------------------------------------------------------------ transport */
  function hub() {
    try { return window.parent !== window ? window.parent.PanelHub : null; }
    catch (e) { return null; }   // cross-origin parent
  }

  const params = new URLSearchParams(location.search);
  const demo = params.get("demo");

  if (demo) {
    const t0 = performance.now() - (+params.get("t") || 0);
    const tick = () => emit(synth(demo, performance.now() - t0));
    tick();
    setInterval(tick, 1000);
  } else if (hub()) {
    // Framed by the comparison page: share its one stream. Chrome allows six
    // connections per host, so an EventSource per tile starves everything else.
    const off = hub().subscribe(emit);
    window.addEventListener("pagehide", off);
  } else {
    let sse = null, poll = null;
    const fetchOnce = async () => {
      try { emit(await (await fetch("/metrics", { cache: "no-store" })).json()); } catch (e) {}
    };
    const startPoll = () => { if (!poll) poll = setInterval(fetchOnce, 1000); };
    const stopPoll = () => { clearInterval(poll); poll = null; };
    const connect = () => {
      sse = new EventSource("/stream");
      sse.onopen = stopPoll;
      sse.onmessage = (ev) => { try { emit(JSON.parse(ev.data)); } catch (e) {} };
      sse.onerror = () => { sse.close(); startPoll(); setTimeout(connect, 5000); };
    };
    fetchOnce();
    connect();
  }

  /* The collector's recent readings (GET /history), oldest first, so a
     history-driven design starts with full charts instead of filling them over
     minutes. Demo feeds have no past; failures resolve to [] (the page then
     fills from live data as before). */
  function history() {
    if (demo) return Promise.resolve([]);
    return fetch("/history", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : []))
      .then((a) => (Array.isArray(a) ? a.filter((d) => d && d.cpu) : []))
      .catch(() => []);
  }

  window.PanelFeed = {
    subscribe(fn) { subs.push(fn); if (last) fn(last); },
    history,
    get last() { return last; },
    demo,
  };
})();

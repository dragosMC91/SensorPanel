---
name: validate-designs
description: Validate the sensor-panel design comparison page (designs/index.html) end to end in a real headless browser — every data mode (Live, Load sweep, Peak, Sensors missing), every tile (the production original plus each designs/* alternative), network stalls, console errors, broken images, unbound or frozen readouts, then a visual review of screenshots. Use after changing anything under designs/ or the root panel, when the user reports the comparison page misbehaving, or when asked to check/test/validate the designs page.
---

# Validate the designs comparison page

`designs/index.html` (served by the collector at
`http://localhost:8777/designs/index.html` — the bare `/designs/` URL 404s,
the collector serves no directory index) shows the production panel and the
pure-CSS alternatives side by side as scaled 1024×600 iframes. Mode buttons
switch the alternatives between live data and the synthetic feeds in
`designs/shared/feed.js` (`?demo=load`, `?demo=load&t=20000`, `?demo=null`).
The original always runs live.

Your job is to prove every tile works in every mode, and to say exactly what
doesn't. Validation is read-only: do not edit files unless the user asked you
to fix what you find, and never touch the production root files
(`index.html`, `style.css`, `app.js`, `collector.py`, `assets/`) as part of a
fix without asking.

## 1. Preconditions

```bash
curl -sf http://localhost:8777/metrics >/dev/null && echo up || systemctl --user status collector --no-pager
```

If the collector is down, tell the user and ask before starting it
(`systemctl --user start collector`); don't restart a running one.

## 2. Run the automated pass

```bash
python3 -I .claude/skills/validate-designs/validate.py --out "$SCRATCH/designs-validation"
```

Use the session scratchpad for `$SCRATCH`. It takes ~1–2 minutes. Flags:
`--wait S` (settle time per mode, default 6), `--no-tiles` (skip per-tile
shots), `--base URL`.

The script drives Chrome over DevTools in **real time** and, per mode, checks:

| Check | Catches |
|---|---|
| requests started this mode that never complete (>3 s), open EventSource count | connection-pool starvation: Chrome allows 6 HTTP/1.1 connections per host and every `EventSource` holds one forever |
| failed requests (4xx/5xx/network errors, cancellations ignored) | missing files, bad paths |
| console errors, uncaught exceptions, error log entries (page and iframes) | JS bugs |
| iframe `readyState`, 404 body, `<img>` with `naturalWidth 0` | the original's background/GIF layers not loading |
| `body.stale` set | a feed that stopped delivering |
| readouts showing a dash (`–`/`—`) — ≤6 allowed normally, ≥8 required in null mode | data never bound / nulls not rendered as missing |
| numeric text identical across a 3 s gap | frozen values (FAIL in load modes, WARN live) |
| iframe `src` carries the right `?demo=` | mode buttons not wiring through |
| document scrolls, text clipped by `overflow` | layout overflow at extreme values |
| iframe scale = frame width / 1024 | tiles not fitted |

Exit code 0 = no FAIL, 1 = failures, 2 = couldn't run. Output: a summary on
stdout, `report.json` (findings plus the raw probe per tile), and per mode a
folder with `overview.png` plus one 1024-wide `<tile>.png` per tile.

## 3. Visual review (required — the script can't judge looks)

Read every `overview.png`, and the per-tile shots for anything suspicious.
For each mode confirm:

- **Live** — the original shows its background art, all six orbs, both icons
  and the centre chip (gitignored GIFs; if `assets/*.gif` is absent locally,
  broken images there are expected — say so rather than failing it). Every
  alternative shows plausible numbers close to the original's.
- **Load sweep / Peak** — gauges visibly filled; at Peak hot values are
  unmistakably warm/red in each design, not still the calm palette.
- **Sensors missing** — dashes look deliberate (dimmed, aligned), no `NaN`,
  `undefined`, `null`, `Infinity`, empty gauges drawn as full, or collapsed layout.
- **All** — no overlapping or cut-off text, units don't collide with digits,
  each tile fills its frame (no white/blank band), nothing renders outside the
  1024×600 box.

Headless `chrome --screenshot` freezes CSS transitions and timers, so never
substitute it for the script when judging gauges — the script's shots are
taken from a page that has been running in real time.

## 4. Report

Lead with the verdict, then a mode × tile grid (✅ / ⚠️ / ❌), then each
problem with: mode, tile, what's wrong, evidence (the script line or the
screenshot path — write full absolute paths), and the likely cause if you
traced it (file:line). Mention anything you could not verify. If asked to
fix: fix, rerun the script, and re-read the screenshots before claiming it's
resolved.

## Known pitfalls in this page

- A design that opens its own `EventSource` (instead of using
  `PanelFeed` from `designs/shared/feed.js`) works standalone but starves the
  comparison page. Inside the page, `feed.js` subscribes to the parent's
  `window.PanelHub` so all alternatives share one stream; the original keeps
  its own — two persistent connections in total. Grep new designs for
  `EventSource`/`fetch(` when the network check fails.
- A new design must be added to the `DESIGNS` list in `designs/index.html`,
  or it is never validated.

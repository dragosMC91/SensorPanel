# Sensor Panel — Waveshare 7″ (CachyOS / KDE Wayland)

A hardware sensor panel rendered as an HTML page in Chrome kiosk mode on a
Waveshare 7″ 1024×600 secondary display. Recreates the old Windows
InfoPanel + HWiNFO setup with a small Python collector reading real Linux
sensors and pushing them to the browser once per second.

```
collector.py  ──JSON over SSE──▶  index.html in Chrome --kiosk
  reads sensors 1×/sec              binds values to DOM nodes
  serves /metrics + /stream         over background.png + animated GIFs
```

Everything runs on localhost. No cloud, no external calls.

## What's on this machine (auto-discovered)

| Panel field        | Source                                             | Works now |
|--------------------|----------------------------------------------------|-----------|
| CPU usage / active | `psutil` (Ryzen 9 3900X, 12c/24t)                  | ✅ |
| CPU temp           | `k10temp` → `Tctl`                                 | ✅ |
| CPU power (W)      | `zenpower` hwmon                                   | ⚠️ needs zenpower3 (AUR) |
| GPU usage/temp/power/VRAM/clock | RX 6800 `card1`: `gpu_busy_percent`, `amdgpu` hwmon, `mem_info_vram_*` | ✅ |
| Memory %           | `psutil`                                           | ✅ |
| Network up/down    | `psutil` (active iface auto-detected → `wlan0`)    | ✅ |
| NVMe 970 / 980     | `nvme` hwmon                                       | ✅ |
| SATA sk600 / SPCC  | `drivetemp` hwmon                                  | ⚠️ needs `modprobe drivetemp` |
| Mobo temp          | ASUS WMI hwmon exposes no temp sensor              | ⚠️ needs nct6775 / asus-wmi-sensors |

Anything unavailable renders as a dimmed dash — the panel never blanks or
crashes.

> **Note on drives:** the original panel labels are `k sk600`, `s 850 evo`,
> `s 970 evo p`, `s 980 evo p`. This machine has the Kingston sk600, a Samsung
> 970 EVO Plus and a Samsung 980 PRO, but **no** 850 EVO (that slot stays a
> dash, exactly as on the old panel). There is also an unlabeled `SPCC` SATA
> SSD (`sda`); to show it in place of the 850 EVO, change that slot's `match`
> to `"SPCC"` in `config.toml`.

## Quick start

> **Platform.** This was developed and tested only on **Arch Linux (CachyOS)
> with KDE Plasma 6 on Wayland**, against an AMD CPU + AMD GPU. Nothing here is
> portable by design: `setup.sh` installs packages with `pacman`, the sensor
> mapping assumes `amdgpu` / `k10temp`, and the window placement uses KDE's
> `kwriteconfig6` / KWin scripting. On another distro, desktop, or an Intel or
> NVIDIA machine, expect to do the wiring yourself — `collector.py` itself is
> just stdlib + `psutil` reading sysfs, so it's the portable part.
>
> **`setup.sh` is not a quiet installer — read it before running it.** It uses
> `sudo` to install packages, `modprobe`s `drivetemp` and writes
> `/etc/modules-load.d/drivetemp.conf`, then installs a systemd **user** service
> and a login autostart entry. Every step is listed below if you'd rather do them
> by hand. Note also that the optional motherboard-temp fix asks you to boot with
> `acpi_enforce_resources=lax`, which relaxes a kernel safety check on ACPI-owned
> I/O regions — it's a common lm-sensors workaround, but it's your call, not a
> default.

```bash
cd ~/Documents/sensor-panel
./setup.sh          # installs deps, loads drivetemp, enables the collector
                    # service, installs the KWin rule + login autostart
```

Then either open the kiosk now:

```bash
./launch-kiosk.sh   # full-screen on the Waveshare (HDMI-A-1)
```

…or just preview in a normal browser window: <http://localhost:8777/>.

To exit the kiosk: `Alt+F4`, or `pkill -f sensor-panel-chrome`.

## Files

| File | Purpose |
|------|---------|
| `collector.py`        | Reads sensors 1×/s; serves `/metrics` (JSON) and `/stream` (SSE) + static assets. Stdlib `http.server` + `psutil` only. |
| `config.toml`         | The discovered sensor→field mapping (hwmon chips, drive matches, network iface). Portable & tweakable. |
| `index.html` / `style.css` / `app.js` | 1024×600 frontend. Background layer + animated GIF layers + absolutely-positioned live text. |
| `launch-kiosk.sh`     | Opens Chrome kiosk pinned to the Waveshare. |
| `install-kwin-rule.sh`| Installs the KWin window rule (pins the kiosk to `HDMI-A-1`) **and** the containment KWin script (keeps every other window off it). |
| `kwin-script/`        | KWin script package (`sensorpanelcontain`) that moves any non-kiosk window that opens on the Waveshare back to the main screen. |
| `collector.service`   | systemd **user** unit to autostart the collector. |
| `sensor-panel-kiosk.desktop` | Plasma autostart entry for the kiosk. |
| `setup.sh`            | One-shot installer for all of the above. |

## Assets

Only `assets/background.png` — my own Canva layout, already updated to show
**VRAM** instead of FPS — ships with this repo. The five animated GIF layers are
third-party art I didn't create, so they're **not redistributed here** and are
gitignored. The panel runs fine without them: you just get the background plus
the live readouts, with broken-image slots where the animations would sit.

To restore the full look, drop your own GIFs into `assets/` at roughly these
sizes (they're scaled by the `CALIBRATION` block in `style.css`, so exact
dimensions aren't critical — aspect ratio is):

| File | Size | Role |
|------|------|------|
| `circle.gif` | 540×540 | the six gauge spheres (usage / power / temp, CPU + GPU) |
| `center.gif`  | 500×500 | the chip tunnel in the middle of the board |
| `cpu.gif`     | 245×246 | CPU cooler icon, next to "CPU STATS" |
| `gpu.gif`     | 270×80  | graphics-card icon, next to "GPU STATS" |
| `shard.gif`   | 468×468 | the magenta bursts in the four corners |

The demo screenshot `real-panel-screenshot.jpeg` lives in `docs/`.

## Enabling the ⚠️ sensors

**CPU power** — needs the zenpower3 driver, **and** `k10temp` must be
blacklisted or zenpower can't bind (they fight over the same CPU SMU device;
installing zenpower alone does nothing — `sensors` won't show it and no
`zenpower` hwmon appears). zenpower then provides both power *and* temperature.

```bash
paru -S zenpower3-dkms
# stop k10temp from grabbing the device, and load zenpower at boot:
echo 'blacklist k10temp' | sudo tee /etc/modprobe.d/zenpower.conf
echo 'zenpower'          | sudo tee /etc/modules-load.d/zenpower.conf
# apply now without a reboot:
sudo modprobe -r k10temp && sudo modprobe zenpower
sensors | grep -iA4 zenpower        # confirm power1 (SVI2_P_Core) shows up
```
`config.toml` already lists both drivers (`cpu.temp_hwmon = ["k10temp",
"zenpower"]`, `cpu.power_hwmon = ["zenpower"]`), so temp keeps working and
power lights up once zenpower is bound. Restart the collector afterward.

**SATA drive temps** — `setup.sh` loads `drivetemp` and persists it via
`/etc/modules-load.d/drivetemp.conf`. Manually:
```bash
sudo modprobe drivetemp
```

**Motherboard temp** — this board (TUF GAMING X570-PLUS) carries no temp in its
WMI hwmon, and it is **not** supported by `asus-ec-sensors`. Use the in-kernel
Nuvoton driver instead (no AUR needed):
```bash
sudo modprobe nct6775
sensors -j | grep -A6 nct        # look for an nct6798 chip + its labels
```
`modprobe` only loads the driver for the current boot, so the temp disappears
after a restart. Make it load on every boot:
```bash
echo nct6775 | sudo tee /etc/modules-load.d/nct6775.conf
```
If no `nct6798` chip appears, the ACPI has reserved the Super-I/O ports — add
the kernel arg `acpi_enforce_resources=lax` and reboot (systemd-boot: the
`options` line in `/boot/loader/entries/*.conf`; GRUB: `GRUB_CMDLINE_LINUX_DEFAULT`
then `sudo grub-mkconfig -o /boot/grub/grub.cfg`). Then set
`mobo.temp_hwmon = "nct6798"` and `mobo.temp_label` (e.g. `"SYSTIN"`) in
`config.toml`.

## Re-discovering on a different machine

The mapping in `config.toml` is specific to this box. On new hardware:
```bash
sensors -j                                    # all lm-sensors chips + labels
ls /sys/class/drm/card*/device/gpu_busy_percent
for f in /sys/class/hwmon/*/name; do echo "$f -> $(cat $f)"; done
lsblk -d -o NAME,MODEL,TRAN                    # drive models
```
Edit `config.toml` to match, then restart the collector.

## Display / kiosk positioning (KDE Wayland)

The Waveshare enumerates as **`HDMI-A-1`**, native mode **1024×600@59.85**,
positioned to the right of the main display. On Wayland an app can't place its
own window, so `install-kwin-rule.sh` sets up **two** things:

1. **A KWin window rule** (`sensor-panel-kiosk`) that pins the kiosk to
   `HDMI-A-1`, fullscreen + borderless + kept-above, reading the live geometry
   from `kscreen-doctor --json`. It matches by **forcing the window position**
   (see the app-id note below) — the rule's *force-screen* property is inert for
   Wayland clients on KWin 6.x, so position is what actually pins it.

2. **A KWin script** (`sensorpanelcontain`, from `kwin-script/`) that keeps every
   *other* window off the Waveshare. New windows tend to open on the "active
   screen", and the fullscreen kiosk makes the Waveshare active — so session
   restore, a browser's "make me default" popup, stray dialogs, etc. would
   otherwise pile onto the panel. The script listens for windows opening on
   `HDMI-A-1` and, unless it's the kiosk, moves them back to the main screen
   via `workspace.sendClientToScreen()` (which works where the rule can't).

> **App-id gotcha (important).** Under `--ozone-platform=wayland`, Chrome
> **ignores `--class=sensorpanel`** for the Wayland app-id. A
> `--app=http://localhost:8777/` kiosk reports its app-id (KWin `resourceClass`)
> as **`chrome-localhost__-Default`**, *not* `sensorpanel`. Both the rule and the
> script therefore match the kiosk by the stable substring **`chrome-localhost`**
> (override with `PANEL_APP_MATCH=…` when running `install-kwin-rule.sh`). The
> `--class=sensorpanel` flag in `launch-kiosk.sh` is kept only for the XWayland
> fallback.

If the window opens on the wrong screen:

1. Confirm the app-id KWin sees — run this and click the panel window:
   ```bash
   qdbus6 org.kde.KWin /KWin org.kde.KWin.queryWindowInfo
   ```
   If `resourceClass` doesn't start with `chrome-localhost`, re-run
   `PANEL_APP_MATCH=<prefix> ./install-kwin-rule.sh`, or edit the rule in
   *System Settings → Window Management → Window Rules*.
2. Check the containment script is enabled and loaded:
   ```bash
   qdbus6 org.kde.KWin /Scripting org.kde.kwin.Scripting.isScriptLoaded sensorpanelcontain
   kreadconfig6 --file kwinrc --group Plugins --key sensorpanelcontainEnabled
   ```
   Both should say `true`. Re-run `./install-kwin-rule.sh` to reinstall.
3. Or use the **XWayland pixel-positioning fallback** documented at the bottom
   of `launch-kiosk.sh` (positions by the Waveshare's `2048,0` offset).

> **Calibrating the live tuner?** The tuner (below) needs keyboard focus on the
> kiosk window. If a keypress ever seems to go nowhere, click the panel once.
> The containment script never touches the kiosk itself, so focusing it is fine.

The page hides the cursor (`cursor:none`) and never scrolls. Note the two
displays only share the top **600 px** of their edge (the main screen is taller),
so the mouse can only cross onto the Waveshare in that top band.

### Font

The panel renders in **DejaVu Sans** (installed by default on most Linux
distros). It's set as the first entry in the `--font` stack in `style.css`.
When editing any text that's baked into `background.png`, use **DejaVu Sans**
so the artwork and the live readouts match. To swap in a custom font, add an
`@font-face` in `style.css` and move it to the front of the `--font` stack.

### Colour, motion and thresholds

The panel is not just a text dump — a few behaviours are driven from the data:

- **Heat colour.** Every reading drifts from the panel cyan through amber to red
  as it approaches its limit. The ramps live in the `RAMP` table at the top of
  `app.js`, each as `[cool, warm, hot]` in that metric's own units
  (`cpuTemp: [58, 78, 92]` = plain cyan at 58 °C, full amber at 78, red at 92).
  Edit those numbers to match your own comfort levels; `CPU_POWER_MAX` /
  `GPU_POWER_MAX` next to them scale the power orbs.
- **Reactive orbs.** Each GIF sphere brightens with its metric's load and its
  magenta shifts toward red with heat. `app.js` only sets `--lvl` and `--heat`
  (both 0–1) per orb; the actual mapping is the `.sphere` rule in `style.css`,
  so how strong the effect looks is a stylesheet tweak.
- **Eased numbers.** Readings arrive once a second; readouts ease toward the new
  value on an animation frame instead of snapping. `TAU` in `app.js` sets how
  quickly (lower = snappier).
- **Auto-scaled rates.** Network and disk I/O pick their own unit (B/s → KB/s →
  MB/s → GB/s), so ordinary traffic no longer reads as a permanent `0.0 MB/s`.
  A genuinely idle rate is dimmed rather than shown at full brightness.
- **Stale guard.** If no reading arrives for 5 s the whole stage dims behind a
  veil and the status pill turns red, so a frozen snapshot is never mistaken
  for live data.

### Calibrating the layout

The background art carries all labels and gauge rings; everything on top is
absolutely positioned by percentage coordinates in the `CALIBRATION` block of
`style.css`. You can edit those values by hand, move the art in your Canva
template — or use the built-in **live tuner** in the running page.

### Live tuner

Keys (click the page once so it has focus):

| Key | Action |
|-----|--------|
| **`c`** | toggle calibrate mode — a green HUD appears top-left |
| **`g`** | toggle a 5% grid + centre line |
| **`Tab`** | select the next element (Shift+Tab = previous); pink outline = selected |
| **arrows** | move the selected element (hold **Shift** for bigger steps) |
| **`+` / `-`** | resize the selected sphere / icon |
| **`p`** | dump every element's current `left/top/width` to the console as pasteable CSS |

**Important — the tuner does NOT edit `style.css`.** It only sets inline styles
on the live page, so every change is **lost on reload**. It's a scratch pad for
finding the right numbers. To make them permanent:

1. Tune everything, then press **`p`**.
2. Open the browser console (F12 → Console) and copy the printed CSS block —
   each element is labeled with its real selector (`#cpu-usage { … }`,
   `.sphere.cpu-usage-orb { … }`, …).
3. Paste those lines into the matching rules in `style.css` (or hand them to
   Claude to bake in). They survive reloads once they're in the file.

Note: **each gauge is two separate elements** — the animated sphere
(`.sphere.*-orb`) and the number on top (`#cpu-usage`, etc.). Moving the sphere
does not move its number; align both, or align the spheres and snap each number
to its sphere's centre afterward.

The files are served with cache-busting (`?v=` on the CSS/JS links in
`index.html`), so a normal reload always pulls the latest. If a console dump
ever looks stale, hard-reload once with **Ctrl+Shift+R**.

## Verifying under load

```bash
curl -s localhost:8777/metrics | python3 -m json.tool   # real values, nulls only for ⚠️ items
stress-ng --cpu 0 --timeout 20s        # CPU % / temp move (power too if zenpower installed)
vkcube   # or glxgears / any game      # GPU usage / clock / temp / power move
dd if=/dev/zero of=~/big.tmp bs=1M count=4096 oflag=direct && rm ~/big.tmp   # drive + I/O
```
Watch the panel (or `curl .../metrics`) reflect the changes within ~1 s.

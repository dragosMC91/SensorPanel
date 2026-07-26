# Making the demo GIF

How `docs/demo.gif` gets made on this machine (CachyOS, KDE Plasma 6, Wayland).

`wf-recorder` and `wl-screenrec` don't work here — they need wlroots
screencopy, which KWin doesn't implement. Spectacle records through KWin's
PipeWire screencast instead and ships with Plasma, so there's nothing to
install beyond the GIF tooling.

```bash
sudo pacman -S ffmpeg gifsicle    # gifski optional, see step 3b
```

## 1. Record the panel

Start the collector first, or the panel renders as dashes:

```bash
systemctl --user start collector
```

Then:

```bash
spectacle -R s        # -R s = whole screen, -R r = drag a region, -R w = one window
```

Pick the Waveshare (`HDMI-A-1`, 1024×600 at offset 2048,0) in the picker, then
**stop the recording with Spectacle's Stop button or its tray icon.** The file
lands in `~/Videos/Screencasts/`.

> Do **not** stop it with `pkill` / `timeout` / Ctrl+C. The VP9 encoder runs
> behind real time and killing the process throws away its buffered tail — a
> 7-second recording came out as 2.2 seconds of video. The frames it keeps are
> correctly timed, so the Stop button gives you the whole clip.

Record **8–12 seconds**, not more. Length is the single biggest factor in the
final file size, and the panel only updates once per second — there's nothing
to see in second 20 that wasn't in second 8.

## 2. Trim (if the recording is longer)

`-ss` skips to a start point, `-t` sets how much to keep:

```bash
V=~/Videos/Screencasts/Screencast_YYYYMMDD_HHMMSS.webm
ffmpeg -ss 3 -t 10 -i "$V" -c copy /tmp/clip.webm
```

## 3a. Convert with ffmpeg (two-pass palette)

One pass builds an optimal 256-colour palette for the clip, the second applies
it. Doing it in one pass instead gives you a visibly muddier GIF.

```bash
V=/tmp/clip.webm

ffmpeg -i "$V" -vf "fps=12,scale=800:-1:flags=lanczos,palettegen=max_colors=256:stats_mode=diff" \
  -y /tmp/pal.png

ffmpeg -i "$V" -i /tmp/pal.png \
  -lavfi "fps=12,scale=800:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=sierra2_4a:diff_mode=rectangle" \
  -loop 0 -y docs/demo.gif
```

`fps=12` is plenty — the collector pushes once per second, so the frame rate
only matters for the decorative GIFs. `scale=800:-1` sets the width and derives
the height; `-loop 0` means loop forever.

## 3b. Convert with gifski instead (better on the dark panel)

ffmpeg picks **one** palette for the whole clip. gifski picks a fresh one per
frame, which handles the panel's gradients and neon edges noticeably better.
It doesn't read video, only PNGs, so it's two steps:

```bash
mkdir -p /tmp/frames

# ffmpeg writes one PNG per frame: /tmp/frames/f_00001.png, f_00002.png, …
# (%05d is just the zero-padded counter in the filename)
ffmpeg -i /tmp/clip.webm -vf "fps=12,scale=800:-1:flags=lanczos" /tmp/frames/f_%05d.png

# gifski reads them back in filename order and builds the GIF
gifski --fps 12 --quality 90 -o docs/demo.gif /tmp/frames/f_*.png

rm -rf /tmp/frames
```

`--quality` (1–100) is the size/quality dial — 80 is usually indistinguishable
from 90 and meaningfully smaller.

## 4. Shrink it

```bash
gifsicle -O3 --lossy=60 --careful -b docs/demo.gif    # -b edits in place
```

Typically takes 30–50% off. Raise `--lossy` to 100 or 150 if you need more;
it starts showing as speckle in flat dark areas.

## 5. Size targets

Keep it **under 5 MB**, ideally 2–3 MB. It's committed to the repo, so it's in
the git history forever, and GitHub gets slow to render past ~10 MB.

This panel is an awkward case for GIF: `circle.gif`, `center.gif` and the four
corner `shard.gif` bursts animate across the whole frame, so there are almost
no static pixels for GIF's inter-frame compression to skip. Nearly every frame
costs a full frame. A first attempt at 800×473, 12 fps, 8.3 s came out at
11.3 MB — about 113 KB per frame.

Because the cost is per frame, trimming seconds barely helps. Make each frame
cheaper instead, in this order:

| Lever | Change | Roughly |
|-------|--------|---------|
| Width | `scale=800` → `scale=640` | 1.6× smaller |
| Palette | `max_colors=256` → `128` | 1.3× smaller |
| Frame rate | `fps=12` → `fps=10` | 1.2× smaller |
| gifsicle | `--lossy=60` → `--lossy=120` | 1.3–1.5× smaller |

All four together took that 11.3 MB down to roughly 2.5 MB. Watch the palette
one — check the gauge spheres' gradients don't band, and go back to 256 if they
do. With `--lossy`, the first thing to break down is the flat black background,
which picks up a faint speckle.

Capturing the Waveshare's native 1024×600 rather than a large desktop region
also helps: scaling 1024→800 throws away far less detail than 2315→800, so
it's both sharper and smaller.

## 6. Embed it

```markdown
![Sensor panel in action](docs/demo.gif)
```

Relative paths work on GitHub. Use `<img src="docs/demo.gif" width="800">` if
you want to pin the display size.

> A GIF is the only thing that autoplays inline in a README. If you don't need
> that, dragging the `.webm` straight into the GitHub README editor or an issue
> comment gives you a real video player — no 256-colour banding, far smaller,
> and it isn't stored in the repo.

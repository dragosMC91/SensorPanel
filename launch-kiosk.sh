#!/usr/bin/env bash
# Launch the sensor panel in Google Chrome kiosk mode, pinned to the Waveshare
# display.  Positioning on KDE Wayland is handled by a KWin window rule (see
# install-kwin-rule.sh) that matches this window's app-id and forces it
# fullscreen on the right output.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Default page is the Pulse design; PANEL_URL=http://localhost:8777/ brings back
# the original panel, or point it at any other designs/<name>/index.html.
URL="${PANEL_URL:-http://localhost:8777/designs/pulse/index.html}"
ORIGIN="${URL%%://*}://$(rest="${URL#*://}"; echo "${rest%%/*}")"   # scheme://host:port
APP_ID="${PANEL_APP_ID:-sensorpanel}"          # must match the KWin rule
PROFILE="${PANEL_PROFILE:-$HOME/.local/share/sensor-panel-chrome}"

CHROME="$(command -v google-chrome-stable || command -v chromium || command -v chromium-browser || true)"
[ -n "$CHROME" ] || { echo "No Chrome/Chromium found." >&2; exit 1; }

# Make sure the KWin rule + containment script exist so the window lands on the
# Waveshare and nothing else does.
if ! grep -q "sensor-panel-kiosk" "$HOME/.config/kwinrulesrc" 2>/dev/null \
   || [ ! -d "$HOME/.local/share/kwin/scripts/sensorpanelcontain" ]; then
  echo "[kiosk] installing KWin placement rule + containment script…"
  "$HERE/install-kwin-rule.sh" || echo "[kiosk] rule install failed; window may open on the wrong screen"
fi

# Wait for the collector to answer before opening the page.
echo "[kiosk] waiting for collector at $ORIGIN …"
for _ in $(seq 1 60); do
  if curl -sf "$ORIGIN/metrics" >/dev/null 2>&1; then break; fi
  sleep 0.5
done

mkdir -p "$PROFILE"

exec "$CHROME" \
  --ozone-platform=wayland \
  --class="$APP_ID" \
  --user-data-dir="$PROFILE" \
  --app="$URL" \
  --kiosk \
  --start-fullscreen \
  --no-first-run \
  --no-default-browser-check \
  --disable-session-crashed-bubble \
  --disable-infobars \
  --noerrdialogs \
  --hide-crash-restore-bubble \
  --disable-features=TranslateUI,Translate,MediaRouter,OptimizationHints \
  --disable-extensions \
  --disable-component-extensions-with-background-pages \
  --disable-background-networking \
  --disable-sync \
  --autoplay-policy=no-user-gesture-required \
  --check-for-update-interval=31536000 \
  --overscroll-history-navigation=0

# --------------------------------------------------------------------------- #
# X11 / XWayland fallback (if the Wayland app-id rule doesn't catch the window)
# Comment out the exec above and use this instead — it positions by pixel using
# the Waveshare's offset from `kscreen-doctor --json` (currently 2048,0):
#
#   exec "$CHROME" --class="$APP_ID" --user-data-dir="$PROFILE" --app="$URL" \
#     --window-position=2048,0 --window-size=1024,600 --start-fullscreen \
#     --no-first-run --disable-infobars --noerrdialogs
# --------------------------------------------------------------------------- #

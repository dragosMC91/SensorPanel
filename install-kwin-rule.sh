#!/usr/bin/env bash
# Set up window placement for the sensor-panel kiosk on KDE Plasma 6 (Wayland).
# Two pieces, because Wayland needs both:
#
#   1. A KWin window rule (sensor-panel-kiosk) that pins the kiosk to the
#      Waveshare output, fullscreen + borderless + kept-above, by forcing its
#      POSITION (the "force screen" rule property is inert on Wayland).
#
#   2. A KWin script (sensorpanelcontain) that keeps every OTHER window off the
#      Waveshare — session-restore windows, a browser's "make me default"
#      popup, stray dialogs — by moving them back to the main screen. A rule
#      can't do this on KWin 6.x/Wayland (force-screen doesn't relocate
#      windows); scripting's sendClientToScreen() can.
#
# WAYLAND APP-ID NOTE: Chrome ignores `--class=` for the Wayland app-id under
# `--ozone-platform=wayland`. A `--app=http://localhost:8777/` kiosk reports its
# app-id (KWin resourceClass) as `chrome-localhost__-Default`, NOT `sensorpanel`.
# So both pieces match the kiosk by the substring `chrome-localhost`. Confirm
# the live value with:  qdbus6 org.kde.KWin /KWin queryWindowInfo
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

OUTPUT="${PANEL_OUTPUT:-HDMI-A-1}"                  # Waveshare output name
PANEL_MATCH="${PANEL_APP_MATCH:-chrome-localhost}"  # kiosk app-id prefix
RULES="$HOME/.config/kwinrulesrc"
GROUP_KIOSK="sensor-panel-kiosk"
OLD_CONTAIN_GROUP="sensor-panel-contain"            # retired rule (see note above)
SCRIPT_ID="sensorpanelcontain"
SCRIPT_SRC="$HERE/kwin-script"
SCRIPT_DEST="$HOME/.local/share/kwin/scripts/$SCRIPT_ID"

command -v kwriteconfig6 >/dev/null || { echo "kwriteconfig6 not found (KDE Plasma 6 required)"; exit 1; }

# --- Discover the Waveshare geometry (falls back to 1024x600 @ 2048,0) -------
read -r X Y W H < <(kscreen-doctor --json 2>/dev/null | python3 - "$OUTPUT" <<'PY'
import json, sys
name = sys.argv[1]
try:
    outs = json.load(sys.stdin).get("outputs", [])
except Exception:
    outs = []
for o in outs:
    if o.get("name") == name and o.get("enabled"):
        p, s = o.get("pos", {}), o.get("size", {})
        print(p.get("x", 2048), p.get("y", 0), s.get("width", 1024), s.get("height", 600))
        break
else:
    print(2048, 0, 1024, 600)
PY
)
echo "[kwin] Waveshare '$OUTPUT' @ ${X},${Y} ${W}x${H}; kiosk match '$PANEL_MATCH'"

[ -f "$RULES" ] && cp -f "$RULES" "$RULES.bak.$(date +%s 2>/dev/null || echo backup)"

# --- Rule: pin the kiosk to the Waveshare -----------------------------------
# Merge our group into rules= without dropping others; drop the retired
# containment rule if a previous version installed it. (Python keeps this
# set -e-safe — a grep that filters everything out would abort the script.)
existing="$(kreadconfig6 --file kwinrulesrc --group General --key rules 2>/dev/null || true)"
newrules="$(python3 - "$existing" "$GROUP_KIOSK" "$OLD_CONTAIN_GROUP" <<'PY'
import sys
existing, kiosk, old = sys.argv[1], sys.argv[2], sys.argv[3]
keep = [g for g in existing.split(",") if g and g not in (kiosk, old)]
keep.append(kiosk)
print(",".join(keep))
PY
)"
kwriteconfig6 --file kwinrulesrc --group General --key rules "$newrules"
kwriteconfig6 --file kwinrulesrc --group General --key count \
  "$(printf '%s' "$newrules" | tr ',' '\n' | grep -c . || true)"
# Remove the retired containment rule group entirely (replaced by the script).
kwriteconfig6 --file kwinrulesrc --group "$OLD_CONTAIN_GROUP" --delete 2>/dev/null || true

set_rule() { kwriteconfig6 --file kwinrulesrc --group "$GROUP_KIOSK" --key "$1" "$2"; }
set_rule Description   "Sensor Panel Kiosk"
set_rule wmclass       "$PANEL_MATCH"
set_rule wmclasscomplete false
set_rule wmclassmatch  2                     # 2 = substring
set_rule types         1                     # normal windows
set_rule position      "$X,$Y";  set_rule positionrule    2   # 2 = force (works on Wayland)
set_rule size          "$W,$H";  set_rule sizerule        2
set_rule fullscreen    true;     set_rule fullscreenrule  2
set_rule noborder      true;     set_rule noborderrule    2
set_rule above         true;     set_rule aboverule       2
set_rule skiptaskbar   true;     set_rule skiptaskbarrule 2
# Drop the inert force-screen keys if an earlier version wrote them (the screen
# rule does nothing on Wayland; placement is by position + the script).
kwriteconfig6 --file kwinrulesrc --group "$GROUP_KIOSK" --key screen     --delete 2>/dev/null || true
kwriteconfig6 --file kwinrulesrc --group "$GROUP_KIOSK" --key screenrule --delete 2>/dev/null || true

# --- KWin script: keep other windows off the Waveshare ----------------------
echo "[kwin] installing containment script -> $SCRIPT_DEST"
rm -rf "$SCRIPT_DEST"
mkdir -p "$SCRIPT_DEST/contents/code"
cp -f "$SCRIPT_SRC/metadata.json" "$SCRIPT_DEST/metadata.json"
sed -e "s/@PANEL_OUTPUT@/$OUTPUT/g" -e "s/@PANEL_MATCH@/$PANEL_MATCH/g" \
    "$SCRIPT_SRC/contents/code/main.js" > "$SCRIPT_DEST/contents/code/main.js"

# Enable it so it auto-loads on every login…
kwriteconfig6 --file kwinrc --group Plugins --key "${SCRIPT_ID}Enabled" true
# …and load it into the running session now (idempotent: unload first).
qdbus6 org.kde.KWin /Scripting org.kde.kwin.Scripting.unloadScript "$SCRIPT_ID" >/dev/null 2>&1 || true
qdbus6 org.kde.KWin /Scripting org.kde.kwin.Scripting.loadScript \
  "$SCRIPT_DEST/contents/code/main.js" "$SCRIPT_ID" >/dev/null 2>&1 || true
qdbus6 org.kde.KWin /Scripting org.kde.kwin.Scripting.start >/dev/null 2>&1 || true

# Reload KWin config so the window rule takes effect now.
dbus-send --session --type=method_call --dest=org.kde.KWin /KWin org.kde.KWin.reconfigure 2>/dev/null || true
echo "[kwin] done: kiosk pinned to $OUTPUT; all other windows kept on the main screen."

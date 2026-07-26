#!/usr/bin/env bash
# One-shot setup for the sensor panel on CachyOS / Arch + KDE Plasma (Wayland).
# Safe to re-run.  Steps that need root will prompt for sudo.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

say() { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }

say "1/6  Checking base packages"
need_pkg=()
command -v sensors        >/dev/null || need_pkg+=(lm_sensors)
command -v smartctl       >/dev/null || need_pkg+=(smartmontools)
python3 -c 'import psutil' 2>/dev/null || need_pkg+=(python-psutil)
command -v curl           >/dev/null || need_pkg+=(curl)
if ((${#need_pkg[@]})); then
  echo "Installing: ${need_pkg[*]}"
  sudo pacman -S --needed --noconfirm "${need_pkg[@]}"
else
  echo "All base packages present."
fi
echo "Tip: run 'sudo sensors-detect --auto' once if you haven't, then reboot."

say "2/6  Loading drivetemp (SATA drive temperatures: Kingston sk600, etc.)"
if ! lsmod | grep -q '^drivetemp'; then
  sudo modprobe drivetemp && echo "drivetemp loaded."
fi
echo "drivetemp" | sudo tee /etc/modules-load.d/drivetemp.conf >/dev/null
echo "Persisted drivetemp to /etc/modules-load.d/drivetemp.conf"

say "3/6  Optional sensors that need extra drivers (currently show a dash)"
cat <<'EOF'
  * CPU power (W): only zenpower exposes it, and k10temp must be blacklisted
      first (they fight over the CPU SMU; zenpower alone registers nothing):
          paru -S zenpower3-dkms
          echo 'blacklist k10temp' | sudo tee /etc/modprobe.d/zenpower.conf
          echo 'zenpower'          | sudo tee /etc/modules-load.d/zenpower.conf
          sudo modprobe -r k10temp && sudo modprobe zenpower
      zenpower then provides power AND temp; config.toml already falls back
      across both drivers, so nothing else to change.

  * Motherboard temp: this TUF X570-PLUS has no temp in its WMI hwmon and is
      NOT supported by asus-ec-sensors. Use the in-kernel Nuvoton driver:
          sudo modprobe nct6775
      If `sensors -j` shows no nct6798 chip, add kernel arg
      acpi_enforce_resources=lax and reboot. Then set mobo.temp_hwmon
      (e.g. "nct6798") and mobo.temp_label (e.g. "SYSTIN") in config.toml.
EOF

say "4/6  Installing the collector as a systemd --user service"
mkdir -p "$HOME/.config/systemd/user"
cp -f "$HERE/collector.service" "$HOME/.config/systemd/user/collector.service"
systemctl --user daemon-reload
systemctl --user enable --now collector.service
sleep 2
if curl -sf http://localhost:8777/metrics >/dev/null; then
  echo "Collector is up:  http://localhost:8777/metrics"
else
  echo "Collector not responding yet — check: journalctl --user -u collector.service -e"
fi

say "5/6  Installing the KWin placement rule + containment script for the Waveshare"
"$HERE/install-kwin-rule.sh" || echo "(skipped/failed — see install-kwin-rule.sh)"

say "6/6  Enabling the kiosk on login"
mkdir -p "$HOME/.config/autostart"
# Bake this checkout's path into Exec= (desktop entries don't expand ~ / $HOME).
sed "s|@PANEL_DIR@|$HERE|g" "$HERE/sensor-panel-kiosk.desktop" \
  > "$HOME/.config/autostart/sensor-panel-kiosk.desktop"
echo "Autostart entry installed (Exec=$HERE/launch-kiosk.sh)."

say "Done"
cat <<EOF
Start the kiosk now without logging out:
    $HERE/launch-kiosk.sh
It will open full-screen on the Waveshare (HDMI-A-1).
Preview in a normal window instead:  open http://localhost:8777/ in a browser.
EOF

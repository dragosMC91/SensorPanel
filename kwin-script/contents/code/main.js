// Sensor Panel Containment — KWin script (KDE Plasma 6 / Wayland)
//
// Keeps the Waveshare display exclusive to the sensor-panel kiosk. Whenever any
// OTHER window opens on the panel output (session restore, a browser's
// "make me default" popup, a stray dialog, …) it is immediately moved back to
// the main screen.
//
// Why a script and not a KWin window rule? On KWin 6.x/Wayland the rule
// "force screen" property is inert for Wayland clients — it does not relocate
// the window. Scripting's workspace.sendClientToScreen() does work, so the
// containment logic lives here. (The kiosk itself is still pinned to the
// Waveshare by a position-force window rule; see install-kwin-rule.sh.)
//
// @PANEL_OUTPUT@ / @PANEL_MATCH@ are substituted at install time by
// install-kwin-rule.sh (defaults: HDMI-A-1 / chrome-localhost).

var PANEL_OUTPUT = "@PANEL_OUTPUT@"; // the Waveshare output name (kscreen-doctor)
var PANEL_MATCH  = "@PANEL_MATCH@";  // app-id prefix of the kiosk window

// The kiosk is the only window allowed on the panel output. Chrome's Wayland
// app-id for `--app=http://localhost:.../` is `chrome-localhost__-<profile>`,
// so we match by the leading substring rather than the ignored `--class`.
function isPanel(w) {
    return w.resourceClass && w.resourceClass.indexOf(PANEL_MATCH) === 0;
}

// The screen to banish stray windows to: the first output that is NOT the
// panel. Falls back to the only screen if the Waveshare is unplugged.
function mainOutput() {
    var outs = workspace.screens;
    for (var i = 0; i < outs.length; i++) {
        if (outs[i].name !== PANEL_OUTPUT) return outs[i];
    }
    return outs.length ? outs[0] : null;
}

function contain(w) {
    if (!w || isPanel(w)) return;
    if (!w.normalWindow && !w.dialog) return;   // leave docks/OSDs/menus alone
    var out = w.output;
    if (!out || out.name !== PANEL_OUTPUT) return;   // already off the panel

    var main = mainOutput();
    if (!main || main === out) return;

    try {
        workspace.sendClientToScreen(w, main);
    } catch (e) {
        // Fallback: translate the window into the main screen and centre it.
        var mg = main.geometry, g = w.frameGeometry;
        g.x = mg.x + Math.max(0, Math.floor((mg.width  - g.width)  / 2));
        g.y = mg.y + Math.max(0, Math.floor((mg.height - g.height) / 2));
        w.frameGeometry = g;
    }
}

workspace.windowAdded.connect(contain);

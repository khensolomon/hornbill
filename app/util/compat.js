import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';
import Mtk from 'gi://Mtk';
import * as Config from 'resource:///org/gnome/shell/misc/config.js';

// GNOME 49 dropped the MetaMaximizeFlags argument from maximize()/unmaximize().
// The enum can linger in the typelib on 49+, so an `!== undefined` check is
// unreliable (it still passes and then warns "too many arguments"). Gate on the
// shell major version, with the enum-absent case kept as an extra signal.
const SHELL_MAJOR = parseInt((Config.PACKAGE_VERSION || '0').split('.')[0], 10) || 0;
const MAXIMIZE_IS_FLAGLESS = Meta.MaximizeFlags === undefined || SHELL_MAJOR >= 49;

/**
 * Compatibility helpers.
 *
 * Every API that behaves differently across supported GNOME versions
 * (46–51) lives here, so a new GNOME release means updating ONE file
 * instead of hunting through every component.
 */

/**
 * St.BoxLayout 'vertical' is deprecated since GNOME 48 in favor of
 * 'orientation'. Use whichever the running shell supports.
 */
export function setVertical(box, vertical) {
    if ('orientation' in box) {
        box.orientation = vertical
            ? Clutter.Orientation.VERTICAL
            : Clutter.Orientation.HORIZONTAL;
    } else {
        box.vertical = vertical;
    }
}

/**
 * Meta.Window.get_maximized() was removed in GNOME 49; is_maximized()
 * replaces it. Falls back through the property pair and the legacy method.
 */
export function isMaximized(win) {
    if (typeof win.is_maximized === 'function') return win.is_maximized();
    if ('maximized_horizontally' in win)
        return win.maximized_horizontally && win.maximized_vertically;
    if (typeof win.get_maximized === 'function') return win.get_maximized() !== 0;
    return false;
}

/**
 * GNOME 49 made maximize()/unmaximize() flagless (see MAXIMIZE_IS_FLAGLESS).
 */
export function maximize(win) {
    if (MAXIMIZE_IS_FLAGLESS) win.maximize();
    else win.maximize(Meta.MaximizeFlags.BOTH);
}

export function unmaximize(win) {
    if (MAXIMIZE_IS_FLAGLESS) win.unmaximize();
    else win.unmaximize(Meta.MaximizeFlags.BOTH);
}

/**
 * Mutter animates minimize/restore toward the window's "icon geometry" — the
 * on-screen rect representing that window. Left unset it defaults to a fixed
 * spot, which is why windows always flew to the left regardless of where their
 * panel button actually sits. Docks set this to their icon; so do we.
 *
 * Meta.Rectangle became Mtk.Rectangle in GNOME 46. The extension supports
 * 46-51, so Mtk is always present and imported statically; Meta.Rectangle is
 * kept as a fallback only because some typelibs still expose it.
 */
export function setIconGeometry(win, x, y, width, height) {
    if (!win || !(width > 0 && height > 0)) return false;

    const Rect = Mtk?.Rectangle || Meta.Rectangle;
    if (!Rect) return false;

    try {
        win.set_icon_geometry(new Rect({
            x: Math.round(x), y: Math.round(y),
            width: Math.round(width), height: Math.round(height),
        }));
        return true;
    } catch (e) {
        return false;
    }
}

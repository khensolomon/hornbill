import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';
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

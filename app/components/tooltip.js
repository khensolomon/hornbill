import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { log } from '../util/logger.js';

/** Keep the tooltip this far clear of the monitor edge. */
const SCREEN_MARGIN = 8;
const FADE_MS = 120;

/**
 * Hover labels for Lesion's own panel buttons.
 *
 * ONE label actor and ONE timer serve every button. A label per button would
 * put N actors on uiGroup and, worse, N pending GLib sources to track; only one
 * tooltip can ever be visible, so the shared instance is both cheaper and
 * easier to tear down.
 *
 * The dependency is inverted deliberately: the manager attaches itself to a
 * button rather than the button asking for a tooltip. AppPanelButton is
 * untouched, its own 'notify::hover' handler stays purely about icon opacity,
 * and the whole feature can be removed by not calling attach().
 *
 * There is no tooltip widget in GNOME Shell. The nearest in-tree pattern is
 * DashItemContainer.showLabel(): an St.Label parented to uiGroup and placed
 * from get_transformed_position(). That is what this does.
 */
export class TooltipManager {
    constructor(settings) {
        this._settings = settings;
        this._label = null;
        this._showTimerId = 0;
        this._pending = null;
        this._current = null;
        this._signals = new Map();
    }

    /**
     * Start showing `text` when `button` is hovered.
     * @param {object} button - an AppPanelButton
     * @param {string} text - already localized; the manager never formats names
     */
    attach(button, text) {
        if (!button || this._signals.has(button)) return;
        if (!text) return;

        button._tooltipText = text;

        const ids = [];
        const onHover = () => this._onHoverChanged(button);

        ids.push({ obj: button, id: button.connect('notify::hover', onHover) });

        // The inner St.Button owns the pointer (see AppPanelButton._init), so
        // watching only the outer PanelMenu.Button misses most hover changes.
        if (button._clickButton) {
            ids.push({
                obj: button._clickButton,
                id: button._clickButton.connect('notify::hover', onHover),
            });
            // A click means the user is done reading; leaving it up would float
            // the label over whatever window just got focused.
            ids.push({
                obj: button._clickButton,
                id: button._clickButton.connect('clicked', () => this._hide(button)),
            });
        }

        // Running-app buttons churn as apps come and go.
        ids.push({ obj: button, id: button.connect('destroy', () => this.detach(button)) });

        if (button.menu) {
            ids.push({
                obj: button.menu,
                id: button.menu.connect('open-state-changed', (menu, open) => {
                    if (open) this._hide(button);
                }),
            });
        }

        this._signals.set(button, ids);
    }

    detach(button) {
        const ids = this._signals.get(button);
        if (ids) {
            ids.forEach(({ obj, id }) => {
                try { obj.disconnect(id); } catch (e) { log('[Tooltip] detach: disconnect() failed', e); }
            });
            this._signals.delete(button);
        }
        if (this._pending === button) this._cancelPending();
        if (this._current === button) this._hide(button);
        delete button._tooltipText;
    }

    destroy() {
        this._cancelPending();
        [...this._signals.keys()].forEach(btn => this.detach(btn));
        this._signals.clear();
        this._current = null;
        if (this._label) {
            this._label.destroy();
            this._label = null;
        }
    }

    _enabled() {
        return this._settings.get_boolean('apps-tooltips-enabled');
    }

    _delay() {
        const ms = this._settings.get_int('apps-tooltip-delay');
        return ms < 0 ? 0 : ms;
    }

    _onHoverChanged(button) {
        const hovered = button.hover || button._clickButton?.hover;
        if (hovered) this._schedule(button);
        else this._hide(button);
    }

    /**
     * Sweeping the pointer along the panel must not strobe a label per button,
     * so the first tooltip waits. Once one is up, moving to a neighbour swaps
     * immediately — re-waiting there reads as lag.
     */
    _schedule(button) {
        if (!this._enabled()) return;
        if (this._suppressed(button)) return;
        if (this._current === button) return;

        this._cancelPending();

        if (this._current) {
            this._show(button);
            return;
        }

        this._pending = button;
        this._showTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, this._delay(), () => {
            this._showTimerId = 0;
            this._pending = null;
            this._show(button);
            return GLib.SOURCE_REMOVE;
        });
    }

    _cancelPending() {
        if (this._showTimerId) {
            GLib.source_remove(this._showTimerId);
            this._showTimerId = 0;
        }
        this._pending = null;
    }

    /** Conditions under which a hover label would be noise or in the way. */
    _suppressed(button) {
        if (!button || button._destroyed || button._dragged) return true;
        if (!button._tooltipText) return true;
        if (button.menu?.isOpen) return true;
        if (Main.overview.visible) return true;
        if (Main.modalCount > 0) return true;
        return false;
    }

    _ensureLabel() {
        if (this._label) return this._label;

        this._label = new St.Label({
            style_class: 'lesion-tooltip',
            opacity: 0,
        });
        this._label.clutter_text.set_line_wrap(false);
        Main.layoutManager.uiGroup.add_child(this._label);
        return this._label;
    }

    /**
     * Built fresh on every _show() rather than cached and invalidated by
     * 'changed::' handlers. It is a string concat on a single actor, once per
     * hover, so the cost is irrelevant next to the wiring it removes — and
     * every key is live with no signal to forget.
     *
     * Applied inline rather than through a stylesheet: the extension ships no
     * shell stylesheet, and panels.js only rewrites styles on actors inside
     * the panel, so nothing here competes with it.
     */
    _buildStyle() {
        const s = this._settings;
        const weights = ['300', 'normal', '500', 'bold'];
        const borders = ['solid', 'dotted', 'dashed', 'double', 'groove', 'ridge', 'inset', 'outset', 'none'];

        let css = `background-color: ${s.get_string('apps-tooltip-bg-color')}; `
            + `color: ${s.get_string('apps-tooltip-text-color')}; `
            + `border-radius: ${s.get_int('apps-tooltip-radius')}px; `
            + `padding: ${s.get_int('apps-tooltip-pad-y')}px ${s.get_int('apps-tooltip-pad-x')}px; `
            + `font-size: ${s.get_int('apps-tooltip-font-size')}px; `
            + `font-weight: ${weights[s.get_enum('apps-tooltip-font-weight')] || 'normal'}; `;

        const borderSize = s.get_int('apps-tooltip-border-size');
        const borderStyle = s.get_enum('apps-tooltip-border-style');
        // Index 8 is 'none': a width with that style would still reserve space.
        if (borderSize > 0 && borderStyle !== 8) {
            css += `border: ${borderSize}px ${borders[borderStyle] || 'solid'} `
                + `${s.get_string('apps-tooltip-border-color')}; `;
        }

        if (s.get_boolean('apps-tooltip-shadow-enabled')) {
            css += `box-shadow: ${s.get_int('apps-tooltip-shadow-x')}px `
                + `${s.get_int('apps-tooltip-shadow-y')}px `
                + `${s.get_int('apps-tooltip-shadow-blur')}px `
                + `${s.get_int('apps-tooltip-shadow-spread')}px `
                + `${s.get_string('apps-tooltip-shadow-color')}; `;
        }

        return css;
    }

    _show(button) {
        if (this._suppressed(button) || !this._enabled()) return;

        const label = this._ensureLabel();
        // Style before text: padding and font size feed the preferred-size
        // query that _position() measures against.
        label.set_style(this._buildStyle());
        label.set_text(button._tooltipText);
        this._current = button;

        this._position(button, label);

        Main.layoutManager.uiGroup.set_child_above_sibling(label, null);
        label.remove_all_transitions();
        label.ease({
            opacity: 255,
            duration: FADE_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    /**
     * Placed from the button's own geometry rather than the 'panel-position'
     * key: a button in the top half of its monitor gets a label below it, one
     * in the bottom half gets it above. That is correct for a bottom panel
     * without reading any setting, and stays correct if the key and the actual
     * panel position ever diverge.
     */
    _position(button, label) {
        const [bx, by] = button.get_transformed_position();
        const [bw, bh] = button.get_transformed_size();
        const [, natW] = label.get_preferred_width(-1);
        const [, natH] = label.get_preferred_height(natW);

        const monitor = Main.layoutManager.findMonitorForActor(button)
            || Main.layoutManager.primaryMonitor;

        let x = Math.round(bx + (bw - natW) / 2);
        if (monitor) {
            const minX = monitor.x + SCREEN_MARGIN;
            const maxX = monitor.x + monitor.width - natW - SCREEN_MARGIN;
            if (maxX >= minX) x = Math.max(minX, Math.min(x, maxX));
        }

        const gap = this._settings.get_int('apps-tooltip-offset');
        const centerY = monitor ? monitor.y + monitor.height / 2 : by;
        const below = (by + bh / 2) < centerY;
        const y = below
            ? Math.round(by + bh + gap)
            : Math.round(by - natH - gap);

        label.set_position(x, y);
    }

    _hide(button) {
        if (this._pending === button) this._cancelPending();
        if (this._current !== button) return;

        this._current = null;
        if (!this._label) return;

        this._label.remove_all_transitions();
        this._label.ease({
            opacity: 0,
            duration: FADE_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }
}

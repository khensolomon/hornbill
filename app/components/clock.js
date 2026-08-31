import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { ExtensionComponent } from './base.js';
import { setVertical } from '../util/compat.js';
import { log, logError } from '../util/logger.js';

/**
 * Manages the Clock component in the GNOME Shell panel.
 * Handles moving the clock, formatting the time/date, and custom styling.
 * @extends ExtensionComponent
 */
export class ClockManager extends ExtensionComponent {

    /**
     * Called when the extension component is enabled.
     * Initializes the custom clock widget and hooks into system signals.
     */
    onEnable() {
        log("[Clock] enabling manager");

        /** @type {Main.DateMenu.DateMenuButton} */
        this._dateMenu = Main.panel.statusArea.dateMenu;
        this._centerBox = Main.panel._centerBox;
        this._rightBox = Main.panel._rightBox;
        this._leftBox = Main.panel._leftBox;

        // Determine which menu acts as the system/aggregate menu
        this._systemMenu = Main.panel.statusArea.quickSettings || Main.panel.statusArea.aggregateMenu;
        this._activities = Main.panel.statusArea.activities;

        /** @type {St.Label} */
        this._originalClockDisplay = this._dateMenu._clockDisplay;

        // --- Custom Clock Container ---
        // NOTE: this box lives INSIDE the dateMenu button, which is already a
        // '.panel-button'. It must therefore be a plain, non-reactive
        // container: giving it its own 'panel-button' class + hover handling
        // painted a second rounded background inside the outer one, and it
        // ignored the roundness/background that panels.js applies to
        // '.panel-button'. The outer dateMenu now owns hover, active state,
        // click handling, and themed styling — like every other button.
        // y_expand/y_align were unset, so the box defaulted to FILL and
        // stretched to whatever height the dateMenu button was given. The
        // two-line block then sat against the top of that space instead of in
        // the middle of it, which is what made the clock read as a taller
        // button than its neighbours.
        this._customBox = new St.BoxLayout({
            style_class: 'hornbill-clock',
            style: 'min-width: 24px; spacing: 0px;',
            reactive: false,
            track_hover: false,
            can_focus: false,
            x_expand: false,
            y_expand: false,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER
        });
        setVertical(this._customBox, true);

        // Time Label
        // NOTE: 'line-height' is NOT implemented by St's CSS subset, so the
        // 0.7em/0.5em declarations that used to be here did nothing at all.
        // Nor did 'min-height: 7px', which is far below the natural height of
        // any readable font. Line height is now controlled where it actually
        // lives — see _applyLineMetrics().
        this._timeLabel = new St.Label({
            style_class: 'clock-label',
            y_align: Clutter.ActorAlign.CENTER,
            x_align: Clutter.ActorAlign.CENTER,
            y_expand: false,
            text: " "
        });

        // Date Label (used for multiline or specific formats)
        this._dateLabel = new St.Label({
            style_class: 'clock-label',
            y_align: Clutter.ActorAlign.CENTER,
            x_align: Clutter.ActorAlign.CENTER,
            y_expand: false,
            text: " "
        });

        this._customBox.add_child(this._timeLabel);
        this._customBox.add_child(this._dateLabel);

        // Insert custom box into the panel hierarchy
        this._clockParent = this._originalClockDisplay.get_parent();
        this._clockParent.insert_child_above(this._customBox, this._originalClockDisplay);

        this._originalParent = this._dateMenu.container.get_parent();

        // Hover, click (menu toggle), and :active state are all handled by
        // the enclosing dateMenu PanelMenu.Button natively now that the
        // custom box is non-reactive — no manual pseudo-class juggling.
        this._menuSignal = null;
        this._tickId = 0;

        // Watch for text changes in the original clock to update the custom label
        this._clockSignal = this._originalClockDisplay.connect('notify::text', () => {
            this.idleOnce(() => {
                try {
                    this._updateClockText();
                } catch (e) {
                    logError(e);
                }
            });
        });

        // Initial Sync
        this.idleOnce(() => this._sync());

        // Register Settings Observers
        this.observe('changed::clock-move-enabled', () => this._syncPos());
        this.observe('changed::clock-position', () => this._syncPos());
        this.observe('changed::clock-target', () => this._syncPos());
        this.observe('changed::clock-format-mode', () => this._updateClockText());
        this.observe('changed::clock-custom-format', () => this._updateClockText());
        this.observe('changed::clock-multiline', () => this._updateClockText());
        this.observe('changed::clock-dim-separator', () => this._updateClockText());
        this.observe('changed::clock-multiline-time-size', () => this._updateClockText());
        this.observe('changed::clock-multiline-date-size', () => this._updateClockText());
        this.observe('changed::clock-multiline-tightness', () => this._updateClockText());

        // Seconds only tick if we drive them ourselves; see _syncTicker().
        this.observe('changed::clock-format-mode', () => this._syncTicker());
        this.observe('changed::clock-custom-format', () => this._syncTicker());
        this._syncTicker();
    }

    /**
     * SECONDS.
     *
     * The custom label was refreshed from one source only: 'notify::text' on
     * the shell's own clock. That fires when the SHELL's displayed string
     * changes, and the shell shows %H:%M by default — once a minute. A custom
     * format containing %S therefore sat on a stale second for up to 60s.
     * Several shipped presets use %S, so this was reachable straight from the
     * preset list.
     *
     * A second timer is only started when the format actually needs one.
     */
    _needsSeconds() {
        const settings = this.getSettings();
        if (settings.get_enum('clock-format-mode') !== 1) return false;
        const format = settings.get_string('clock-custom-format') || '';
        // Strip escaped percents first so '%%S' is not read as seconds.
        // %S seconds, %T = %H:%M:%S, %r 12-hour with seconds, %X locale time,
        // %c locale date+time, %s seconds since epoch.
        return /%[-_0^#]*[0-9]*[SsTrXc]/.test(format.replace(/%%/g, ''));
    }

    _syncTicker() {
        this._stopTicker();
        if (this._needsSeconds()) this._armTick();
    }

    /**
     * Re-armed to the next whole second rather than a flat 1000ms interval,
     * so the displayed second changes when the clock actually rolls over
     * instead of drifting further from it on every tick.
     */
    _armTick() {
        const us = GLib.DateTime.new_now_local().get_microsecond();
        const delay = Math.max(50, 1000 - Math.round(us / 1000));
        this._tickId = this.timeoutOnce(delay, () => {
            this._tickId = 0;
            this._updateClockText();
            this._armTick();
        });
    }

    _stopTicker() {
        if (!this._tickId) return;
        // timeoutOnce() registered this in the base class source set; remove
        // it there too or cleanup would call source_remove on a dead id.
        this._sources.delete(this._tickId);
        try { GLib.source_remove(this._tickId); }
        catch (e) { log('_stopTicker: source_remove failed', e); }
        this._tickId = 0;
    }

    /**
     * Called when the component is disabled.
     * Restores the original clock and cleans up.
     */
    onDisable() {
        this._stopTicker();
        this._restore();
    }

    /**
     * Synchronizes both position and text content.
     * @private
     */
    _sync() {
        this._syncPos();
        this._updateClockText();
    }

    /**
     * Moves the clock to the configured position (Left/Right panel) or restores it.
     * @private
     */
    _syncPos() {
        if (!this._dateMenu) return;
        const settings = this.getSettings();
        if (!settings.get_boolean('clock-move-enabled')) {
            this._restorePos();
            return;
        }

        const target = settings.get_enum('clock-target'); // 0: Left, 1: Right
        const position = settings.get_enum('clock-position'); // 0: Before, 1: After

        if (target === 0) {
            this._move(this._leftBox, this._activities, position);
        } else {
            this._move(this._rightBox, this._systemMenu, position);
        }
    }

    /**
     * Helper to move the DateMenu container to a specific target box.
     * @param {St.BoxLayout} targetBox - The panel box (left or right) to move into.
     * @param {Object} anchorObj - The status area object to anchor relative to.
     * @param {number} positionMode - 0 for before anchor, 1 for after.
     * @private
     */
    _move(targetBox, anchorObj, positionMode) {
        if (!this._dateMenu || !targetBox) return;
        const container = this._dateMenu.container;
        const parent = container.get_parent();

        if (parent) parent.remove_child(container);

        const children = targetBox.get_children();
        const anchorContainer = anchorObj ? anchorObj.container : null;
        let anchorIndex = anchorContainer ? children.indexOf(anchorContainer) : -1;

        // Fallback if anchor is missing: Start of left box, or End of right box
        if (anchorIndex === -1) {
            anchorIndex = targetBox === this._leftBox ? 0 : children.length;
        }

        const targetIndex = positionMode === 0 ? anchorIndex : anchorIndex + 1;
        targetBox.insert_child_at_index(container, targetIndex);
    }

    /**
     * Restores the clock to its default position in the center box.
     * @private
     */
    _restorePos() {
        if (!this._dateMenu || !this._centerBox) return;
        const container = this._dateMenu.container;
        const parent = container.get_parent();
        
        // If already in center box, do nothing (assumes index 0 is correct for restoration)
        if (parent === this._centerBox) return;
        
        if (parent) parent.remove_child(container);
        this._centerBox.insert_child_at_index(container, 0);
    }

    /**
     * Updates the text of the custom clock labels based on settings.
     * Handles formatting (strftime), multiline splitting, and dimming separators.
     * @private
     */
    _updateClockText() {
        if (!this._customBox || !this._originalClockDisplay) return;
        
        const settings = this.getSettings();
        const mode = settings.get_enum('clock-format-mode');
        const multiline = settings.get_boolean('clock-multiline');
        const dimSep = settings.get_boolean('clock-dim-separator');

        let text = '';
        if (mode === 1) {
            // Custom Format Mode
            const format = settings.get_string('clock-custom-format') || '%H:%M\n%A, %d %B';
            const now = GLib.DateTime.new_now_local();
            try {
                text = now.format(format);
            } catch (e) {
                logError(e);
                text = this._originalClockDisplay.text || ' ';
            }
        } else {
            // System Default Mode
            text = this._originalClockDisplay.text || ' ';
        }

        // Hide original, show custom
        this._originalClockDisplay.visible = false;
        this._customBox.visible = true;

        if (multiline) {
            setVertical(this._customBox, true);
            this._dateLabel.opacity = 204; // ~0.8, the CSS 'opacity' never applied

            // Regex to find time pattern like HH:MM or H:MM, optionally with seconds or AM/PM
            const timeRegex = /([0-9]{1,2}[:∶][0-9]{2}(?:[:∶][0-9]{2})?(?:\s?[AP]M)?)/;
            
            const parts = text.split(timeRegex);
            
            if (parts.length >= 2) {
                // parts[1] is the time. parts[0] is prefix, parts[2] is suffix.
                this._timeLabel.text = parts[1].trim();
                // Combine prefix and suffix for the date line
                this._dateLabel.text = ((parts[0] + ' ' + (parts[2] || '')).trim().replace(/\s{2,}/g,' ')) || ' ';
            } else {
                // Fallback split by space if regex fails
                const split = text.split(' ');
                this._timeLabel.text = split[0] || ' ';
                this._dateLabel.text = split.slice(1).join(' ') || ' ';
            }

        } else {
            setVertical(this._customBox, false);
            this._dateLabel.opacity = 0;
            this._dateLabel.text = ' ';

            if (dimSep) {
                // Dim separators like ':', '-', '|', etc.
                this._timeLabel.clutter_text.set_use_markup(true);
                let safe = GLib.markup_escape_text(text, -1).replace(/([|•\-\u2013\u2014:∶])/g, "<span foreground='#888888'>$1</span>");
                if (!safe.trim()) safe = '&nbsp;';
                
                // Idle add to ensure markup applies correctly
                this.idleOnce(() => {
                    try {
                        this._timeLabel.clutter_text.set_markup(safe);
                    } catch (e) {
                        logError(e);
                        this._timeLabel.clutter_text.set_use_markup(false);
                        this._timeLabel.text = text || ' ';
                    }
                });
            } else {
                this._timeLabel.clutter_text.set_use_markup(false);
                this._timeLabel.text = text;
            }
        }

        this._applyLineMetrics(multiline);
    }

    /**
     * THE TWO-LINE GAP.
     *
     * The box spacing was already 0, so the space between the lines was never
     * spacing — it is font leading, the padding a font reserves above and
     * below its glyphs. Two stacked St.Labels contribute two full line boxes,
     * which made the dateMenu taller than every other panel button and gave it
     * a visibly bigger hover background.
     *
     * Leading cannot be styled away in St ('line-height' is not implemented),
     * so each label is given an explicit height that keeps only 'tightness'
     * percent of its natural one. That trims the leading while leaving the
     * glyphs, and both line sizes are adjustable because how much leading a
     * font reserves varies with the font.
     *
     * Floored at MIN_LINE_PX so no combination of settings can collapse the
     * clock to nothing.
     */
    _applyLineMetrics(multiline) {
        const MIN_LINE_PX = 6;
        const settings = this.getSettings();

        if (!multiline) {
            // Single line: let the label size itself as before.
            this._timeLabel.set_style('min-width: 20px;');
            this._timeLabel.set_height(-1);
            this._dateLabel.set_height(-1);
            return;
        }

        const clampPct = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
        const timePct = clampPct(settings.get_int('clock-multiline-time-size'), 40, 200);
        const datePct = clampPct(settings.get_int('clock-multiline-date-size'), 30, 200);
        const tight = clampPct(settings.get_int('clock-multiline-tightness'), 50, 100) / 100;

        this._timeLabel.set_style(`min-width: 20px; font-size: ${timePct}%;`);
        this._dateLabel.set_style(`min-width: 20px; font-size: ${datePct}%;`);

        // Height must be measured AFTER the font size is applied, or the
        // natural height still reflects the previous size.
        [this._timeLabel, this._dateLabel].forEach(label => {
            try {
                label.set_height(-1);
                const [, natural] = label.get_preferred_height(-1);
                if (natural > 0)
                    label.set_height(Math.max(MIN_LINE_PX, Math.round(natural * tight)));
            } catch (e) {
                log('_applyLineMetrics: get_preferred_height() failed', e);
                label.set_height(-1);
            }
        });
    }

    /**
     * Restores the environment to its original state.
     * @private
     */
    _restore() {
        this._restorePos();
        
        // Clean up the menu state signal
        if (this._dateMenu && this._menuSignal) {
            this._dateMenu.menu.disconnect(this._menuSignal);
            this._menuSignal = null;
        }

        if (this._originalClockDisplay) {
            if (this._clockSignal) {
                this._originalClockDisplay.disconnect(this._clockSignal);
                this._clockSignal = null;
            }
            this._originalClockDisplay.visible = true;
        }

        if (this._customBox) {
            try {
                this._customBox.destroy();
            } catch (e) {
                logError(e);
            }
            this._customBox = null;
            this._timeLabel = null;
            this._dateLabel = null;
        }
    }
}
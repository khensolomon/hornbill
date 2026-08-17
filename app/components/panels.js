import St from 'gi://St';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import Clutter from 'gi://Clutter';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { ExtensionComponent } from './base.js';
import { log, logError } from '../util/logger.js';
import { AppConfig } from '../config.js'; // Critical Import for Schema Consistency

export class PanelsManager extends ExtensionComponent {
    
    constructor(extension) {
        super(extension);
        this._buttonSignals = new Map();
        this._boxSignals = []; 
        this._blurEffect = null;
        this._blurActor = null;
        this._monitorsChangedId = 0;
        this._refreshTimeoutId = 0;
        this._settingsSignals = [];
        this._clockCssFile = null;

        // Shared settings object resolved from the extension's own schema dir.
        // Backend and prefs now use the same source, so they can't diverge.
        this._settings = AppConfig.getSettings();
    }

    onEnable() {
        this._savedPanelStyle = Main.panel.get_style();
        
        const keys = [
            'panel-enabled',
            'panel-position',
            'panel-bg-color', 'panel-bg-gradient-enabled', 'panel-bg-gradient-color', 'panel-bg-gradient-dir',
            'panel-border-size', 'panel-border-color', 'panel-border-style', 'panel-border-bottom-only',
            'panel-shadow-enabled', 'panel-shadow-color', 
            'panel-shadow-x', 'panel-shadow-y', 'panel-shadow-blur', 'panel-shadow-spread', 'panel-shadow-inset',
            'panel-blur-enabled', 'panel-blur-sigma', 
            'panel-margin', 'panel-corner-radius',
            'panel-btn-color',
            'panel-btn-radius', 'panel-btn-pad-min', 'panel-btn-pad-nat', 
            'panel-btn-bg-hover', 'panel-btn-bg-active', 'panel-btn-hover-enabled',
            'popup-radius', 
            'popup-shadow-enabled', 'popup-shadow-color', 
            'popup-shadow-x', 'popup-shadow-y', 'popup-shadow-blur', 'popup-shadow-spread',
            'popup-border-size', 'popup-border-color', 'popup-border-style'
        ];

        keys.forEach(key => {
            this._settingsSignals.push(
                this._settings.connect(`changed::${key}`, () => this._queueRefresh())
            );
        });

        this._monitorsChangedId = Main.layoutManager.connect('monitors-changed', () => {
            this._applyPosition();
        });

        // DEBUG LOG: Verify what the extension actually sees on startup
        const startColor = this._settings.get_string('panel-bg-color');
        log(`[Panels] Enabled. Schema: ${AppConfig.schemaId}. Loaded BG Color: ${startColor}`);

        this._queueRefresh();
    }

    onDisable() {
        if (this._refreshTimeoutId) {
            GLib.source_remove(this._refreshTimeoutId);
            this._refreshTimeoutId = 0;
        }

        // Cleanup settings signals.
        // NOTE: never run_dispose() a Gio.Settings — it is shared and disposing
        // it invalidates every other consumer. Disconnect only the signals added here.
        if (this._settings) {
            this._settingsSignals.forEach(id => {
                try { this._settings.disconnect(id); } catch (e) {}
            });
            this._settingsSignals = [];
        }

        if (this._boxSignals) {
            this._boxSignals.forEach(sig => {
                if (this._isValid(sig.actor)) {
                    try {
                        sig.actor.disconnect(sig.id);
                    } catch (e) {}
                }
            });
            this._boxSignals = [];
        }

        if (this._monitorsChangedId) {
            Main.layoutManager.disconnect(this._monitorsChangedId);
            this._monitorsChangedId = 0;
        }

        this._cleanupButtonSignals();
        this._removeBlur();

        if (Main.panel) {
            Main.panel.set_style(this._savedPanelStyle || null);
            const monitor = Main.layoutManager.primaryMonitor;
            if (monitor) Main.layoutManager.panelBox.y = monitor.y;
        }

        this._iterateMenus((menu) => this._resetMenuStyle(menu));
        this._iterateButtons((btn) => {
            if (this._isValid(btn)) {
                btn.set_style(null);
                if (btn.has_style_class_name('clock-display'))
                    this._setClockPillNeutralized(btn, false);
                delete btn._baseCss;
            }
        });
        this._unloadClockCss();
    }

    // Helper: Safely check if an actor is alive
    _isValid(actor) {
        if (!actor) return false;
        try {
            return actor.get_parent() !== undefined; 
        } catch (e) {
            return false;
        }
    }

    // Debounce
    _queueRefresh() {
        if (this._refreshTimeoutId) {
            GLib.source_remove(this._refreshTimeoutId);
        }
        this._refreshTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
            if (!this._isEnabled) return GLib.SOURCE_REMOVE;
            this._refreshAll();
            this._refreshTimeoutId = 0;
            return GLib.SOURCE_REMOVE;
        });
    }

    _refreshAll() {
        // Use the shared settings object
        if (!this._settings.get_boolean('panel-enabled')) {
            if (Main.panel) Main.panel.set_style(this._savedPanelStyle || null);
            const monitor = Main.layoutManager.primaryMonitor;
            if (monitor) Main.layoutManager.panelBox.y = monitor.y;
            this._removeBlur();
            this._iterateButtons((btn) => {
                if (this._isValid(btn)) {
                    btn.set_style(null);
                    if (btn.has_style_class_name('clock-display'))
                        this._setClockPillNeutralized(btn, false);
                    btn.queue_relayout();
                }
            });
            this._unloadClockCss();
            this._cleanupButtonSignals();
            return;
        }

        this._applyPanelBarStyles();
        this._applyPosition();
        this._applyButtonStaticStyles();
        this._updateClockCss();
        this._refreshButtonListeners();
        
        this._iterateMenus((menu) => {
            this._styleSingleMenu(menu);
            if (menu.isOpen) {
                const bubble = this._getBoxPointer(menu);
                if (bubble) bubble.queue_relayout();
            }
        });
    }

    // --- Position ---
    _applyPosition() {
        if (!Main.layoutManager || !Main.layoutManager.panelBox) return;

        const pos = this._settings.get_enum('panel-position'); 
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor) return;

        Main.layoutManager.panelBox.x = monitor.x;

        if (pos === 2) { // Bottom
            const panelHeight = Main.layoutManager.panelBox.height || 32; 
            Main.layoutManager.panelBox.y = monitor.y + monitor.height - panelHeight;
        } else {
            Main.layoutManager.panelBox.y = monitor.y;
        }
    }

    // --- Blur ---
    _removeBlur() {
        if (this._blurActor) {
            if (this._isValid(this._blurActor))
                this._blurActor.destroy();
            this._blurActor = null;
        }
        // Legacy cleanup: earlier builds put the effect on Main.panel itself
        if (this._blurEffect) {
            if (this._isValid(Main.panel)) {
                Main.panel.remove_effect(this._blurEffect);
            }
            this._blurEffect = null;
        }
    }

    _applyBlur() {
        const enabled = this._settings.get_boolean('panel-blur-enabled');
        const radius = this._settings.get_int('panel-blur-sigma'); 

        if (!enabled || radius <= 0) {
            this._removeBlur();
            return;
        }

        if (!this._isValid(Main.panel)) return;

        if (!this._blurActor || !this._isValid(this._blurActor)) {
            this._removeBlur();

            // Dedicated background actor: input-transparent by construction,
            // and inserted BELOW the panel's contents so nothing it does can
            // affect the buttons above it.
            this._blurActor = new St.Widget({
                name: 'lesion-panel-blur',
                reactive: false,
                can_focus: false,
                track_hover: false,
                x_expand: true,
                y_expand: true,
            });
            this._blurActor.add_constraint(new Clutter.BindConstraint({
                source: Main.panel,
                coordinate: Clutter.BindCoordinate.ALL,
            }));

            this._blurEffect = new Shell.BlurEffect({
                brightness: 1.0,
                radius: radius,
                // BACKGROUND blurs what is behind the actor. ACTOR mode
                // blurred the panel's own icons and text.
                mode: Shell.BlurMode.BACKGROUND,
            });
            this._blurActor.add_effect(this._blurEffect);

            Main.panel.insert_child_below(this._blurActor, null);
        } else {
            this._blurEffect.radius = radius;
        }
    }

    // --- Panel Styling ---
    _applyPanelBarStyles() {
        this._applyBlur();

        const bgColor = this._settings.get_string('panel-bg-color');
        const useGradient = this._settings.get_boolean('panel-bg-gradient-enabled');
        const gradColor = this._settings.get_string('panel-bg-gradient-color');
        const gradDir = this._settings.get_int('panel-bg-gradient-dir'); 
        const margin = this._settings.get_int('panel-margin');
        const cornerRadius = this._settings.get_int('panel-corner-radius');
        const position = this._settings.get_enum('panel-position'); 
        const borderSize = this._settings.get_int('panel-border-size');
        const borderColor = this._settings.get_string('panel-border-color');
        const borderStyle = this._settings.get_enum('panel-border-style'); 
        const borderBottomOnly = this._settings.get_boolean('panel-border-bottom-only');
        const shadowEnabled = this._settings.get_boolean('panel-shadow-enabled');
        const shadowColor = this._settings.get_string('panel-shadow-color');
        const sX = this._settings.get_int('panel-shadow-x');
        const sY = this._settings.get_int('panel-shadow-y');
        const sBlur = this._settings.get_int('panel-shadow-blur');
        const sSpread = this._settings.get_int('panel-shadow-spread');
        const sInset = this._settings.get_boolean('panel-shadow-inset');

        let css = '';

        if (margin > 0) css += `margin: ${margin}px; margin-bottom: 0; `;
        if (cornerRadius > 0) css += `border-radius: ${cornerRadius}px; `;

        if (useGradient) {
            const dir = gradDir === 0 ? 'vertical' : 'horizontal';
            css += `background-gradient-direction: ${dir}; background-gradient-start: ${bgColor}; background-gradient-end: ${gradColor}; `;
        } else {
            css += `background-color: ${bgColor}; background-gradient-direction: none; `;
        }
        
        const styles = ['solid','dotted','dashed','double','groove','ridge','inset','outset','none'];
        const bStyleStr = styles[borderStyle] || 'solid';
        
        if (borderSize > 0 && borderStyle !== 8) {
            css += `border-color: ${borderColor}; border-style: ${bStyleStr}; `;
            if (borderBottomOnly) {
                if (position === 2) { 
                    css += `border-top-width: ${borderSize}px; border-bottom-width: 0; border-left-width: 0; border-right-width: 0; `;
                } else { 
                    css += `border-bottom-width: ${borderSize}px; border-top-width: 0; border-left-width: 0; border-right-width: 0; `;
                }
            } else {
                css += `border-width: ${borderSize}px; `;
            }
        } else {
            css += `border-width: 0; `;
        }

        if (shadowEnabled) {
            const inset = sInset ? 'inset' : '';
            css += `box-shadow: ${inset} ${sX}px ${sY}px ${sBlur}px ${sSpread}px ${shadowColor}; `;
        } else {
            css += `box-shadow: none; `;
        }

        if (this._isValid(Main.panel)) {
            Main.panel.set_style(css);
        }
    }

    // --- Buttons ---

    _iterateButtons(callback) {
        const boxes = [Main.panel._leftBox, Main.panel._centerBox, Main.panel._rightBox];
        boxes.forEach(box => {
            if (!this._isValid(box)) return;
            
            let children;
            try {
                children = box.get_children();
            } catch (e) { return; }

            children.forEach(actor => {
                if (!this._isValid(actor)) return;
                try {
                    if (actor.has_style_class_name('panel-button')) {
                        callback(actor);
                    } else if (actor.get_first_child) {
                        const child = actor.get_first_child();
                        if (this._isValid(child) && child.has_style_class_name && child.has_style_class_name('panel-button')) {
                            callback(child);
                        }
                    }
                } catch (e) {}
            });
        });
    }

    _applyButtonStaticStyles() {
        const radius = this._settings.get_int('panel-btn-radius');
        const minPad = this._settings.get_int('panel-btn-pad-min');
        const natPad = this._settings.get_int('panel-btn-pad-nat');
        const btnColor = this._settings.get_string('panel-btn-color');

        const css = `color: ${btnColor}; border-radius: ${radius}px; -natural-hpadding: ${natPad}px; -minimum-hpadding: ${minPad}px; min-width: 24px; min-height: 24px;`;

        this._iterateButtons((btn) => {
            try {
                let btnCss = css;
                if (btn.has_style_class_name('clock-display')) {
                    // The stock theme treats the clock specially: it zeroes
                    // this button's own padding and draws a fixed-radius pill
                    // on the inner '.clock' label instead — so Corner Radius
                    // and padding settings appeared to be ignored here.
                    // Give the button explicit symmetric padding (the
                    // -hpadding hints alone can't beat the theme's padding:0)
                    // and neutralize the inner pill, so the clock is styled
                    // by the same rules as every other button.
                    btnCss += ` padding: 0 ${natPad}px;`;
                    this._setClockPillNeutralized(btn, true);
                }
                btn.set_style(btnCss);
                btn.queue_relayout(); 
                btn._baseCss = btnCss; 
            } catch (e) {}
        });
    }

    /**
     * The stock theme styles the clock pill via pseudo-state rules
     * (:hover/:active/:checked) that inline actor styles cannot reliably
     * override across GNOME versions and themes (Adwaita, Yaru). A loaded
     * stylesheet with explicit selectors for every state wins the cascade,
     * so the clock finally follows the configured Corner Radius and padding.
     */
    _updateClockCss() {
        const radius = this._settings.get_int('panel-btn-radius');
        const natPad = this._settings.get_int('panel-btn-pad-nat');
        const hoverEnabled = this._settings.get_boolean('panel-btn-hover-enabled');

        // Since the theme's own pill (which lived on the inner '.clock') is
        // neutralized below, the clock would have NO hover/active feedback
        // unless it is provided here. Use the configured colors when the
        // hover effect is on; otherwise fall back to a shell-like overlay so
        // the clock still behaves like the other buttons' theme defaults.
        const hoverBg = hoverEnabled
            ? this._settings.get_string('panel-btn-bg-hover')
            : 'rgba(255,255,255,0.12)';
        const activeBg = hoverEnabled
            ? this._settings.get_string('panel-btn-bg-active')
            : 'rgba(255,255,255,0.25)';

        const css = `
#panel .panel-button.clock-display,
#panel .panel-button.clock-display:hover,
#panel .panel-button.clock-display:focus,
#panel .panel-button.clock-display:active,
#panel .panel-button.clock-display:checked {
    border-radius: ${radius}px;
    padding: 0 ${natPad}px;
}
#panel .panel-button.clock-display:hover {
    background-color: ${hoverBg};
}
#panel .panel-button.clock-display:active,
#panel .panel-button.clock-display:checked {
    background-color: ${activeBg};
}
#panel .panel-button.clock-display .clock,
#panel .panel-button.clock-display .clock-display-box,
#panel .panel-button.clock-display:hover .clock,
#panel .panel-button.clock-display:focus .clock,
#panel .panel-button.clock-display:active .clock,
#panel .panel-button.clock-display:checked .clock {
    background-color: transparent;
    border-radius: 0;
    box-shadow: none;
    margin: 0;
    padding: 0;
}
`;

        try {
            const dir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'lesion']);
            GLib.mkdir_with_parents(dir, 0o755);
            const path = GLib.build_filenamev([dir, 'clock.css']);
            GLib.file_set_contents(path, css);

            const theme = St.ThemeContext.get_for_stage(global.stage).get_theme();
            if (this._clockCssFile) {
                try { theme.unload_stylesheet(this._clockCssFile); } catch (e) {}
            }
            this._clockCssFile = Gio.File.new_for_path(path);
            theme.load_stylesheet(this._clockCssFile);
        } catch (e) {
            logError('Failed to apply clock stylesheet', e);
        }
    }

    _unloadClockCss() {
        if (!this._clockCssFile) return;
        try {
            const theme = St.ThemeContext.get_for_stage(global.stage).get_theme();
            theme.unload_stylesheet(this._clockCssFile);
        } catch (e) {}
        this._clockCssFile = null;
    }

    /**
     * Neutralizes (or restores) the stock theme's pill styling on the inner
     * '.clock' label / 'clock-display-box' inside the dateMenu button, so the
     * outer button's configured background, radius, and padding are the only
     * visible styling.
     */
    _setClockPillNeutralized(btn, neutralize) {
        const NEUTRAL = 'background-color: transparent; border-radius: 0; box-shadow: none; margin: 0; padding: 0;';
        const walk = (actor) => {
            if (!this._isValid(actor)) return;
            try {
                if (actor.has_style_class_name &&
                    (actor.has_style_class_name('clock') ||
                     actor.has_style_class_name('clock-display-box'))) {
                    actor.set_style(neutralize ? NEUTRAL : null);
                }
            } catch (e) {}
            try {
                let child = actor.get_first_child ? actor.get_first_child() : null;
                while (child) {
                    walk(child);
                    child = child.get_next_sibling();
                }
            } catch (e) {}
        };
        walk(btn);
    }

    _cleanupButtonSignals() {
        // Entries are {obj, id} pairs: signals may live on the button itself
        // or on its menu object.
        for (const [, sigs] of this._buttonSignals) {
            sigs.forEach(sig => {
                if (this._isValid(sig.obj)) sig.obj.disconnect(sig.id);
            });
        }
        this._buttonSignals.clear();
    }

    _refreshButtonListeners() {
        this._cleanupButtonSignals(); 
        const enabled = this._settings.get_boolean('panel-btn-hover-enabled');
        
        const hoverBg = this._settings.get_string('panel-btn-bg-hover');
        const activeBg = this._settings.get_string('panel-btn-bg-active');

        this._iterateButtons((btn) => {
            const sigs = [];
            const base = btn._baseCss || '';

            try {
                if (enabled) {
                    // Single source of truth for the button's visual state.
                    // Menu-open ranks above hover: a button whose menu is
                    // open stays highlighted even when the pointer moves
                    // into the menu (previously the hover reset wiped it,
                    // and the indicator — which swallows press events for
                    // its custom click handling — never highlighted at all).
                    const applyState = () => {
                        if (!this._isValid(btn)) return;
                        try {
                            const menuOpen = btn.menu && btn.menu.isOpen;
                            if (menuOpen) {
                                btn.set_style(`${base} background-color: ${activeBg};`);
                            } else if (btn.hover) {
                                btn.set_style(`${base} background-color: ${hoverBg};`);
                            } else {
                                btn.set_style(base || null);
                            }
                        } catch (e) {}
                    };

                    sigs.push({ obj: btn, id: btn.connect('notify::hover', applyState) });

                    sigs.push({ obj: btn, id: btn.connect('button-press-event', () => {
                        if (!this._isValid(btn)) return false;
                        btn.set_style(`${base} background-color: ${activeBg}; box-shadow: inset 0 0 4px rgba(0,0,0,0.2);`);
                        return false; 
                    }) });

                    sigs.push({ obj: btn, id: btn.connect('button-release-event', () => {
                        applyState();
                        return false;
                    }) });

                    // Highlight while the button's menu is open. This is what
                    // makes the indicator (and any button opened via
                    // keyboard/code rather than a tracked press) light up.
                    if (btn.menu) {
                        sigs.push({ obj: btn.menu, id: btn.menu.connect('open-state-changed', applyState) });
                    }
                }

                // Destroy listener for self-cleanup
                sigs.push({ obj: btn, id: btn.connect('destroy', () => {
                    this._buttonSignals.delete(btn);
                }) });

                this._buttonSignals.set(btn, sigs);
            } catch (e) {}
        });
    }

    _iterateMenus(callback) {
        if (Main.panel.statusArea) {
            for (const key in Main.panel.statusArea) {
                try {
                    const indicator = Main.panel.statusArea[key];
                    if (indicator && indicator.menu) callback(indicator.menu);
                } catch (e) {}
            }
        }
        if (Main.panel.menuManager && Main.panel.menuManager._menus) {
            Main.panel.menuManager._menus.forEach(menu => {
                try {
                    callback(menu);
                } catch (e) {}
            });
        }
    }

    _getBoxPointer(menu) {
        try {
            if (!menu) return null;
            if (menu.boxPointer) return menu.boxPointer;
            if (this._isValid(menu.actor) && typeof menu.actor.setArrowSide === 'function') return menu.actor;
            if (menu._boxPointer) return menu._boxPointer;
        } catch (e) {}
        return null;
    }

    _resetMenuStyle(menu) {
        try {
            const bubble = this._getBoxPointer(menu);
            const content = menu.box;
            if (this._isValid(bubble)) bubble.set_style(null);
            if (this._isValid(content)) content.set_style(null);
        } catch (e) {}
    }

    _styleSingleMenu(menu) {
        try {
            const bubble = this._getBoxPointer(menu);
            const content = menu.box;
            if (!this._isValid(bubble)) return;

            const radius = this._settings.get_int('popup-radius');
            const shadowEnabled = this._settings.get_boolean('popup-shadow-enabled');
            const shadowColor = this._settings.get_string('popup-shadow-color');
            const sX = this._settings.get_int('popup-shadow-x');
            const sY = this._settings.get_int('popup-shadow-y');
            const sBlur = this._settings.get_int('popup-shadow-blur');
            const sSpread = this._settings.get_int('popup-shadow-spread');

            const bSize = this._settings.get_int('popup-border-size');
            const bColor = this._settings.get_string('popup-border-color');
            const bStyle = this._settings.get_enum('popup-border-style');
            const styles = ['solid','dotted','dashed','double','groove','ridge','inset','outset','none'];

            let bubbleCss = `border-radius: ${radius}px; `;
            
            if (shadowEnabled) {
                bubbleCss += `box-shadow: ${sX}px ${sY}px ${sBlur}px ${sSpread}px ${shadowColor}; `;
            } else {
                bubbleCss += `box-shadow: none; `;
            }

            if (bSize > 0 && bStyle !== 8) {
                bubbleCss += `border: ${bSize}px ${styles[bStyle]} ${bColor}; `;
            }

            if (!bubble.has_style_class_name('popup-menu-boxpointer')) {
                bubble.add_style_class_name('popup-menu-boxpointer');
            }
            bubble.set_style(bubbleCss);

            if (this._isValid(content)) {
                let contentCss = `border-radius: ${radius}px; `;
                if (!content.has_style_class_name('popup-menu')) {
                    content.add_style_class_name('popup-menu');
                }
                content.set_style(contentCss);
            }
        } catch (e) {}
    }
}
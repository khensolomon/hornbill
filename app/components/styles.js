import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import { log, logError } from '../util/logger.js';
import { ExtensionComponent } from './base.js';

export class StyleManager extends ExtensionComponent {
    
    onEnable() {
        this._stylesheetFiles = [];
        this._monitors = [];
        this._reloadTimeoutId = 0;

        // Apply immediately
        this._applyStyles();

        // Watch settings using the base class 'observe' helper
        this.observe('changed::enabled-styles', () => {
            log("Setting changed: enabled-styles");
            this._applyStyles();
        });
        
        this.observe('changed::custom-styles', () => {
            log("Setting changed: custom-styles");
            this._applyStyles();
        });

        this.observe('changed::custom-styles-enabled', () => {
            log("Setting changed: custom-styles-enabled");
            this._applyStyles();
        });
    }

    onDisable() {
        if (this._reloadTimeoutId) {
            GLib.source_remove(this._reloadTimeoutId);
            this._reloadTimeoutId = 0;
        }
        this._clearMonitors();
        this._removeStyles();
        this._stylesheetFiles = [];
    }

    /**
     * HOT RELOAD. Every applied stylesheet gets a file monitor; edits on
     * disk reapply all styles (debounced), so iterating on a CSS file is
     * save -> see, with no toggle dance.
     */
    _watchFile(file) {
        try {
            const monitor = file.monitor_file(Gio.FileMonitorFlags.NONE, null);
            monitor.connect('changed', (m, f, of, eventType) => {
                if (eventType === Gio.FileMonitorEvent.CHANGES_DONE_HINT ||
                    eventType === Gio.FileMonitorEvent.CHANGED ||
                    eventType === Gio.FileMonitorEvent.CREATED) {
                    if (this._reloadTimeoutId)
                        GLib.source_remove(this._reloadTimeoutId);
                    this._reloadTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
                        this._reloadTimeoutId = 0;
                        log('Stylesheet changed on disk — reloading');
                        this._applyStyles();
                        return GLib.SOURCE_REMOVE;
                    });
                }
            });
            this._monitors.push(monitor);
        } catch (e) {
            logError('Failed to monitor stylesheet', e);
        }
    }

    _clearMonitors() {
        for (const m of this._monitors ?? []) {
            try { m.cancel(); } catch (e) {}
        }
        this._monitors = [];
    }

    _applyStyles() {
        this._removeStyles();
        this._clearMonitors();

        const themeContext = St.ThemeContext.get_for_stage(global.stage);
        const theme = themeContext.get_theme();
        const cssDir = GLib.build_filenamev([this._extension.path, 'style', 'bundled']);
        const settings = this.getSettings();

        // A. Load Bundled Styles
        const enabledBundled = settings.get_strv('enabled-styles') || [];
        for (const cssFile of enabledBundled) {
            try {
                const path = GLib.build_filenamev([cssDir, cssFile]);
                const file = Gio.File.new_for_path(path);
                if (file.query_exists(null)) {
                    theme.load_stylesheet(file);
                    this._stylesheetFiles.push(file);
                    this._watchFile(file);
                    log(`Applied bundled style: ${cssFile}`);
                }
            } catch (e) {
                logError(`Error loading bundled style ${cssFile}`, e);
            }
        }

        // B. Load Custom User Styles (behind the master switch)
        try {
            if (!settings.get_boolean('custom-styles-enabled'))
                throw null; // skip customs entirely; bundled remain
            const customStyles = settings.get_value('custom-styles').deep_unpack();
            for (const [uri, enabled] of customStyles) {
                if (enabled) {
                    try {
                        const file = Gio.File.new_for_uri(uri);
                        if (file.query_exists(null)) {
                            theme.load_stylesheet(file);
                            this._stylesheetFiles.push(file);
                            this._watchFile(file);
                            log(`Applied custom style: ${uri}`);
                        }
                    } catch (e) {
                        logError(`Error loading custom style ${uri}`, e);
                    }
                }
            }
        } catch (e) {
            if (e) logError("Error parsing custom-styles", e);
        }

        themeContext.set_theme(theme);
    }

    _removeStyles() {
        const themeContext = St.ThemeContext.get_for_stage(global.stage);
        const theme = themeContext.get_theme();

        for (const file of this._stylesheetFiles) {
            theme.unload_stylesheet(file);
        }
        this._stylesheetFiles = [];
        themeContext.set_theme(theme);
    }
}
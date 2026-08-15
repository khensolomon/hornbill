import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { log, logError } from '../util/logger.js';
import { ExtensionComponent } from './base.js';

export class WallpaperManager extends ExtensionComponent {
    
    onEnable() {
        this.backupFile = 'backup.wallpaper.v1.json';
        this._bgSettings = new Gio.Settings({ schema_id: 'org.gnome.desktop.background' });
        this._interfaceSettings = new Gio.Settings({ schema_id: 'org.gnome.desktop.interface' });
        
        this._backupWallpaper();

        // FIX: background actors are recreated on monitor changes and
        // wallpaper switches, silently dropping the effects. Reapply then.
        this._monitorsChangedId = Main.layoutManager.connect('monitors-changed', () => {
            if (this.getSettings().get_boolean('wallpaper-enabled'))
                this._updateEffects();
        });

        // Initialize Light colors from the system when unset
        this._initLightColors();

        this.observe('changed::wallpaper-enabled', () => this._updateMasterState());
        this._updateMasterState();
    }

    onDisable() {
        if (this._monitorsChangedId) {
            Main.layoutManager.disconnect(this._monitorsChangedId);
            this._monitorsChangedId = 0;
        }
        this._cleanupFeatures();
        this._restoreWallpaper();
        this._bgSettings = null;
        this._interfaceSettings = null;
    }

    /**
     * Backup lives in the user state dir, NOT the extension dir:
     * - the extension dir may be read-only (system installs) and is wiped on
     *   every extension update, silently destroying the backup;
     * - EGO review also rejects writing into the extension directory.
     * The old in-extension path is still read once for migration.
     */
    _getBackupPath() {
        const dir = GLib.build_filenamev([GLib.get_user_state_dir(), 'lesion']);
        GLib.mkdir_with_parents(dir, 0o755);
        return GLib.build_filenamev([dir, this.backupFile]);
    }

    _getLegacyBackupPath() {
        return GLib.build_filenamev([this._extension.path, this.backupFile]);
    }

    _initLightColors() {
        // If extension's "light" storage is empty, grab current system color
        const s = this.getSettings();
        if (s.get_string('wallpaper-primary-color-light') === '') {
            const current = this._bgSettings.get_string('primary-color');
            s.set_string('wallpaper-primary-color-light', current);
        }
        if (s.get_string('wallpaper-secondary-color-light') === '') {
            const currentSec = this._bgSettings.get_string('secondary-color');
            s.set_string('wallpaper-secondary-color-light', currentSec);
        }
    }

    _updateMasterState() {
        const enabled = this.getSettings().get_boolean('wallpaper-enabled');

        if (enabled) {
            log("[Wallpaper] enabling manager");
            if (!this._featureSignals) {
                this._featureSignals = [];
                const s = this.getSettings();
                const track = (obj, id) => this._featureSignals.push({ obj, id });

                // Visibility & Effects
                track(s, s.connect('changed::wallpaper-show-image', () => this._updateVisibility()));
                track(s, s.connect('changed::wallpaper-monochrome', () => this._updateEffects()));
                track(s, s.connect('changed::wallpaper-blur-sigma', () => this._updateEffects()));
                track(s, s.connect('changed::wallpaper-brightness', () => this._updateEffects()));
                
                // Colors - Watch BOTH Light and Dark storage keys
                track(s, s.connect('changed::wallpaper-primary-color-light', () => this._updateColors()));
                track(s, s.connect('changed::wallpaper-secondary-color-light', () => this._updateColors()));
                track(s, s.connect('changed::wallpaper-primary-color-dark', () => this._updateColors()));
                track(s, s.connect('changed::wallpaper-secondary-color-dark', () => this._updateColors()));

                // System Theme
                track(this._interfaceSettings, this._interfaceSettings.connect('changed::color-scheme', () => this._updateColors()));
            }

            this._updateVisibility();
            this._updateColors();
            this._updateEffects();

        } else {
            log("Wallpaper disabling manager");
            this._cleanupFeatures();
        }
    }

    _cleanupFeatures() {
        if (this._featureSignals) {
            this._featureSignals.forEach(sig => {
                try { sig.obj.disconnect(sig.id); } catch(e) {}
            });
            this._featureSignals = null;
        }
        this._removeEffects();
    }

    _updateVisibility() {
        const show = this.getSettings().get_boolean('wallpaper-show-image');
        const currentOption = this._bgSettings.get_string('picture-options');
        
        if (!show) {
            if (currentOption !== 'none') {
                this.getSettings().set_string('wallpaper-restore-options', currentOption);
                this._bgSettings.set_string('picture-options', 'none');
            }
        } else {
            if (currentOption === 'none') {
                let restore = this.getSettings().get_string('wallpaper-restore-options');
                if (!restore || restore === 'none') restore = 'zoom';
                this._bgSettings.set_string('picture-options', restore);
            }
        }
    }

    /**
     * Logic for Colors:
     * - Determines active mode (Light/Dark)
     * - Pushes the corresponding stored color to the System key
     */
    _updateColors() {
        const s = this.getSettings();
        const colorScheme = this._interfaceSettings.get_string('color-scheme');
        const isDark = colorScheme === 'prefer-dark';

        let targetPrimary, targetSecondary;

        if (isDark) {
            targetPrimary = s.get_string('wallpaper-primary-color-dark');
            targetSecondary = s.get_string('wallpaper-secondary-color-dark');
        } else {
            targetPrimary = s.get_string('wallpaper-primary-color-light');
            targetSecondary = s.get_string('wallpaper-secondary-color-light');
        }

        // Apply to system if valid
        if (targetPrimary) this._bgSettings.set_string('primary-color', targetPrimary);
        if (targetSecondary) this._bgSettings.set_string('secondary-color', targetSecondary);
    }

    _updateEffects() {
        const s = this.getSettings();
        const mono = s.get_boolean('wallpaper-monochrome');
        const blurSigma = s.get_int('wallpaper-blur-sigma');
        const brightness = s.get_double('wallpaper-brightness');

        const layoutManager = Main.layoutManager;
        const bgGroup = layoutManager._backgroundGroup;
        if (!bgGroup) return;

        bgGroup.get_children().forEach(actor => {
            // Monochrome
            const monoName = 'lesion-mono';
            if (mono) {
                if (!actor.get_effect(monoName)) {
                    actor.add_effect_with_name(monoName, new Clutter.DesaturateEffect({ factor: 1.0 }));
                }
            } else {
                actor.remove_effect_by_name(monoName);
            }

            // Blur
            // FIX: use Shell.BlurEffect (same as PanelsManager). The legacy
            // Clutter.BlurEffect has no sigma control and is not reliable on
            // GNOME 46+; Shell.BlurEffect uses 'radius' (= sigma * 2).
            const blurName = 'lesion-blur';
            if (blurSigma > 0) {
                let effect = actor.get_effect(blurName);
                if (!effect) {
                    effect = new Shell.BlurEffect({
                        brightness: 1.0,
                        mode: Shell.BlurMode.ACTOR
                    });
                    actor.add_effect_with_name(blurName, effect);
                }
                effect.radius = blurSigma * 2;
            } else {
                actor.remove_effect_by_name(blurName);
            }

            // Brightness
            const brightName = 'lesion-bright';
            if (Math.abs(brightness - 1.0) > 0.01) {
                let effect = actor.get_effect(brightName);
                if (!effect) {
                    effect = new Clutter.BrightnessContrastEffect();
                    actor.add_effect_with_name(brightName, effect);
                }
                effect.set_brightness(brightness - 1.0);
            } else {
                actor.remove_effect_by_name(brightName);
            }
        });
    }

    _removeEffects() {
        const layoutManager = Main.layoutManager;
        const bgGroup = layoutManager._backgroundGroup;
        if (!bgGroup) return;
        bgGroup.get_children().forEach(actor => {
            actor.remove_effect_by_name('lesion-mono');
            actor.remove_effect_by_name('lesion-blur');
            actor.remove_effect_by_name('lesion-bright');
        });
    }

    _backupWallpaper() {
        try {
            const backupPath = this._getBackupPath();
            // Migration: honor a backup left behind by older versions
            if (!GLib.file_test(backupPath, GLib.FileTest.EXISTS) &&
                GLib.file_test(this._getLegacyBackupPath(), GLib.FileTest.EXISTS)) {
                try {
                    const legacy = Gio.File.new_for_path(this._getLegacyBackupPath());
                    legacy.copy(Gio.File.new_for_path(backupPath), Gio.FileCopyFlags.NONE, null, null);
                    legacy.delete(null);
                } catch (e) {}
            }
            if (!GLib.file_test(backupPath, GLib.FileTest.EXISTS)) {
                const backupData = {
                    'picture-uri': this._bgSettings.get_string('picture-uri'),
                    'picture-uri-dark': this._bgSettings.get_string('picture-uri-dark'),
                    'primary-color': this._bgSettings.get_string('primary-color'),
                    'secondary-color': this._bgSettings.get_string('secondary-color'),
                    'picture-options': this._bgSettings.get_string('picture-options')
                };
                const jsonString = JSON.stringify(backupData, null, 2);
                const file = Gio.File.new_for_path(backupPath);
                file.replace_contents(jsonString, null, false, Gio.FileCreateFlags.NONE, null);
                log("Wallpaper config backed up.");
            }
        } catch (e) { logError("Failed to backup wallpaper", e); }
    }

    _restoreWallpaper() {
        try {
            const backupPath = this._getBackupPath();
            const file = Gio.File.new_for_path(backupPath);
            if (file.query_exists(null)) {
                const [success, contents] = file.load_contents(null);
                if (success) {
                    const decoder = new TextDecoder('utf-8');
                    const backupData = JSON.parse(decoder.decode(contents));
                    if (backupData['picture-uri']) this._bgSettings.set_string('picture-uri', backupData['picture-uri']);
                    if (backupData['picture-uri-dark']) this._bgSettings.set_string('picture-uri-dark', backupData['picture-uri-dark']);
                    if (backupData['primary-color']) this._bgSettings.set_string('primary-color', backupData['primary-color']);
                    if (backupData['secondary-color']) this._bgSettings.set_string('secondary-color', backupData['secondary-color']);
                    if (backupData['picture-options']) this._bgSettings.set_string('picture-options', backupData['picture-options']);
                    log("Wallpaper config restored.");
                    file.delete(null);
                }
            }
        } catch (e) {}
    }
}
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { log, logError } from '../util/logger.js';
import { ExtensionComponent } from './base.js';

/**
 * Ownership model
 * ---------------
 * Everything this component pushes into 'org.gnome.desktop.background' has a
 * counterpart key in the extension schema, so the extension's own choice is
 * never stored *only* in the system keys:
 *
 *   wallpaper-image-light/-dark      -> picture-uri / picture-uri-dark
 *   wallpaper-primary-color-light... -> primary-color / secondary-color
 *
 * Both directions converge by value comparison: a push makes system == ext, so
 * the adopt handler no-ops; an external change (GNOME Settings) makes them
 * differ, so the extension adopts it instead of fighting it on the next login.
 *
 * The original, pre-extension state is captured once into a backup file and is
 * put back ONLY when the user turns 'wallpaper-enabled' off. It is deliberately
 * NOT restored from onDisable(): disable() also runs on screen lock and on
 * session teardown, where restoring silently reverted the user's wallpaper (and
 * deleted the backup) at unpredictable moments.
 */
export class WallpaperManager extends ExtensionComponent {

    onEnable() {
        this.backupFile = 'backup.wallpaper.v1.json';
        this._bgSettings = new Gio.Settings({ schema_id: 'org.gnome.desktop.background' });
        this._interfaceSettings = new Gio.Settings({ schema_id: 'org.gnome.desktop.interface' });

        // FIX: background actors are recreated on monitor changes and
        // wallpaper switches, silently dropping the effects. Reapply then.
        this._monitorsChangedId = Main.layoutManager.connect('monitors-changed', () => {
            if (this.getSettings().get_boolean('wallpaper-enabled'))
                this._scheduleEffects();
        });

        this.observe('changed::wallpaper-enabled', () => this._onMasterToggled());

        if (this.getSettings().get_boolean('wallpaper-enabled'))
            this._activate();
    }

    /**
     * Teardown only. The desktop is left exactly as the user currently sees it;
     * see the ownership note above for why nothing is restored here.
     */
    onDisable() {
        if (this._monitorsChangedId) {
            Main.layoutManager.disconnect(this._monitorsChangedId);
            this._monitorsChangedId = 0;
        }
        this._deactivate();
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
        const dir = GLib.build_filenamev([GLib.get_user_state_dir(), 'hornbill']);
        GLib.mkdir_with_parents(dir, 0o755);
        return GLib.build_filenamev([dir, this.backupFile]);
    }

    /**
     * Backups written under earlier names, newest first.
     *
     * The state directory is derived from the project name, so the rename to
     * Hornbill would have orphaned the pre-extension wallpaper: turning the
     * master switch off would restore nothing, silently. The extension-relative
     * path is the older location still, from before backups moved out of the
     * extension directory.
     */
    _getLegacyBackupPaths() {
        return [
            // HISTORICAL VALUE — do not update to 'hornbill'. This is where
            // the pre-rename backup actually sits on disk; changing it points
            // the migration at a directory that has never existed.
            GLib.build_filenamev([GLib.get_user_state_dir(), 'lesion', this.backupFile]),
            GLib.build_filenamev([this._extension.path, this.backupFile]),
        ];
    }

    /**
     * Seed the extension's own storage from the system the first time a key is
     * unset, so the preferences rows show what is actually on screen rather
     * than "No image set".
     */
    _initFromSystem() {
        const s = this.getSettings();

        const seed = (extKey, sysKey) => {
            if (s.get_string(extKey) === '')
                s.set_string(extKey, this._bgSettings.get_string(sysKey));
        };

        seed('wallpaper-image-light', 'picture-uri');
        seed('wallpaper-image-dark', 'picture-uri-dark');
        seed('wallpaper-primary-color-light', 'primary-color');
        seed('wallpaper-secondary-color-light', 'secondary-color');
        // The dark slots were never seeded, and their schema defaults were
        // real colours rather than empty, so _updateColors() pushed #000000
        // over the system colours the first time a dark-mode user enabled the
        // component — without anyone having chosen black.
        seed('wallpaper-primary-color-dark', 'primary-color');
        seed('wallpaper-secondary-color-dark', 'secondary-color');
    }

    _onMasterToggled() {
        if (this.getSettings().get_boolean('wallpaper-enabled')) {
            this._activate();
        } else {
            this._deactivate();
            // Turning the master switch off is the one explicit, visible opt-out,
            // so it is the only place the pre-extension desktop is put back.
            this._restoreWallpaper();
        }
    }

    _activate() {
        if (this._featureSignals) return;

        log("[Wallpaper] enabling manager");
        this._backupWallpaper();
        this._initFromSystem();

        this._featureSignals = [];
        const s = this.getSettings();
        const track = (obj, id) => this._featureSignals.push({ obj, id });

        // Visibility & Effects
        track(s, s.connect('changed::wallpaper-show-image', () => this._updateVisibility()));
        track(s, s.connect('changed::wallpaper-monochrome', () => this._updateEffects()));
        track(s, s.connect('changed::wallpaper-blur-sigma', () => this._updateEffects()));
        track(s, s.connect('changed::wallpaper-brightness', () => this._updateEffects()));

        // Images - Watch BOTH Light and Dark storage keys
        track(s, s.connect('changed::wallpaper-image-light', () => this._updateImages()));
        track(s, s.connect('changed::wallpaper-image-dark', () => this._updateImages()));

        // Colors - Watch BOTH Light and Dark storage keys
        track(s, s.connect('changed::wallpaper-primary-color-light', () => this._updateColors()));
        track(s, s.connect('changed::wallpaper-secondary-color-light', () => this._updateColors()));
        track(s, s.connect('changed::wallpaper-primary-color-dark', () => this._updateColors()));
        track(s, s.connect('changed::wallpaper-secondary-color-dark', () => this._updateColors()));

        // System Theme
        track(this._interfaceSettings, this._interfaceSettings.connect('changed::color-scheme', () => {
            this._updateImages();
            this._updateColors();
        }));

        // THE OTHER HALF OF THE COMMENT ABOVE. Monitor changes were handled;
        // wallpaper switches were not, and they are the common case. Changing
        // picture-uri makes GNOME tear down the background actors and build
        // new ones, so effects applied to the old actors vanish with them.
        //
        // This is what made presets look broken. _applyPreset() writes the
        // image first and the effect keys last, so 'wallpaper-monochrome' was
        // set — the switch correctly showed ON — and _updateEffects() ran
        // against actors that were already on their way out. Toggling the
        // switch by hand worked only because by then the new actors existed.
        const bgGroup = Main.layoutManager._backgroundGroup;
        if (bgGroup)
            track(bgGroup, bgGroup.connect('child-added', () => this._scheduleEffects()));

        // Adopt changes made outside the extension (GNOME Settings, another
        // wallpaper tool) instead of overwriting them on the next enable.
        track(this._bgSettings, this._bgSettings.connect('changed::picture-uri',
            () => this._adoptSystemImage('picture-uri', 'wallpaper-image-light')));
        track(this._bgSettings, this._bgSettings.connect('changed::picture-uri-dark',
            () => this._adoptSystemImage('picture-uri-dark', 'wallpaper-image-dark')));
        track(this._bgSettings, this._bgSettings.connect('changed::primary-color',
            () => this._adoptSystemColor('primary-color', 'wallpaper-primary-color')));
        track(this._bgSettings, this._bgSettings.connect('changed::secondary-color',
            () => this._adoptSystemColor('secondary-color', 'wallpaper-secondary-color')));

        this._updateVisibility();
        this._updateImages();
        this._updateColors();
        this._updateEffects();
    }

    /**
     * A rebuild adds one actor per monitor, and a crossfade adds one before
     * removing the old, so 'child-added' can fire several times for a single
     * wallpaper change. Coalesce into one pass.
     */
    _scheduleEffects() {
        if (this._effectsPending) return;
        this._effectsPending = true;
        this.idleOnce(() => {
            this._effectsPending = false;
            if (this.getSettings().get_boolean('wallpaper-enabled'))
                this._updateEffects();
        });
    }

    _deactivate() {
        if (this._featureSignals) {
            log("[Wallpaper] disabling manager");
            this._featureSignals.forEach(sig => {
                try { sig.obj.disconnect(sig.id); } catch (e) { log('_deactivate: disconnect() failed', e); }
            });
            this._featureSignals = null;
        }
        this._effectsPending = false;
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
     * Push the stored image URIs to the system keys. Empty means "never set",
     * in which case whatever the system already holds is left alone.
     */
    _updateImages() {
        const s = this.getSettings();

        const push = (extKey, sysKey) => {
            const uri = s.get_string(extKey);
            if (uri && this._bgSettings.get_string(sysKey) !== uri)
                this._bgSettings.set_string(sysKey, uri);
        };

        push('wallpaper-image-light', 'picture-uri');
        push('wallpaper-image-dark', 'picture-uri-dark');
    }

    /**
     * Logic for Colors:
     * - Determines active mode (Light/Dark)
     * - Pushes the corresponding stored color to the System key
     */
    _updateColors() {
        const s = this.getSettings();
        const suffix = this._isDark() ? 'dark' : 'light';

        const targetPrimary = s.get_string(`wallpaper-primary-color-${suffix}`);
        const targetSecondary = s.get_string(`wallpaper-secondary-color-${suffix}`);

        // Apply to system if valid
        if (targetPrimary && this._bgSettings.get_string('primary-color') !== targetPrimary)
            this._bgSettings.set_string('primary-color', targetPrimary);
        if (targetSecondary && this._bgSettings.get_string('secondary-color') !== targetSecondary)
            this._bgSettings.set_string('secondary-color', targetSecondary);
    }

    _isDark() {
        return this._interfaceSettings.get_string('color-scheme') === 'prefer-dark';
    }

    /**
     * Mirror an externally-made image change back into extension storage.
     * No re-entrancy flag is needed: _updateImages() only writes when the two
     * differ, so after any push the values match and this is a no-op.
     */
    _adoptSystemImage(sysKey, extKey) {
        const uri = this._bgSettings.get_string(sysKey);
        const s = this.getSettings();
        if (uri && s.get_string(extKey) !== uri) {
            log(`[Wallpaper] adopting external ${sysKey}`);
            s.set_string(extKey, uri);
        }
    }

    /** As _adoptSystemImage(), but routed to the light or dark colour slot. */
    _adoptSystemColor(sysKey, extPrefix) {
        const value = this._bgSettings.get_string(sysKey);
        const extKey = `${extPrefix}-${this._isDark() ? 'dark' : 'light'}`;
        const s = this.getSettings();
        if (value && s.get_string(extKey) !== value)
            s.set_string(extKey, value);
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
            const monoName = 'hornbill-mono';
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
            const blurName = 'hornbill-blur';
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
            const brightName = 'hornbill-bright';
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
            actor.remove_effect_by_name('hornbill-mono');
            actor.remove_effect_by_name('hornbill-blur');
            actor.remove_effect_by_name('hornbill-bright');
        });
    }

    _backupWallpaper() {
        try {
            const backupPath = this._getBackupPath();
            // Migration: honour a backup left behind under an earlier name
            if (!GLib.file_test(backupPath, GLib.FileTest.EXISTS)) {
                for (const legacyPath of this._getLegacyBackupPaths()) {
                    if (!GLib.file_test(legacyPath, GLib.FileTest.EXISTS)) continue;
                    try {
                        const legacy = Gio.File.new_for_path(legacyPath);
                        legacy.copy(Gio.File.new_for_path(backupPath), Gio.FileCopyFlags.NONE, null, null);
                        legacy.delete(null);
                        log(`[Wallpaper] migrated backup from ${legacyPath}`);
                        break;
                    } catch (e) { logError('[Wallpaper] backup migration failed', e); }
                }
            }
            if (!GLib.file_test(backupPath, GLib.FileTest.EXISTS)) {
                const backupData = {
                    'picture-uri': this._bgSettings.get_string('picture-uri'),
                    'picture-uri-dark': this._bgSettings.get_string('picture-uri-dark'),
                    'primary-color': this._bgSettings.get_string('primary-color'),
                    'secondary-color': this._bgSettings.get_string('secondary-color'),
                    'picture-options': this._bgSettings.get_string('picture-options'),
                    // Presets change this too, so leaving it out meant the
                    // master-switch opt-out could not fully undo them.
                    'color-shading-type': this._bgSettings.get_string('color-shading-type')
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
                    // Absent in files written before this key was captured;
                    // the guard makes older backups load unchanged.
                    if (backupData['color-shading-type']) this._bgSettings.set_string('color-shading-type', backupData['color-shading-type']);
                    // set_string() hands the write to dconf-service over D-Bus;
                    // flush it before the file that would let us retry is gone.
                    Gio.Settings.sync();
                    log("Wallpaper config restored.");
                    file.delete(null);
                }
            }
        } catch (e) { logError('[Wallpaper] restore failed', e); }
    }
}

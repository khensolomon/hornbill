import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

import { AppConfig } from '../config.js';
import { SettingsManager } from '../util/io.js';
import { listCategories, labelFor, coverage } from '../util/categories.js';
import { gettext as _, N_ } from '../util/gettext.js';

export class DashboardPage extends Adw.PreferencesPage {
    static {
        GObject.registerClass(this);
    }

    constructor(navigator, goToPage) {
        super();
        
        this.navigator = navigator;
        this.goToPage = goToPage;
        
        // State management
        this._settings = AppConfig.getSettings();
        this._activeDialog = null; // Track active file chooser to prevent duplicates

        this._buildUI();
    }

    _buildUI() {
        // Identity/hero content lives on the About page; the dashboard is a
        // pure action hub (indicator, quick navigation, data management).

        // --- 1. GLOBAL INDICATOR SETTINGS ---
        const indicatorGroup = new Adw.PreferencesGroup({
            title: _('Panel Indicator'),
            description: _('Control the main menu icon in the top bar')
        });
        this.add(indicatorGroup);

        const indEnableRow = new Adw.SwitchRow({
            title: _('Show Indicator'),
            subtitle: _('Toggle visibility')
        });
        this._settings.bind('indicator-enabled', indEnableRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        indicatorGroup.add(indEnableRow);

        const iconRow = this._createIconSelector();
        this._settings.bind('indicator-enabled', iconRow, 'sensitive', Gio.SettingsBindFlags.GET);
        indicatorGroup.add(iconRow);

        // --- 3. FEATURE SHORTCUTS ---
        const navGroup = new Adw.PreferencesGroup({
            title: _('Features'),
            description: _('Quick access to core modules')
        });
        this.add(navGroup);

        navGroup.add(this._createNavRow(N_('Wallpaper Engine'), 'Manage dual-mode backgrounds', 'preferences-desktop-wallpaper-symbolic', 'wallpaper'));
        navGroup.add(this._createNavRow(N_('Stylesheet'), 'Hand-edit custom CSS', 'text-x-generic-symbolic', 'stylesheet'));
        navGroup.add(this._createNavRow(N_('Panel Layout'), 'Arrange panel items and their styling', 'view-grid-symbolic', 'panel-layout'));
        navGroup.add(this._createNavRow(N_('Panel Appearance'), 'Panel colors, borders, and presets', 'preferences-desktop-appearance-symbolic', 'panel-appearance'));
        navGroup.add(this._createNavRow(N_('Window Effects'), 'Rounding, shadows, and transparency', 'focus-windows-symbolic', 'window-effects'));
        navGroup.add(this._createNavRow(N_('Window Geometry'), 'Remember and restore window size and position', 'video-single-display-symbolic', 'window-geometry'));

        // --- 4. DATA MANAGEMENT ---
        const dataGroup = new Adw.PreferencesGroup({
            title: _('Data Management'),
            description: _('Backup or restore your configuration')
        });
        this.add(dataGroup);

        // Export Row
        const exportRow = new Adw.ActionRow({
            title: _('Export Configuration'),
            subtitle: _('Save settings to a JSON file')
        });
        const exportBtn = new Gtk.Button({
            icon_name: 'document-save-symbolic',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat']
        });
        exportBtn.connect('clicked', () => this._handleExport(exportBtn));
        exportRow.add_suffix(exportBtn);
        dataGroup.add(exportRow);

        // Import Row
        const importRow = new Adw.ActionRow({
            title: _('Import Configuration'),
            subtitle: _('Restore settings from a JSON file')
        });
        const importBtn = new Gtk.Button({
            icon_name: 'document-open-symbolic',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat']
        });
        importBtn.connect('clicked', () => this._handleImport(importBtn));
        importRow.add_suffix(importBtn);
        dataGroup.add(importRow);

        // Reset Row — scoped like the other two (the Appearance and Tooltips
        // pages keep their own narrower reset buttons)
        const resetRow = new Adw.ActionRow({
            title: _('Reset Settings'),
            subtitle: _('Restore the selected groups to their default values')
        });
        const resetBtn = new Gtk.Button({
            icon_name: 'view-refresh-symbolic', // built-in Adwaita icon
            valign: Gtk.Align.CENTER,
            tooltip_text: _('Reset Settings'),
            css_classes: ['flat', 'destructive-action']
        });
        resetBtn.connect('clicked', () => this._confirmReset());
        resetRow.add_suffix(resetBtn);
        dataGroup.add(resetRow);

        dataGroup.add(this._createScopeRow());
    }

    // --- SCOPE ---

    /**
     * ONE scope for all three actions rather than three separate ones. Three
     * would be more precise and much easier to get wrong: the value you last
     * set for an export is not the value you want a reset to use, and nothing
     * on screen would tell you which was in play. With one visible list, every
     * confirmation can name exactly what it is about to touch.
     */
    _createScopeRow() {
        const expander = new Adw.ExpanderRow({
            title: _('Included Data'),
            subtitle: _('Applies to Export, Import and Reset')
        });
        this._scopeExpander = expander;

        const allKeys = this._settings.settings_schema.list_keys();
        listCategories(allKeys).forEach(cat => {
            const row = new Adw.SwitchRow({
                title: _(cat.label),
                // The count is shown so coverage is verifiable rather than
                // taken on trust: the per-group numbers add up to the schema
                // total, and anything unaccounted for surfaces as 'Other'.
                subtitle: `${_(cat.blurb)} \u00b7 ${cat.keyCount} ${_('settings')}`,
                active: !this._excludedIds().includes(cat.id),
            });
            row.connect('notify::active', () => this._setIncluded(cat.id, row.active));
            expander.add_row(row);
        });

        this._updateScopeSubtitle();
        return expander;
    }

    _excludedIds() {
        try { return this._settings.get_strv('data-scope-excluded'); }
        catch (e) { return []; }
    }

    _setIncluded(id, included) {
        const set = new Set(this._excludedIds());
        if (included) set.delete(id); else set.add(id);
        this._settings.set_strv('data-scope-excluded', [...set]);
        this._updateScopeSubtitle();
    }

    _updateScopeSubtitle() {
        if (!this._scopeExpander) return;
        const allKeys = this._settings.settings_schema.list_keys();
        const excluded = new Set(this._excludedIds());
        const cats = listCategories(allKeys);
        const selected = cats.filter(c => !excluded.has(c.id));
        const inScope = selected.reduce((n, c) => n + c.keyCount, 0);
        const { grouped } = coverage(allKeys);

        this._scopeExpander.set_subtitle(
            `${inScope}/${grouped} ${_('settings in')} ${selected.length}/${cats.length} ${_('groups')}`
        );
    }

    /** Human-readable list of what is in scope, for confirmation dialogs. */
    _scopeSummary() {
        const excluded = new Set(this._excludedIds());
        const names = listCategories(this._settings.settings_schema.list_keys())
            .filter(c => !excluded.has(c.id))
            .map(c => _(c.label));
        return names.length === 0 ? _('nothing') : names.join(', ');
    }

    // --- HELPER COMPONENTS ---

    _createNavRow(title, desc, icon, targetId) {
        const row = new Adw.ActionRow({
            title: _(title),
            subtitle: _(desc),
            activatable: true
        });
        const img = new Gtk.Image({ icon_name: icon });
        row.add_prefix(img);
        row.add_suffix(new Gtk.Image({ icon_name: 'go-next-symbolic' }));
        
        row.connect('activated', () => {
            if (this.goToPage) this.goToPage(targetId);
        });
        return row;
    }

    _createIconSelector() {
        const row = new Adw.ActionRow({
            title: _('Custom Icon'),
            subtitle: _('Default')
        });

        const previewIcon = new Gtk.Image({
            pixel_size: 24,
            icon_name: 'image-x-generic-symbolic'
        });
        row.add_prefix(previewIcon);

        const updateUi = () => {
            const path = this._settings.get_string('indicator-custom-icon');
            
            if (path && path.length > 0) {
                try {
                    const file = Gio.File.new_for_path(path);
                    row.set_subtitle(file.get_basename());
                    const gicon = new Gio.FileIcon({ file: file });
                    previewIcon.set_from_gicon(gicon);
                } catch (e) {
                    row.set_subtitle('Invalid Path');
                    previewIcon.set_from_icon_name('dialog-error-symbolic');
                }
            } else {
                row.set_subtitle('Default');
                const defaultPath = GLib.build_filenamev([AppConfig.path, 'icon', 'hornbill-symbolic.svg']);
                if (GLib.file_test(defaultPath, GLib.FileTest.EXISTS)) {
                    const gicon = Gio.icon_new_for_string(defaultPath);
                    previewIcon.set_from_gicon(gicon);
                } else {
                    previewIcon.set_from_icon_name('emblem-photos-symbolic');
                }
            }
        };

        // Listen for external changes
        this._settings.connect('changed::indicator-custom-icon', updateUi);
        updateUi();

        const box = new Gtk.Box({ spacing: 6, valign: Gtk.Align.CENTER });
        row.add_suffix(box);

        const resetBtn = new Gtk.Button({
            icon_name: 'view-refresh-symbolic', 
            tooltip_text: _('Reset to Default'),
            css_classes: ['flat']
        });
        resetBtn.connect('clicked', () => {
            this._settings.set_string('indicator-custom-icon', '');
        });
        box.append(resetBtn);

        const folderBtn = new Gtk.Button({
            icon_name: 'folder-open-symbolic',
            css_classes: ['flat'],
            tooltip_text: _('Select File')
        });
        
        folderBtn.connect('clicked', () => this._handleIconSelection(folderBtn));
        box.append(folderBtn);

        return row;
    }

    _handleIconSelection(parentBtn) {
        if (this._activeDialog) {
            this._activeDialog.present();
            return;
        }

        const dialog = new Gtk.FileChooserNative({
            title: _('Select Panel Icon'),
            action: Gtk.FileChooserAction.OPEN,
            transient_for: parentBtn.get_root(),
            modal: true
        });

        const filter = new Gtk.FileFilter();
        filter.set_name("Images");
        filter.add_mime_type("image/svg+xml");
        filter.add_mime_type("image/png");
        dialog.add_filter(filter);

        this._activeDialog = dialog;

        dialog.connect('response', (d, response) => {
            try {
                if (response === Gtk.ResponseType.ACCEPT) {
                    const file = d.get_file();
                    const path = file.get_path();
                    if (path) {
                        this._settings.set_string('indicator-custom-icon', path);
                    }
                }
            } finally {
                d.destroy();
                this._activeDialog = null;
            }
        });

        dialog.show();
    }

    // --- IO HANDLERS ---

    _handleExport(button) {
        if (this._activeDialog) {
            this._activeDialog.present();
            return;
        }

        const dialog = new Gtk.FileChooserNative({
            title: _('Export Settings'),
            action: Gtk.FileChooserAction.SAVE,
            transient_for: button.get_root(),
            modal: true
        });

        const dateStr = new Date().toISOString().slice(0,10);
        dialog.set_current_name(`hornbill-config-${dateStr}.json`);

        const filter = new Gtk.FileFilter();
        filter.set_name("JSON Config");
        filter.add_pattern("*.json");
        dialog.add_filter(filter);

        this._activeDialog = dialog;

        dialog.connect('response', (d, response) => {
            try {
                if (response === Gtk.ResponseType.ACCEPT) {
                    const file = d.get_file();
                    const jsonString = SettingsManager.exportSettings(this._excludedIds());
                    
                    if (jsonString) {
                        // Use GLib.Bytes + replace_contents (Sync) for reliability with small config files.
                        // Async writes inside a dialog callback can fail if the dialog is destroyed too early.
                        const bytes = new GLib.Bytes(new TextEncoder().encode(jsonString));
                        file.replace_contents(bytes.toArray(), null, false, Gio.FileCreateFlags.NONE, null);
                        
                        // Visual feedback (optional, printed to logs)
                        // console.log("Export successful to " + file.get_path());
                    }
                }
            } catch (error) {
                console.error("Export failed:", error);
                const errDialog = new Adw.MessageDialog({
                    heading: _("Export Failed"),
                    body: error.message,
                    transient_for: button.get_root()
                });
                errDialog.add_response("ok", _("OK"));
                errDialog.present();
            } finally {
                d.destroy();
                this._activeDialog = null;
            }
        });

        dialog.show();
    }

    _handleImport(button) {
        if (this._activeDialog) {
            this._activeDialog.present();
            return;
        }

        const dialog = new Gtk.FileChooserNative({
            title: _('Import Settings'),
            action: Gtk.FileChooserAction.OPEN,
            transient_for: button.get_root(),
            modal: true
        });

        const filter = new Gtk.FileFilter();
        filter.set_name("JSON Config");
        filter.add_pattern("*.json");
        dialog.add_filter(filter);

        this._activeDialog = dialog;

        dialog.connect('response', (d, response) => {
            try {
                if (response === Gtk.ResponseType.ACCEPT) {
                    const file = d.get_file();
                    
                    // Load synchronously for safety in this context
                    const [success, contents] = file.load_contents(null);
                    
                    if (success) {
                        const decoder = new TextDecoder('utf-8');
                        // contents is typically a Uint8Array (GBytes)
                        const jsonStr = decoder.decode(contents);

                        // Inspect before applying: import overwrites live
                        // settings and used to do it with no prompt at all,
                        // which made it the most destructive action here and
                        // the only one without a confirmation.
                        const info = SettingsManager.inspectSettings(jsonStr);
                        if (!info.success) throw new Error(info.message);

                        this._confirmImport(button, jsonStr, info);
                    }
                }
            } catch (error) {
                console.error("Import failed:", error);
                const errDialog = new Adw.MessageDialog({
                    heading: _("Import Failed"),
                    body: error.message,
                    transient_for: button.get_root()
                });
                errDialog.add_response("ok", _("OK"));
                errDialog.present();
            } finally {
                d.destroy();
                this._activeDialog = null;
            }
        });

        dialog.show();
    }

    /**
     * Names the groups the file actually contains, intersected with the
     * current scope, so "nothing happened" is never a mystery: a file with no
     * clock keys cannot restore the clock however the scope is set.
     */
    _confirmImport(button, jsonStr, info) {
        const excluded = new Set(this._excludedIds());
        const willApply = info.categories.filter(id => !excluded.has(id)).map(id => _(labelFor(id)));
        const skipped = info.categories.filter(id => excluded.has(id)).map(id => _(labelFor(id)));

        let body = willApply.length
            ? `${_('These groups will be overwritten with the values in the file:')}\n\n${willApply.join(', ')}`
            : _('Nothing in this file falls inside the current scope, so nothing would change.');

        if (skipped.length)
            body += `\n\n${_('Present in the file but excluded by your scope:')} ${skipped.join(', ')}`;

        const dialog = new Adw.AlertDialog({
            heading: _('Import Configuration?'),
            body,
        });
        dialog.add_response('cancel', _('Cancel'));
        if (willApply.length) {
            dialog.add_response('import', _('Import'));
            dialog.set_response_appearance('import', Adw.ResponseAppearance.DESTRUCTIVE);
        }
        dialog.set_default_response('cancel');
        dialog.set_close_response('cancel');

        dialog.connect('response', (d, response) => {
            if (response !== 'import') return;
            const result = SettingsManager.importSettings(jsonStr, this._excludedIds());
            if (!result.success) {
                const errDialog = new Adw.AlertDialog({
                    heading: _('Import Failed'),
                    body: result.message,
                });
                errDialog.add_response('ok', _('OK'));
                errDialog.present(this.get_root());
            }
        });

        dialog.present(this.get_root());
    }

    _confirmReset() {
        const summary = this._scopeSummary();
        const excluded = this._excludedIds();

        const dialog = new Adw.AlertDialog({
            heading: _('Reset Settings?'),
            body: excluded.length === 0
                ? `${_('Every Hornbill setting will return to its default value. Exported backups are not affected.')}`
                : `${_('These groups will return to their default values:')}\n\n${summary}\n\n${_('Everything else is left untouched.')}`,
        });
        dialog.add_response('cancel', _('Cancel'));
        dialog.add_response('reset', excluded.length === 0 ? _('Reset Everything') : _('Reset Selected'));
        dialog.set_response_appearance('reset', Adw.ResponseAppearance.DESTRUCTIVE);
        dialog.set_default_response('cancel');
        dialog.set_close_response('cancel');

        dialog.connect('response', (d, response) => {
            if (response !== 'reset') return;
            SettingsManager.resetSettings(this._excludedIds());
        });

        dialog.present(this.get_root());
    }
}

export function createDashboardUI(navigator, goToPage) {
    return new DashboardPage(navigator, goToPage);
}
import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

import { AppConfig } from '../config.js';
import { SettingsManager } from '../util/io.js';

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
            title: 'Panel Indicator',
            description: 'Control the main menu icon in the top bar'
        });
        this.add(indicatorGroup);

        const indEnableRow = new Adw.SwitchRow({
            title: 'Show Indicator',
            subtitle: 'Toggle visibility'
        });
        this._settings.bind('indicator-enabled', indEnableRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        indicatorGroup.add(indEnableRow);

        const iconRow = this._createIconSelector();
        this._settings.bind('indicator-enabled', iconRow, 'sensitive', Gio.SettingsBindFlags.DEFAULT);
        indicatorGroup.add(iconRow);

        // --- 3. FEATURE SHORTCUTS ---
        const navGroup = new Adw.PreferencesGroup({
            title: 'Features',
            description: 'Quick access to core modules'
        });
        this.add(navGroup);

        navGroup.add(this._createNavRow('Wallpaper Engine', 'Manage dual-mode backgrounds', 'preferences-desktop-wallpaper-symbolic', 'wallpaper'));
        navGroup.add(this._createNavRow('Stylesheet', 'Hand-edit custom CSS', 'text-x-generic-symbolic', 'stylesheet'));
        navGroup.add(this._createNavRow('Panel Layout', 'Arrange panel items and their styling', 'view-grid-symbolic', 'panel-layout'));
        navGroup.add(this._createNavRow('Panel Appearance', 'Panel colors, borders, and presets', 'preferences-desktop-appearance-symbolic', 'panel-appearance'));
        navGroup.add(this._createNavRow('Window Effects', 'Rounding, shadows, and transparency', 'focus-windows-symbolic', 'window-effects'));
        navGroup.add(this._createNavRow('Window Geometry', 'Remember and restore window size and position', 'video-single-display-symbolic', 'window-geometry'));

        // --- 4. DATA MANAGEMENT ---
        const dataGroup = new Adw.PreferencesGroup({
            title: 'Data Management',
            description: 'Backup or restore your configuration'
        });
        this.add(dataGroup);

        // Export Row
        const exportRow = new Adw.ActionRow({
            title: 'Export Configuration',
            subtitle: 'Save settings to a JSON file'
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
            title: 'Import Configuration',
            subtitle: 'Restore settings from a JSON file'
        });
        const importBtn = new Gtk.Button({
            icon_name: 'document-open-symbolic',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat']
        });
        importBtn.connect('clicked', () => this._handleImport(importBtn));
        importRow.add_suffix(importBtn);
        dataGroup.add(importRow);

        // Full Reset Row — resets EVERY key in the schema (the Style page's
        // "Reset Style" only covers styling)
        const resetRow = new Adw.ActionRow({
            title: 'Reset All Settings',
            subtitle: 'Restore every Lesion setting to its default value'
        });
        const resetBtn = new Gtk.Button({
            icon_name: 'view-refresh-symbolic', // built-in Adwaita icon
            valign: Gtk.Align.CENTER,
            tooltip_text: 'Reset All Settings',
            css_classes: ['flat', 'destructive-action']
        });
        resetBtn.connect('clicked', () => this._confirmFullReset());
        resetRow.add_suffix(resetBtn);
        dataGroup.add(resetRow);
    }

    // --- HELPER COMPONENTS ---

    _createNavRow(title, desc, icon, targetId) {
        const row = new Adw.ActionRow({
            title: title,
            subtitle: desc,
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
            title: 'Custom Icon',
            subtitle: 'Default'
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
            tooltip_text: 'Reset to Default',
            css_classes: ['flat']
        });
        resetBtn.connect('clicked', () => {
            this._settings.set_string('indicator-custom-icon', '');
        });
        box.append(resetBtn);

        const folderBtn = new Gtk.Button({
            icon_name: 'folder-open-symbolic',
            css_classes: ['flat'],
            tooltip_text: 'Select File'
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
            title: 'Select Panel Icon',
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
            title: 'Export Settings',
            action: Gtk.FileChooserAction.SAVE,
            transient_for: button.get_root(),
            modal: true
        });

        const dateStr = new Date().toISOString().slice(0,10);
        dialog.set_current_name(`lesion-config-${dateStr}.json`);

        const filter = new Gtk.FileFilter();
        filter.set_name("JSON Config");
        filter.add_pattern("*.json");
        dialog.add_filter(filter);

        this._activeDialog = dialog;

        dialog.connect('response', (d, response) => {
            try {
                if (response === Gtk.ResponseType.ACCEPT) {
                    const file = d.get_file();
                    const jsonString = SettingsManager.exportSettings();
                    
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
                    heading: "Export Failed",
                    body: error.message,
                    transient_for: button.get_root()
                });
                errDialog.add_response("ok", "OK");
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
            title: 'Import Settings',
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
                        const result = SettingsManager.importSettings(jsonStr);

                        if (!result.success) {
                            throw new Error(result.message);
                        }
                    }
                }
            } catch (error) {
                console.error("Import failed:", error);
                const errDialog = new Adw.MessageDialog({
                    heading: "Import Failed",
                    body: error.message,
                    transient_for: button.get_root()
                });
                errDialog.add_response("ok", "OK");
                errDialog.present();
            } finally {
                d.destroy();
                this._activeDialog = null;
            }
        });

        dialog.show();
    }

    _confirmFullReset() {
        const dialog = new Adw.AlertDialog({
            heading: 'Reset All Settings?',
            body: 'Every Lesion setting — style, clock, apps, geometry data, corners, transparency, wallpaper — will return to its default value. Exported backups are not affected.',
        });
        dialog.add_response('cancel', 'Cancel');
        dialog.add_response('reset', 'Reset Everything');
        dialog.set_response_appearance('reset', Adw.ResponseAppearance.DESTRUCTIVE);
        dialog.set_default_response('cancel');
        dialog.set_close_response('cancel');

        dialog.connect('response', (d, response) => {
            if (response !== 'reset') return;
            try {
                this._settings.delay();
                // Every key in the schema — future keys included automatically
                for (const key of this._settings.settings_schema.list_keys())
                    this._settings.reset(key);
                this._settings.apply();
            } catch (e) {
                console.error('Full reset failed', e);
            }
        });

        dialog.present(this.get_root());
    }
}

export function createDashboardUI(navigator, goToPage) {
    return new DashboardPage(navigator, goToPage);
}
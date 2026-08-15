import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';
import Gdk from 'gi://Gdk';
import GLib from 'gi://GLib';
import Cairo from 'cairo';
import { logError } from '../util/logger.js';
import { AppConfig } from '../config.js';
import { WallpaperPresets } from '../data/wallpaper.js';

// Global reference to prevent GC closing the dialog
let _activeWallpaperChooser = null;

export function createWallpaperUI() {
    const page = new Adw.PreferencesPage();

    try {
        // 1. Initialize Settings
        let bgSettings = null;
        let extSettings = null;

        try {
            bgSettings = new Gio.Settings({ schema_id: 'org.gnome.desktop.background' });
        } catch (e) {
            _addError(page, "Error: org.gnome.desktop.background schema missing", e);
            return page;
        }

        try {
            extSettings = AppConfig.getSettings();
        } catch (e) {
            _addError(page, "Extension Schema Error", e);
        }

        if (!extSettings) return page;

        // --- CSS Provider for Overlays ---
        const cssProvider = new Gtk.CssProvider();
        const cssContent = `
            .preset-overlay-box {
                background-color: rgba(0, 0, 0, 0.6);
                padding: 6px 12px;
                transition: background-color 200ms ease;
            }
            .preset-card:hover .preset-overlay-box {
                background-color: rgba(0, 0, 0, 0.4);
            }
            .preset-label {
                color: white;
                font-weight: bold;
                font-size: 0.9em;
                text-shadow: 0 1px 2px rgba(0,0,0,0.8);
            }
            .preset-card {
                padding: 0; 
                border: 1px solid rgba(0,0,0,0.08);
                border-radius: 12px;
                overflow: hidden;
                box-shadow: 0 2px 4px rgba(0,0,0,0.05);
                transition: all 200ms cubic-bezier(0.25, 0.46, 0.45, 0.94);
                transform: scale(1);
            }
            .preset-card:hover {
                border-color: rgba(0,0,0,0.2);
                box-shadow: 0 4px 12px rgba(0,0,0,0.15);
                transform: scale(1.02);
            }
            .preset-card:active {
                transform: scale(0.98);
                box-shadow: none;
                border-color: rgba(0,0,0,0.3);
            }
            /* Ensure the button's internal content node is also clipped if needed by the theme */
            .preset-card > * {
                border-radius: 12px;
                overflow: hidden;
            }
        `;

        try {
            if (typeof cssProvider.load_from_string === 'function') {
                cssProvider.load_from_string(cssContent);
            } else {
                cssProvider.load_from_data(cssContent, -1);
            }
        } catch (e) {
            try { cssProvider.load_from_data(cssContent, -1); } catch (err) { logError("CSS Provider Error", err); }
        }

        Gtk.StyleContext.add_provider_for_display(
            Gdk.Display.get_default(),
            cssProvider,
            Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION
        );

        // --- MASTER SWITCH ---
        const mainGroup = new Adw.PreferencesGroup();
        page.add(mainGroup);

        const enableRow = new Adw.SwitchRow({
            title: 'Enable Wallpaper Management',
            subtitle: 'Master switch for all wallpaper features'
        });
        extSettings.bind('wallpaper-enabled', enableRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        mainGroup.add(enableRow);

        // --- PRESETS SECTION (THUMBNAIL GRID) ---
        const presetGroup = new Adw.PreferencesGroup({
            title: 'Presets',
            description: 'Instantly apply a pre-configured theme with matching colors and effects.'
        });
        page.add(presetGroup);

        const flowBox = new Gtk.FlowBox({
            valign: Gtk.Align.START,
            homogeneous: true,
            min_children_per_line: 1, 
            max_children_per_line: 20, 
            selection_mode: Gtk.SelectionMode.NONE,
            row_spacing: 12,
            column_spacing: 12,
            margin_top: 6,
            margin_bottom: 12
        });

        // Populate Presets
        const extensionPath = _getExtensionPath();

        WallpaperPresets.forEach(preset => {
            const btn = new Gtk.Button({
                css_classes: ['card', 'preset-card'], 
                valign: Gtk.Align.CENTER,
                hexpand: true
            });
            btn.set_size_request(160, 120); 
            
            const overlay = new Gtk.Overlay();
            overlay.set_overflow(Gtk.Overflow.HIDDEN); 
            btn.set_child(overlay);

            // --- LAYER 1: Background Colors ---
            const bgArea = new Gtk.DrawingArea();
            bgArea.set_hexpand(true);
            bgArea.set_vexpand(true);

            // Note: Presets still define 'primary-color' in the 'system' block, now mapped to the Light Mode key
            const pColor = preset.system?.['primary-color'] || '#000000';
            const sColor = preset.system?.['secondary-color'] || pColor;
            const type = preset.system?.['color-shading-type'] || 'solid';

            const c1 = new Gdk.RGBA();
            if (!c1.parse(pColor)) c1.parse("#000000");

            const c2 = new Gdk.RGBA();
            if (!c2.parse(sColor)) c2.parse(pColor);

            bgArea.set_draw_func((area, cr, width, height) => {
                let pattern;
                if (type === 'horizontal') {
                    pattern = new Cairo.LinearGradient(0, 0, width, 0);
                } else if (type === 'vertical') {
                    pattern = new Cairo.LinearGradient(0, 0, 0, height);
                } else {
                    cr.setSourceRGBA(c1.red, c1.green, c1.blue, c1.alpha);
                    cr.rectangle(0, 0, width, height);
                    cr.fill();
                    return;
                }
                pattern.addColorStopRGBA(0, c1.red, c1.green, c1.blue, c1.alpha);
                pattern.addColorStopRGBA(1, c2.red, c2.green, c2.blue, c2.alpha);
                cr.setSource(pattern);
                cr.rectangle(0, 0, width, height);
                cr.fill();
            });
            overlay.set_child(bgArea);

            // --- LAYER 2: Image ---
            let imgRelativePath = null;
            if (preset.wallpaper) {
                if (typeof preset.wallpaper === 'string') {
                    imgRelativePath = preset.wallpaper;
                } else if (preset.wallpaper.light) {
                    imgRelativePath = preset.wallpaper.light;
                }
            }
            if (extensionPath && imgRelativePath) {
                try {
                    const file = _resolveFile(extensionPath, imgRelativePath);
                    if (file && file.query_exists(null)) {
                        const pictureWidget = Gtk.Picture.new_for_file(file);
                        pictureWidget.set_content_fit(Gtk.ContentFit.COVER);
                        pictureWidget.set_hexpand(true);
                        pictureWidget.set_vexpand(true);
                        overlay.add_overlay(pictureWidget);
                    }
                } catch(e) {}
            }

            // --- LAYER 3: Label ---
            const labelBox = new Gtk.Box({
                orientation: Gtk.Orientation.HORIZONTAL,
                valign: Gtk.Align.END,
                halign: Gtk.Align.FILL,
                css_classes: ['preset-overlay-box']
            });
            const label = new Gtk.Label({
                label: preset.name,
                css_classes: ['preset-label'],
                halign: Gtk.Align.START,
                ellipsize: 3 
            });
            labelBox.append(label);
            overlay.add_overlay(labelBox);

            btn.connect('clicked', () => {
                _applyPreset(preset, bgSettings, extSettings, extensionPath);
            });
            flowBox.append(btn);
        });
        presetGroup.add(flowBox);


        // --- BACKGROUND IMAGE SECTION ---
        const imgGroup = new Adw.PreferencesGroup({ 
            title: 'Background Image',
            description: 'Choose specific images for Light and Dark system themes.'
        });
        page.add(imgGroup);

        const showImageRow = new Adw.SwitchRow({
            title: 'Show Image',
            subtitle: 'Toggle the desktop background wallpaper'
        });
        extSettings.bind('wallpaper-show-image', showImageRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        imgGroup.add(showImageRow);

        const lightRow = _createImageRow(bgSettings, 'picture-uri', 'Light Mode Image');
        extSettings.bind('wallpaper-show-image', lightRow, 'sensitive', Gio.SettingsBindFlags.DEFAULT);
        imgGroup.add(lightRow);

        const darkRow = _createImageRow(bgSettings, 'picture-uri-dark', 'Dark Mode Image');
        extSettings.bind('wallpaper-show-image', darkRow, 'sensitive', Gio.SettingsBindFlags.DEFAULT);
        imgGroup.add(darkRow);

        // --- SCALING OPTIONS ---
        const optGroup = new Adw.PreferencesGroup({ 
            title: 'Scaling Options',
            description: 'Control how the wallpaper image fits your screen.'
        });
        page.add(optGroup);
        
        const optionsRow = _createOptionsRow(bgSettings);
        extSettings.bind('wallpaper-show-image', optionsRow, 'sensitive', Gio.SettingsBindFlags.DEFAULT);
        optGroup.add(optionsRow);


        // --- EFFECTS ---
        const fxGroup = new Adw.PreferencesGroup({ 
            title: "Effects",
            description: 'Apply visual filters like blur or desaturation to the background.'
        });
        page.add(fxGroup);

        const monoRow = new Adw.SwitchRow({
            title: 'Monochrome',
            subtitle: 'Desaturate the background'
        });
        _bindSwitch(extSettings, 'wallpaper-monochrome', monoRow);
        fxGroup.add(monoRow);

        const blurRow = new Adw.ActionRow({ title: "Blur Amount" });
        const blurScale = Gtk.Scale.new_with_range(Gtk.Orientation.HORIZONTAL, 0, 30, 1);
        blurScale.set_hexpand(true);
        blurScale.set_size_request(150, -1);
        blurScale.set_draw_value(true);
        blurScale.set_value_pos(Gtk.PositionType.RIGHT);
        extSettings.bind('wallpaper-blur-sigma', blurScale.get_adjustment(), 'value', Gio.SettingsBindFlags.DEFAULT);
        blurRow.add_suffix(blurScale);
        fxGroup.add(blurRow);

        const brightRow = new Adw.ActionRow({ title: "Brightness" });
        const brightScale = Gtk.Scale.new_with_range(Gtk.Orientation.HORIZONTAL, 0.0, 1.0, 0.1);
        brightScale.set_hexpand(true);
        brightScale.set_size_request(150, -1);
        brightScale.set_draw_value(true);
        brightScale.set_value_pos(Gtk.PositionType.RIGHT);
        extSettings.bind('wallpaper-brightness', brightScale.get_adjustment(), 'value', Gio.SettingsBindFlags.DEFAULT);
        brightRow.add_suffix(brightScale);
        fxGroup.add(brightRow);


        // --- COLORS ---
        const colorGroup = new Adw.PreferencesGroup({ 
            title: 'Colors',
            description: 'Define solid colors or gradients. These appear when no image is set or behind transparent wallpapers.'
        });
        page.add(colorGroup);

        // Bind to EXTENSION settings for Light Colors
        const lightSecRow = _createColorRow(extSettings, 'wallpaper-secondary-color-light', 'Light Secondary');
        const darkSecRow = _createColorRow(extSettings, 'wallpaper-secondary-color-dark', 'Dark Secondary');
        
        const shadingRow = _createShadingRow(bgSettings, [lightSecRow, darkSecRow]);
        colorGroup.add(shadingRow);

        colorGroup.add(_createColorRow(extSettings, 'wallpaper-primary-color-light', 'Light Primary'));
        colorGroup.add(lightSecRow);
        
        colorGroup.add(_createColorRow(extSettings, 'wallpaper-primary-color-dark', 'Dark Primary'));
        colorGroup.add(darkSecRow);

    } catch (e) {
        _addError(page, "Critical UI Error", e);
    }

    return page;
}

/**
 * Apply all settings defined in the preset
 */
function _applyPreset(preset, bgSettings, extSettings, rootPath) {
    // 1. Handle Images
    if (rootPath && preset.wallpaper) {
        let lightPath = null;
        let darkPath = null;

        if (typeof preset.wallpaper === 'string') {
            lightPath = preset.wallpaper;
            darkPath = preset.wallpaper;
        } else {
            lightPath = preset.wallpaper.light;
            darkPath = preset.wallpaper.dark;
        }

        if (lightPath) _setPresetImage(bgSettings, 'picture-uri', rootPath, lightPath);
        if (darkPath) _setPresetImage(bgSettings, 'picture-uri-dark', rootPath, darkPath);

        if (preset.extension?.['wallpaper-show-image'] !== false) {
            extSettings.set_boolean('wallpaper-show-image', true);
        }
    }

    // 2. Handle System Settings (Map Primary/Secondary to Light Extension keys)
    if (preset.system) {
        Object.keys(preset.system).forEach(key => {
            if (key === 'picture-uri' || key === 'picture-uri-dark') return;
            
            const val = preset.system[key];
            try {
                if (key === 'primary-color') {
                    extSettings.set_string('wallpaper-primary-color-light', val);
                } else if (key === 'secondary-color') {
                    extSettings.set_string('wallpaper-secondary-color-light', val);
                } else {
                    bgSettings.set_string(key, val);
                }
            } catch(e) { logError(`Preset error system key ${key}`, e); }
        });
    }

    // 3. Handle Extension Settings
    if (preset.extension) {
        Object.keys(preset.extension).forEach(key => {
            const val = preset.extension[key];
            try {
                const type = typeof val;
                if (type === 'boolean') extSettings.set_boolean(key, val);
                else if (type === 'number') {
                    if (Number.isInteger(val) && !key.includes('brightness')) {
                        extSettings.set_int(key, val);
                    } else {
                        extSettings.set_double(key, val);
                    }
                }
                else if (type === 'string') extSettings.set_string(key, val);
            } catch(e) { logError(`Preset error ext key ${key}`, e); }
        });
    }
}

function _resolveFile(root, pathString) {
    if (!pathString) return null;
    if (pathString.startsWith('/')) {
        return Gio.File.new_for_path(pathString);
    } else {
        const fullPath = GLib.build_filenamev([root, ...pathString.split('/')]);
        return Gio.File.new_for_path(fullPath);
    }
}

function _setPresetImage(settings, key, root, filename) {
    try {
        const file = _resolveFile(root, filename);
        if (file) {
            settings.set_string(key, file.get_uri());
        }
    } catch (e) {
        logError(`Failed to set preset image ${filename}`, e);
    }
}

function _getExtensionPath() {
    if (AppConfig.path) return AppConfig.path;
    try {
        const fileUri = import.meta.url;
        const filePath = GLib.filename_from_uri(fileUri)[0];
        const root = GLib.path_get_dirname(GLib.path_get_dirname(GLib.path_get_dirname(filePath)));
        return root;
    } catch(e) { return null; }
}

function _addError(page, title, e) {
    logError(title, e);
    const g = new Adw.PreferencesGroup();
    g.add(new Adw.ActionRow({ title: title, subtitle: e.toString() }));
    page.add(g);
}

function _createImageRow(settings, key, title) {
    const row = new Adw.ActionRow({ title: title });
    if (!settings) return row;

    const updateSubtitle = () => {
        try {
            const currentUri = settings.get_string(key);
            if (currentUri) {
                const file = Gio.File.new_for_uri(currentUri);
                row.set_subtitle(file.get_basename() || currentUri);
            } else {
                row.set_subtitle('No image set');
            }
        } catch(e) { row.set_subtitle('Error'); }
    };

    updateSubtitle();
    const signalId = settings.connect(`changed::${key}`, updateSubtitle);
    row.connect('destroy', () => settings.disconnect(signalId));

    const btn = new Gtk.Button({ icon_name: 'folder-open-symbolic', valign: Gtk.Align.CENTER, css_classes: ['flat'] });
    btn.connect('clicked', () => {
        if (_activeWallpaperChooser) return;
        try {
            const dialog = new Gtk.FileChooserNative({
                title: `Select ${title}`,
                action: Gtk.FileChooserAction.OPEN,
                transient_for: btn.get_root(),
                modal: true
            });
            
            // Filters
            const filter = new Gtk.FileFilter();
            filter.set_name("Images");
            filter.add_mime_type("image/png");
            filter.add_mime_type("image/jpeg");
            filter.add_mime_type("image/svg+xml");
            filter.add_mime_type("image/bmp");
            filter.add_mime_type("image/webp");
            dialog.add_filter(filter);
            
            const allFilter = new Gtk.FileFilter();
            allFilter.set_name("All Files");
            allFilter.add_pattern("*");
            dialog.add_filter(allFilter);
            
            dialog.set_filter(filter);

            _activeWallpaperChooser = dialog;
            dialog.connect('response', (d, response) => {
                if (response === Gtk.ResponseType.ACCEPT) {
                    const uri = d.get_file().get_uri();
                    settings.set_string(key, uri);
                }
                d.destroy();
                _activeWallpaperChooser = null;
            });
            dialog.show();
        } catch (e) { logError("File Chooser Error", e); }
    });
    row.add_suffix(btn);
    return row;
}

function _createColorRow(settings, key, title) {
    const row = new Adw.ActionRow({ title: title });
    const colorBtn = new Gtk.ColorButton({ valign: Gtk.Align.CENTER });
    
    const updateColor = () => {
        try {
            const rgba = new Gdk.RGBA();
            const str = settings.get_string(key);
            // Handle empty string gracefully
            if (!str || !rgba.parse(str)) rgba.parse("#000000");
            colorBtn.set_rgba(rgba);
        } catch (e) {}
    };

    updateColor();
    if (settings) {
        const signalId = settings.connect(`changed::${key}`, updateColor);
        row.connect('destroy', () => settings.disconnect(signalId));
    }

    colorBtn.connect('color-set', () => {
        const c = colorBtn.get_rgba();
        const toHex = (n) => Math.round(n * 255).toString(16).padStart(2, '0');
        let hex = `#${toHex(c.red)}${toHex(c.green)}${toHex(c.blue)}`;
        if (c.alpha < 0.999) hex += toHex(c.alpha);
        settings.set_string(key, hex);
    });
    row.add_suffix(colorBtn);
    return row;
}

function _createOptionsRow(settings) {
    let model = new Gtk.StringList({
        strings: ['none', 'wallpaper', 'centered', 'scaled', 'stretched', 'zoom', 'spanned']
    });
    const row = new Adw.ComboRow({
        title: 'Picture Style',
        model: model
    });

    const updateSelection = () => {
        const currentOpt = settings.get_string('picture-options');
        let found = false;
        for (let i = 0; i < model.get_n_items(); i++) {
            if (model.get_item(i).get_string() === currentOpt) {
                row.set_selected(i);
                found = true;
                break;
            }
        }
        if (!found) row.set_selected(5);
    };

    updateSelection();
    if (settings) {
        const signalId = settings.connect('changed::picture-options', updateSelection);
        row.connect('destroy', () => settings.disconnect(signalId));
    }

    row.connect('notify::selected-item', () => {
        const i = row.selected;
        if (i >= 0 && i < model.get_n_items()) {
            const val = model.get_item(i).get_string();
            if (settings.get_string('picture-options') !== val) {
                settings.set_string('picture-options', val);
            }
        }
    });

    return row;
}

function _createShadingRow(settings, dependencies) {
    let model = new Gtk.StringList({
        strings: ['solid', 'vertical', 'horizontal']
    });
    const row = new Adw.ComboRow({
        title: 'Color Mode',
        model: model
    });

    const updateState = () => {
        try {
            const current = settings.get_string('color-shading-type');
            let found = false;
            for (let i = 0; i < model.get_n_items(); i++) {
                if (model.get_item(i).get_string() === current) {
                    row.set_selected(i);
                    found = true;
                    break;
                }
            }
            if (!found) row.set_selected(0);

            if (dependencies) {
                const sensitive = current !== 'solid';
                if (Array.isArray(dependencies)) {
                    dependencies.forEach(row => {
                         if (row && typeof row.set_sensitive === 'function') {
                             row.set_sensitive(sensitive);
                         }
                    });
                } else if (dependencies.set_sensitive) {
                    dependencies.set_sensitive(sensitive);
                }
            }
        } catch(e) {}
    };

    updateState();
    if (settings) {
        const id = settings.connect('changed::color-shading-type', updateState);
        row.connect('destroy', () => settings.disconnect(id));
    }

    row.connect('notify::selected-item', () => {
        const i = row.selected;
        if (i >= 0 && i < model.get_n_items()) {
            const val = model.get_item(i).get_string();
            if (settings.get_string('color-shading-type') !== val) {
                settings.set_string('color-shading-type', val);
            }
        }
    });

    return row;
}

function _bindSwitch(settings, key, row) {
    row.set_active(settings.get_boolean(key));
    row.connect('notify::active', () => {
        const val = row.get_active();
        if (settings.get_boolean(key) !== val) {
            settings.set_boolean(key, val);
        }
    });
    const id = settings.connect(`changed::${key}`, () => {
        const val = settings.get_boolean(key);
        if (row.get_active() !== val) {
            row.set_active(val);
        }
    });
    row.connect('destroy', () => settings.disconnect(id));
}
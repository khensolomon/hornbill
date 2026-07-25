import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import { AppConfig } from '../config.js';
import { log, logError } from '../util/logger.js';

// Global reference to prevent Garbage Collection while dialog is open
let _activeFileChooser = null;

/**
 * Creates the CSS Configuration Page.
 */
export function createStylesheetUI(navigator) {
    const page = new Adw.PreferencesPage();

    if (!AppConfig.schemaId) {
        const errGroup = new Adw.PreferencesGroup();
        errGroup.add(new Adw.ActionRow({ title: 'Error', subtitle: 'Schema ID not found in configuration.' }));
        page.add(errGroup);
        return page;
    }

    const settings = AppConfig.getSettings();

    // 1. Add Bundled Styles Group
    _addBundledStylesGroup(page, settings);

    // 2. Add Custom Styles Group
    _addCustomStylesGroup(page, settings);

    return page;
}

/**
 * Helper: Lists available CSS files in the bundled style directory.
 */
function _listBundledFiles() {
    if (!AppConfig.path) return [];
  
    const cssDir = GLib.build_filenamev([AppConfig.path, 'style', 'bundled']);
    const dir = Gio.File.new_for_path(cssDir);

    if (!dir.query_exists(null)) return [];

    const files = [];
    try {
        const enumerator = dir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
        let fileInfo;
        while ((fileInfo = enumerator.next_file(null)) !== null) {
            const name = fileInfo.get_name();
            if (name.endsWith('.css')) {
                files.push(name);
            }
        }
    } catch (e) {
        logError(`Could not list style files: ${e.message}`);
    }
    return files;
}

function _extractCssDescription(file) {
    try {
        const [success, contents] = file.load_contents(null);
        if (!success) return null;

        const decoder = new TextDecoder('utf-8');
        const text = decoder.decode(contents);

        const match = text.match(/^\s*\/\*+([\s\S]*?)\*+\//);
        
        if (match && match[1]) {
            return match[1]
                .split('\n')
                .map(line => line.replace(/^\s*\*\s?/, '').trim())
                .filter(line => line.length > 0)
                .join(' ');
        }
    } catch (e) {
        // Fail silently
    }
    return null;
}

function _addBundledStylesGroup(page, settings) {
    const group = new Adw.PreferencesGroup({ title: 'Bundled Styles' });
    page.add(group);

    const cssFiles = _listBundledFiles();
    const enabled = settings.get_strv('enabled-styles') || [];
    const cssDir = GLib.build_filenamev([AppConfig.path, 'style', 'bundled']);

    if (cssFiles.length === 0) {
        const row = new Adw.ActionRow({
            title: 'No Styles Found',
            subtitle: 'No .css files were found in style/bundled',
        });
        group.add(row);
        return;
    }

    for (const cssFile of cssFiles) {
        const file = Gio.File.new_for_path(GLib.build_filenamev([cssDir, cssFile]));
        const description = _extractCssDescription(file);

        const row = new Adw.ActionRow({ 
            title: cssFile,
            subtitle: description || "", 
            subtitle_lines: 1 
        });

        const toggle = new Gtk.Switch({ 
            active: enabled.includes(cssFile), 
            valign: Gtk.Align.CENTER 
        });
        
        row.add_suffix(toggle);
        group.add(row);

        toggle.connect('state-set', (sw, state) => {
            let list = settings.get_strv('enabled-styles') || [];
            const i = list.indexOf(cssFile);
            
            if (state && i === -1) {
                list.push(cssFile);
            } else if (!state && i > -1) {
                list.splice(i, 1);
            }
            
            settings.set_strv('enabled-styles', list);
            return false; 
        });
    }
}

function _addCustomStylesGroup(page, settings) {
    const group = new Adw.PreferencesGroup({
        title: 'Custom Styles',
        description: 'Add your own CSS files from anywhere on your computer.'
    });
    page.add(group);

    const listbox = new Gtk.ListBox({
        selection_mode: Gtk.SelectionMode.NONE,
        css_classes: ['boxed-list'],
    });
    group.add(listbox);

    const addButton = new Gtk.Button({
        label: 'Add Style File…',
        halign: Gtk.Align.CENTER,
        margin_top: 12
    });
    group.add(addButton);

    _populateCustomStyles(listbox, settings);

    settings.connect('changed::custom-styles', () => _populateCustomStyles(listbox, settings));

    addButton.connect('clicked', () => {
        const root = addButton.get_root();
        _onAddClicked(root, settings);
    });
}

function _populateCustomStyles(listbox, settings) {
    listbox.remove_all();
    
    let customStyles = [];
    try {
        customStyles = settings.get_value('custom-styles').deep_unpack();
    } catch(e) {
        logError("Failed to unpack custom-styles", e);
        return;
    }

    if (customStyles.length === 0) {
        listbox.set_visible(false);
    } else {
        listbox.set_visible(true);
        for (const [uri, enabled] of customStyles) {
            listbox.append(_createCustomStyleRow(uri, enabled, settings));
        }
    }
}

function _createCustomStyleRow(uri, enabled, settings) {
    const file = Gio.File.new_for_uri(uri);
    const basename = file.get_basename();
    const description = _extractCssDescription(file);

    const row = new Adw.ActionRow({
        title: basename || 'Invalid File',
        subtitle: description || file.get_path() || uri,
        subtitle_lines: 1
    });

    const toggle = new Gtk.Switch({ active: enabled, valign: Gtk.Align.CENTER });
    row.add_suffix(toggle);

    const openButton = new Gtk.Button({
        icon_name: 'document-open-symbolic',
        tooltip_text: 'Open File',
        css_classes: ['flat']
    });
    openButton.connect('clicked', () => {
        try {
            const launcher = new Gtk.UriLauncher({ uri: uri });
            launcher.launch(null, null, null);
        } catch(e) {
            logError("Failed to launch URI", e);
        }
    });
    row.add_suffix(openButton);

    const removeButton = new Gtk.Button({
        icon_name: 'user-trash-symbolic',
        tooltip_text: 'Remove',
        css_classes: ['destructive-action']
    });
    removeButton.connect('clicked', () => {
        const allStyles = settings.get_value('custom-styles').deep_unpack();
        const newStyles = allStyles.filter(([u]) => u !== uri);
        settings.set_value('custom-styles', new GLib.Variant('a(sb)', newStyles));
    });
    row.add_suffix(removeButton);

    toggle.connect('state-set', (_, state) => {
        const allStyles = settings.get_value('custom-styles').deep_unpack();
        const newStyles = allStyles.map(([u, e]) => (u === uri) ? [u, state] : [u, e]);
        settings.set_value('custom-styles', new GLib.Variant('a(sb)', newStyles));
        return true; 
    });

    return row;
}

function _onAddClicked(parentWindow, settings) {
    // FIX: GC Issue prevents dialog from staying open
    // If a dialog is already active, focus it and do nothing
    if (_activeFileChooser) {
        try {
            _activeFileChooser.present();
        } catch(e) {
            _activeFileChooser = null; // Clean up stale reference
        }
        return;
    }

    const fileChooser = new Gtk.FileChooserNative({
        title: 'Select CSS File',
        action: Gtk.FileChooserAction.OPEN,
        transient_for: parentWindow,
        modal: true
    });

    const filter = new Gtk.FileFilter();
    filter.set_name('CSS Files');
    filter.add_pattern('*.css');
    fileChooser.add_filter(filter);

    // FIX: Assign to module-level variable to hold reference
    _activeFileChooser = fileChooser;

    fileChooser.connect('response', (dialog, response) => {
        if (response === Gtk.ResponseType.ACCEPT) {
            const file = dialog.get_file();
            const uri = file.get_uri();
            
            const currentStyles = settings.get_value('custom-styles').deep_unpack();
            if (!currentStyles.some(([u]) => u === uri)) {
                currentStyles.push([uri, true]);
                settings.set_value('custom-styles', new GLib.Variant('a(sb)', currentStyles));
            }
        }
        dialog.destroy();
        
        // FIX: Clear reference after destruction
        _activeFileChooser = null;
    });

    fileChooser.show();
}
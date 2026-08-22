import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import { AppConfig } from '../config.js';
import { logError } from '../util/logger.js';
import { gettext as _ } from '../util/gettext.js';

// Global reference to prevent Garbage Collection while dialog is open
let _activeFileChooser = null;

/**
 * Creates the CSS Configuration Page.
 */
export function createStylesheetUI(navigator) {
    const page = new Adw.PreferencesPage();

    if (!AppConfig.schemaId) {
        const errGroup = new Adw.PreferencesGroup();
        errGroup.add(new Adw.ActionRow({ title: _('Error'), subtitle: _('Schema ID not found in configuration.') }));
        page.add(errGroup);
        return page;
    }

    const settings = AppConfig.getSettings();

    // 1. Custom Styles (the user's own work comes first)
    _addCustomStylesGroup(page, settings);

    // 2. Bundled Styles (demo material)
    _addBundledStylesGroup(page, settings);

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

function _showCssDialog(parent, title, file) {
    let contents = '';
    try {
        const [ok, bytes] = file.load_contents(null);
        if (ok) contents = new TextDecoder().decode(bytes);
    } catch (e) {
        contents = `/* Could not read file:\n   ${e} */`;
    }

    const dialog = new Adw.Window({
        title: title,
        modal: true,
        default_width: 640,
        default_height: 520,
    });
    if (parent) dialog.set_transient_for(parent);

    const toolbar = new Adw.ToolbarView();
    const header = new Adw.HeaderBar();
    toolbar.add_top_bar(header);

    const copyBtn = new Gtk.Button({ icon_name: 'edit-copy-symbolic', tooltip_text: _('Copy CSS') });
    copyBtn.connect('clicked', () => {
        dialog.get_clipboard().set(contents);
    });
    header.pack_start(copyBtn);

    const textView = new Gtk.TextView({
        editable: false,
        monospace: true,
        cursor_visible: false,
        left_margin: 12, right_margin: 12, top_margin: 12, bottom_margin: 12,
        wrap_mode: Gtk.WrapMode.NONE,
    });
    textView.get_buffer().set_text(contents, -1);

    const scroller = new Gtk.ScrolledWindow({ vexpand: true, hexpand: true });
    scroller.set_child(textView);
    toolbar.set_content(scroller);

    dialog.set_content(toolbar);
    dialog.present();
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
    const group = new Adw.PreferencesGroup({
        title: _('Bundled Styles'),
        description: _('Demo styles shipped with the extension — view their CSS as a cheat sheet for writing your own.')
    });
    page.add(group);

    const cssFiles = _listBundledFiles();
    const enabled = settings.get_strv('enabled-styles') || [];
    const cssDir = GLib.build_filenamev([AppConfig.path, 'style', 'bundled']);

    if (cssFiles.length === 0) {
        const row = new Adw.ActionRow({
            title: _('No Styles Found'),
            subtitle: _('No .css files were found in style/bundled'),
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
        
        // Cheat-sheet viewer: bundled styles exist to be read
        const viewButton = new Gtk.Button({
            icon_name: 'text-x-generic-symbolic',
            tooltip_text: _('View CSS'),
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        viewButton.connect('clicked', () => {
            _showCssDialog(viewButton.get_root(), cssFile, file);
        });
        row.add_suffix(viewButton);

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
        title: _('Custom Styles'),
        description: _('Add your own CSS files from anywhere on your computer. Files reload automatically when edited.')
    });
    page.add(group);

    // Header controls: master switch + compact Add — visible once the list
    // has content. The empty state gets a single big button instead.
    const headerBox = new Gtk.Box({ spacing: 6 });

    const masterSwitch = new Gtk.Switch({
        valign: Gtk.Align.CENTER,
        tooltip_text: _('Enable or disable all custom styles'),
    });
    settings.bind('custom-styles-enabled', masterSwitch, 'active',
        Gio.SettingsBindFlags.DEFAULT);
    headerBox.append(masterSwitch);

    const headerAdd = new Gtk.Button({
        icon_name: 'list-add-symbolic',
        tooltip_text: _('Add Style File'),
        valign: Gtk.Align.CENTER,
        css_classes: ['flat'],
    });
    headerBox.append(headerAdd);
    group.set_header_suffix(headerBox);

    const listbox = new Gtk.ListBox({
        selection_mode: Gtk.SelectionMode.NONE,
        css_classes: ['boxed-list'],
    });
    group.add(listbox);

    // Empty state: one clear call to action
    const emptyAdd = new Gtk.Button({
        label: _('Add Style File…'),
        halign: Gtk.Align.CENTER,
        margin_top: 12
    });
    group.add(emptyAdd);

    const refresh = () => {
        const hasItems = _populateCustomStyles(listbox, settings);
        emptyAdd.set_visible(!hasItems);
        headerBox.set_visible(hasItems);
    };
    refresh();

    settings.connect('changed::custom-styles', refresh);

    const onAdd = (btn) => _onAddClicked(btn.get_root(), settings);
    headerAdd.connect('clicked', () => onAdd(headerAdd));
    emptyAdd.connect('clicked', () => onAdd(emptyAdd));
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
        return false;
    }
    listbox.set_visible(true);
    for (const [uri, enabled] of customStyles) {
        listbox.append(_createCustomStyleRow(uri, enabled, settings));
    }
    return true;
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
        tooltip_text: _('Open File'),
        valign: Gtk.Align.CENTER,
        css_classes: ['flat']
    });
    openButton.connect('clicked', () => {
        const parent = openButton.get_root();
        try {
            // A file:// URI opens in the default CSS handler (usually a text
            // editor). FileLauncher is the correct API for files; UriLauncher
            // with a null parent silently did nothing.
            const launcher = new Gtk.FileLauncher({ file });
            launcher.launch(parent, null, (l, res) => {
                try { l.launch_finish(res); }
                catch (e) { logError('Failed to open file', e); }
            });
        } catch (e) {
            logError('Failed to open file', e);
        }
    });
    row.add_suffix(openButton);

    const removeButton = new Gtk.Button({
        icon_name: 'user-trash-symbolic',
        tooltip_text: _('Remove'),
        valign: Gtk.Align.CENTER,
        css_classes: ['flat']
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
        title: _('Select CSS File'),
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
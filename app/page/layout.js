import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import { AppConfig } from '../config.js';
import { gettext as _, N_ } from '../util/gettext.js';

/**
 * Creates the Applications Preferences Page UI.
 * This page handles configuration for:
 * - Running Indicators (Style, position, color)
 * - Specific App Groups (Show Apps, Overview, Favorites, Running, Disks, Trash)
 * * @returns {Adw.PreferencesPage} The constructed preferences page.
 */
export function createLayoutUI() {
    const page = new Adw.PreferencesPage();
    const settings = AppConfig.getSettings();

    /**
     * Helper to attach an icon to the group header.
     * @param {Adw.PreferencesGroup} group - The preference group to modify.
     * @param {string} iconName - The name of the icon to display.
     */
    const addGroupIcon = (group, iconName) => {
        if (!iconName) return;
        const icon = new Gtk.Image({
            icon_name: iconName,
            pixel_size: 24,
        });
        icon.add_css_class('dim-label');
        group.set_header_suffix(icon);
    };

    /**
     * SECTION: Indicator Settings
     * Customize the visual indicator for running applications.
     */
    const indGroup = new Adw.PreferencesGroup({ 
        title: _('Running Indicator'),
        description: _('Customize the visual indicator for running applications.')
    });
    addGroupIcon(indGroup, 'software-update-available-symbolic');
    page.add(indGroup);

    /**
     * Configuration for Indicator Presets.
     * Maps user-friendly names to specific indicator properties.
     */
    const presetConfig = [
        { name: N_('Custom'), id: 0 },
        { name: N_('Dot Below'),  pos: 'top',    off: 12, w: 4,  h: 4,  r: 99, c: '#ffffff' },
        { name: N_('Dot Above'),  pos: 'bottom', off: 12, w: 4,  h: 4,  r: 99, c: '#ffffff' },
        { name: N_('Line Below'), pos: 'top',    off: 14, w: 14, h: 1,  r: 0,  c: '#ffffff' },
        { name: N_('Line Above'), pos: 'bottom', off: 14, w: 14, h: 1,  r: 0,  c: '#ffffff' },
        { name: N_('Bar Left'),   pos: 'right',  off: 13, w: 2,  h: 16, r: 0,  c: '#ffffff' },
        { name: N_('Bar Right'),  pos: 'left',   off: 13, w: 2,  h: 16, r: 0,  c: '#ffffff' }
    ];

    const presetModel = new Gtk.StringList();
    presetConfig.forEach(p => presetModel.append(_(p.name)));

    const presetRow = new Adw.ComboRow({
        title: _('Style Preset'),
        subtitle: _('Quickly apply common indicator styles'),
        model: presetModel,
    });

    /**
     * Logic: Apply Preset
     * When a preset is selected (other than Custom), write values to settings.
     */
    presetRow.connect('notify::selected', () => {
        const idx = presetRow.selected;
        if (idx === 0) return; // Custom, do nothing

        const p = presetConfig[idx];
        
        // Write all values
        settings.set_value('apps-indicator-pos', new GLib.Variant('s', p.pos));
        settings.set_int('apps-indicator-offset', p.off);
        settings.set_int('apps-indicator-width', p.w);
        settings.set_int('apps-indicator-height', p.h);
        settings.set_int('apps-indicator-radius', p.r);
        settings.set_string('apps-indicator-color', p.c);
    });

    /**
     * Logic: Detect Preset (Reverse Lookup)
     * Reads current settings and attempts to match them to a known preset.
     * Updates the combo row selection to match.
     */
    const updatePresetSelection = () => {
        // Read current values
        let pos = 'top';
        const val = settings.get_value('apps-indicator-pos');
        if (val.is_of_type(new GLib.VariantType('s'))) {
            pos = val.deep_unpack();
        } else if (val.is_of_type(new GLib.VariantType('i'))) {
             const nicks = ['top', 'right', 'bottom', 'left'];
             pos = nicks[val.deep_unpack()] || 'top';
        }

        const current = {
            pos: pos,
            off: settings.get_int('apps-indicator-offset'),
            w: settings.get_int('apps-indicator-width'),
            h: settings.get_int('apps-indicator-height'),
            r: settings.get_int('apps-indicator-radius'),
            c: settings.get_string('apps-indicator-color').toLowerCase()
        };

        let matchIndex = 0; // Default to Custom

        for (let i = 1; i < presetConfig.length; i++) {
            const p = presetConfig[i];
            if (p.pos === current.pos &&
                p.off === current.off &&
                p.w === current.w &&
                p.h === current.h &&
                p.r === current.r &&
                p.c.toLowerCase() === current.c) {
                matchIndex = i;
                break;
            }
        }

        if (presetRow.selected !== matchIndex) {
            presetRow.freeze_notify(); // Prevent triggering the setter loop
            presetRow.selected = matchIndex;
            presetRow.thaw_notify();
        }
    };

    // Watch all relevant keys to update the dropdown state
    const keysToWatch = [
        'apps-indicator-pos', 'apps-indicator-offset', 
        'apps-indicator-width', 'apps-indicator-height', 
        'apps-indicator-radius', 'apps-indicator-color'
    ];
    keysToWatch.forEach(key => settings.connect(`changed::${key}`, updatePresetSelection));
    
    // Initial check
    updatePresetSelection();

    indGroup.add(presetRow);

    /**
     * SUB-SECTION: Manual Controls
     * Fine-grained controls for indicator properties.
     */

    /** Setting: Position Enum (Manual Handling) */
    const indPosModel = new Gtk.StringList();
    indPosModel.append('Top');    // 0
    indPosModel.append('Right');  // 1
    indPosModel.append('Bottom'); // 2
    indPosModel.append('Left');   // 3
    
    const indPosRow = new Adw.ComboRow({
        title: _('Position'),
        model: indPosModel
    });

    // Initial Load
    indPosRow.selected = settings.get_enum('apps-indicator-pos');

    // Save Change
    indPosRow.connect('notify::selected', () => {
        const nicks = ['top', 'right', 'bottom', 'left'];
        if (settings.get_enum('apps-indicator-pos') !== indPosRow.selected) {
            settings.set_value('apps-indicator-pos', new GLib.Variant('s', nicks[indPosRow.selected]));
        }
    });

    // External Change
    settings.connect('changed::apps-indicator-pos', () => {
        const currentVal = settings.get_enum('apps-indicator-pos');
        if (indPosRow.selected !== currentVal) {
            indPosRow.selected = currentVal;
        }
    });

    indGroup.add(indPosRow);

    /** Setting: Offset */
    const offsetRow = new Adw.SpinRow({
        title: _('Offset'),
        subtitle: _('Distance from edge'),
        adjustment: new Gtk.Adjustment({ lower: 0, upper: 20, step_increment: 1 })
    });
    settings.bind('apps-indicator-offset', offsetRow, 'value', Gio.SettingsBindFlags.DEFAULT);
    indGroup.add(offsetRow);

    /** Setting: Width */
    const wRow = new Adw.SpinRow({
        title: _('Width'),
        adjustment: new Gtk.Adjustment({ lower: 1, upper: 20, step_increment: 1 })
    });
    settings.bind('apps-indicator-width', wRow, 'value', Gio.SettingsBindFlags.DEFAULT);
    indGroup.add(wRow);

    /** Setting: Height */
    const hRow = new Adw.SpinRow({
        title: _('Height'),
        adjustment: new Gtk.Adjustment({ lower: 1, upper: 20, step_increment: 1 })
    });
    settings.bind('apps-indicator-height', hRow, 'value', Gio.SettingsBindFlags.DEFAULT);
    indGroup.add(hRow);

    /** Setting: Radius */
    const radRow = new Adw.SpinRow({
        title: _('Radius'),
        subtitle: _('Corner rounding (0=Square, 99=Round)'),
        adjustment: new Gtk.Adjustment({ lower: 0, upper: 99, step_increment: 1 })
    });
    settings.bind('apps-indicator-radius', radRow, 'value', Gio.SettingsBindFlags.DEFAULT);
    indGroup.add(radRow);

    /** Setting: Color */
    const colorRow = new Adw.ActionRow({ title: _('Color') });
    const colorDialog = new Gtk.ColorDialog();
    const colorBtn = new Gtk.ColorDialogButton({
        dialog: colorDialog,
        valign: Gtk.Align.CENTER
    });

    const updateColorBtn = () => {
        const hex = settings.get_string('apps-indicator-color');
        const rgba = new Gdk.RGBA();
        if (rgba.parse(hex)) {
            colorBtn.set_rgba(rgba);
        }
    };
    updateColorBtn();
    
    settings.connect('changed::apps-indicator-color', updateColorBtn);

    colorBtn.connect('notify::rgba', () => {
        const c = colorBtn.get_rgba();
        const toHex = (n) => Math.round(n * 255).toString(16).padStart(2, '0').toUpperCase();
        const hexStr = `#${toHex(c.red)}${toHex(c.green)}${toHex(c.blue)}`;
        if (hexStr !== settings.get_string('apps-indicator-color')) {
            settings.set_string('apps-indicator-color', hexStr);
        }
    });

    colorRow.add_suffix(colorBtn);
    indGroup.add(colorRow);


    /**
     * Helper to create a standardized settings section.
     * @param {string} title - The visible title of the section.
     * @param {string} keySuffix - The suffix for settings keys (e.g., 'showgrid').
     * @param {string} description - The description of the section.
     * @param {string} iconName - The icon name for the section header.
     * @param {Function} [extraWidgetsCallback] - Optional callback to add extra widgets to the group.
     */
    const createSection = (title, keySuffix, description, iconName, extraWidgetsCallback = null) => {
        const group = new Adw.PreferencesGroup({ 
            title: title,
            description: description 
        });
        addGroupIcon(group, iconName);
        page.add(group);

        const enableRow = new Adw.SwitchRow({ title: _('Show in Panel') });
        settings.bind(`apps-${keySuffix}-enabled`, enableRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(enableRow);

        const posModel = new Gtk.StringList();
        posModel.append('Left Panel');
        posModel.append('Right Panel');
        const posRow = new Adw.ComboRow({
            title: _('Position'),
            model: posModel,
            selected: settings.get_enum(`apps-${keySuffix}-pos`)
        });
        posRow.connect('notify::selected', () => {
            const nick = posRow.selected === 0 ? 'left' : 'right';
            settings.set_value(`apps-${keySuffix}-pos`, new GLib.Variant('s', nick));
        });
        
        settings.connect(`changed::apps-${keySuffix}-pos`, () => {
             const val = settings.get_enum(`apps-${keySuffix}-pos`);
             if (posRow.selected !== val) posRow.selected = val;
        });

        group.add(posRow);

        const idxRow = new Adw.SpinRow({
            title: _('Sort Order'),
            adjustment: new Gtk.Adjustment({ lower: 0, upper: 20, step_increment: 1 }),
            value: settings.get_int(`apps-${keySuffix}-index`)
        });
        idxRow.connect('notify::value', () => settings.set_int(`apps-${keySuffix}-index`, idxRow.value));
        group.add(idxRow);

        if (extraWidgetsCallback) {
            extraWidgetsCallback(group);
        }

        settings.bind(`apps-${keySuffix}-enabled`, posRow, 'sensitive', Gio.SettingsBindFlags.DEFAULT);
        settings.bind(`apps-${keySuffix}-enabled`, idxRow, 'sensitive', Gio.SettingsBindFlags.DEFAULT);
    };

    /** SECTION: Show Applications Button */
    createSection(
        'Show Applications', 
        'showgrid', 
        'Settings for the application grid toggle button.',
        'view-app-grid-symbolic',
        (group) => {
            // Mode Selection: Icon | File | Text
            const modeModel = new Gtk.StringList();
            modeModel.append('Icon Name'); // 0
            modeModel.append('File Path'); // 1
            modeModel.append('Text Label'); // 2

            const modeRow = new Adw.ComboRow({
                title: _('Display Mode'),
                subtitle: _('Choose how the button appears in the panel.'),
                model: modeModel,
                selected: settings.get_enum('apps-showgrid-mode')
            });
            
            modeRow.connect('notify::selected', () => {
                settings.set_enum('apps-showgrid-mode', idxToEnum(modeRow.selected));
                updateVisibility(modeRow.selected);
            });
            group.add(modeRow);

            const idxToEnum = (idx) => idx; // 0, 1, 2 map directly

            // 1. Icon Name — free text WITH suggestions.
            // A GtkEntryCompletion offers common symbolic names as the user
            // types, while any value remains typeable (themes ship hundreds
            // of icons; a fixed dropdown would be wrong). The dropdown is a
            // shortcut, not a constraint.
            const currentIcon = settings.get_string('apps-showgrid-icon');
            const iconRow = new Adw.EntryRow({
                title: _('Icon Name'),
                text: currentIcon || 'start-here-symbolic'
            });

            const iconSuggestions = [
                'start-here-symbolic', 'view-app-grid-symbolic',
                'applications-system-symbolic', 'org.gnome.Settings-symbolic',
                'preferences-system-symbolic', 'go-home-symbolic',
                'user-home-symbolic', 'emblem-system-symbolic',
                'application-x-executable-symbolic', 'view-grid-symbolic',
                'view-more-symbolic', 'open-menu-symbolic',
                'system-search-symbolic', 'starred-symbolic',
            ];
            const iconStore = new Gtk.ListStore();
            iconStore.set_column_types([GObject.TYPE_STRING]);
            for (const name of iconSuggestions) {
                const iter = iconStore.append();
                iconStore.set(iter, [0], [name]);
            }
            const completion = new Gtk.EntryCompletion({
                model: iconStore,
                text_column: 0,
                inline_completion: true,
                popup_completion: true,
            });
            // EntryRow wraps a GtkText/GtkEntry-like delegate; attach there.
            const delegate = iconRow.get_delegate?.();
            if (delegate && typeof delegate.set_completion === 'function') {
                delegate.set_completion(completion);
            }

            iconRow.connect('changed', () => settings.set_string('apps-showgrid-icon', iconRow.text));
            group.add(iconRow);

            // 2. File Path Entry + Button
            const fileRow = new Adw.ActionRow({
                title: _('Icon File'),
                subtitle: settings.get_string('apps-showgrid-path') || 'No file selected'
            });
            
            const fileBtn = new Gtk.Button({
                icon_name: 'folder-open-symbolic',
                valign: Gtk.Align.CENTER
            });
            
            fileBtn.connect('clicked', () => {
                // Use FileDialog for modern GTK4
                try {
                    const dialog = new Gtk.FileDialog({
                        title: _('Select Icon'),
                        modal: true
                    });
                    
                    // Add filters if desired
                    const filters = new Gio.ListStore({ item_type: Gtk.FileFilter });
                    const imageFilter = new Gtk.FileFilter();
                    imageFilter.set_name("Images");
                    imageFilter.add_mime_type("image/*");
                    filters.append(imageFilter);
                    dialog.set_filters(filters);

                    const win = fileBtn.get_root(); // Getting the window
                    dialog.open(win, null, (source, result) => {
                        try {
                            const file = source.open_finish(result);
                            const path = file.get_path();
                            if (path) {
                                settings.set_string('apps-showgrid-path', path);
                                fileRow.set_subtitle(path);
                            }
                        } catch (e) {
                            // User likely cancelled
                        }
                    });
                } catch (err) {
                    console.error("FileDialog not supported or failed", err);
                }
            });

            fileRow.add_suffix(fileBtn);
            group.add(fileRow);

            // 3. Text Entry
            const textRow = new Adw.EntryRow({
                title: _('Label Text'),
                text: settings.get_string('apps-showgrid-text')
            });
            textRow.connect('changed', () => settings.set_string('apps-showgrid-text', textRow.text));
            group.add(textRow);

            // Helper text
            const helpRow = new Adw.ActionRow({
                title: _('Note'),
                subtitle: _('Enter a themed icon name (e.g., start-here-symbolic) or a full file path.')
            });
            group.add(helpRow);

            // Visibility Logic
            const updateVisibility = (modeIdx) => {
                iconRow.set_visible(modeIdx === 0);
                fileRow.set_visible(modeIdx === 1);
                textRow.set_visible(modeIdx === 2);
                helpRow.set_visible(modeIdx !== 2);
            };

            // Initial State
            updateVisibility(settings.get_enum('apps-showgrid-mode'));
        }
    );

    /** SECTION: Overview Button */
    createSection(
        'Overview', 
        'overview', 
        'Settings for the activities overview button.',
        'view-paged-symbolic',
        (group) => {
            const hideDefaultRow = new Adw.SwitchRow({
                title: _('Hide "Activities" Button'),
                subtitle: _('Hide the default GNOME Shell Activities button')
            });
            settings.bind('apps-overview-hide-default', hideDefaultRow, 'active', Gio.SettingsBindFlags.DEFAULT);
            group.add(hideDefaultRow);
        }
    );

    /** SECTION: Favorites (Pinned Apps) */
    createSection('Favorites', 'favorites', 'Manage the pinned favorites launcher.', 'starred-symbolic');

    /** SECTION: Running Apps Taskbar */
    createSection('Running Apps', 'running', 'Manage the taskbar for running applications.', 'preferences-system-windows-symbolic');

    /** SECTION: Disks & Volumes */
    createSection('Disks', 'disks', 'Manage mounted drives and volumes.', 'drive-harddisk-symbolic');

    /** SECTION: Trash */
    createSection('Trash', 'trash', 'Manage the trash bin button.', 'user-trash-symbolic');

    /** * SECTION: Manage Favorites
     * Interface for reordering pinned applications.
     */
    const favGroup = new Adw.PreferencesGroup({
        title: _('Manage Favorites'),
        description: _('Drag and drop items to reorder.')
    });
    addGroupIcon(favGroup, 'view-sort-ascending-symbolic');
    page.add(favGroup);

    // Using a ListBox with "boxed-list" style matches Adwaita preferences styling
    // while keeping control over row logic for DND.
    const favList = new Gtk.ListBox({
        selection_mode: Gtk.SelectionMode.NONE,
        css_classes: ['boxed-list']
    });
    favGroup.add(favList);

    const shellSettings = new Gio.Settings({ schema_id: 'org.gnome.shell' });
    
    /**
     * Logic: Refresh Favorites List
     * Rebuilds the UI rows based on the current favorites list in GSettings.
     */
    const refreshFavs = () => {
        // Clear existing children
        let child = favList.get_first_child();
        while(child) {
            const next = child.get_next_sibling();
            favList.remove(child);
            child = next;
        }

        const favs = shellSettings.get_strv('favorite-apps');
        
        favs.forEach((appId, index) => {
            const row = new Adw.ActionRow();
            
            // 1. Fetch App Info (Name & Icon)
            let name = appId;
            let gicon = new Gio.ThemedIcon({ name: 'application-x-executable-symbolic' });
            
            try {
                const appInfo = Gio.DesktopAppInfo.new(appId);
                if (appInfo) {
                    name = appInfo.get_name();
                    const icon = appInfo.get_icon();
                    if (icon) gicon = icon;
                }
            } catch (e) {
                // Fallback to basic info if app not found
            }

            row.title = name;
            row.subtitle = appId;
            row.add_prefix(new Gtk.Image({ gicon: gicon, pixel_size: 32 }));

            // 2. Drag handle icon (visual cue)
            const dragIcon = new Gtk.Image({ icon_name: 'list-drag-handle-symbolic' });
            dragIcon.add_css_class('dim-label');
            row.add_suffix(dragIcon);

            // 3. DND Controller: Source (Draggable)
            const dragSource = new Gtk.DragSource({ actions: Gdk.DragAction.MOVE });
            dragSource.connect('prepare', (source, x, y) => {
                // The item index is dragged as a string (simplest payload for GJS)
                return Gdk.ContentProvider.new_for_value(index.toString());
            });
            // Visual feedback while dragging
            dragSource.connect('drag-begin', (source, drag) => {
                const paintable = new Gtk.WidgetPaintable({ widget: row });
                source.set_icon(paintable, 0, 0);
            });
            row.add_controller(dragSource);

            // 4. DND Controller: Target (Droppable)
            const dropTarget = new Gtk.DropTarget({
                actions: Gdk.DragAction.MOVE,
                formats: Gdk.ContentFormats.new_for_gtype(GObject.TYPE_STRING)
            });
            
            dropTarget.connect('drop', (target, value, x, y) => {
                // Parse indices
                const sourceIndex = parseInt(value);
                const targetIndex = index;

                if (sourceIndex === targetIndex || isNaN(sourceIndex)) return false;

                // Reorder array
                const newFavs = [...favs];
                const [movedItem] = newFavs.splice(sourceIndex, 1);
                newFavs.splice(targetIndex, 0, movedItem);

                // Save & Refresh
                shellSettings.set_strv('favorite-apps', newFavs);
                refreshFavs(); 
                return true;
            });
            row.add_controller(dropTarget);

            favList.append(row);
        });
    };

    // Initial load
    refreshFavs();

    // Listen for external changes (e.g. if user unpins via Shell)
    const id = shellSettings.connect('changed::favorite-apps', refreshFavs);
    // Note: this signal is not disconnected when the page is destroyed 
    // in this specific functional structure, but in Prefs windows, the process usually ends 
    // when the window closes, so it's acceptable.
    
    return page;
}
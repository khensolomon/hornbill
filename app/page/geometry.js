import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';
import Gdk from 'gi://Gdk';
import GLib from 'gi://GLib';
import { AppConfig } from '../config.js';
import { logError } from '../util/logger.js';
import { gettext as _ } from '../util/gettext.js';

export function createGeometryUI() {
    const page = new Adw.PreferencesPage();
    const settings = AppConfig.getSettings();

    // Internal tracker for active widgets
    // Map<WindowID, Adw.ActionRow>
    const activeRows = new Map();
    let emptyStateRow = null;

    // --- SECTION 1: SETTINGS ---
    const mainGroup = new Adw.PreferencesGroup({
        title: _('Settings'),
    });
    page.add(mainGroup);

    const enableRow = new Adw.SwitchRow({
        title: _('Enable Geometry Saving'),
        subtitle: _('Remember window size and position')
    });
    settings.bind('geometry-enabled', enableRow, 'active', Gio.SettingsBindFlags.DEFAULT);
    mainGroup.add(enableRow);

    const wsRow = new Adw.SwitchRow({
        title: _('Restore Workspace'),
        subtitle: _('Reopen windows on the workspace they were closed on (recreated if needed)')
    });
    settings.bind('geometry-restore-workspace', wsRow, 'active', Gio.SettingsBindFlags.DEFAULT);
    settings.bind('geometry-enabled', wsRow, 'sensitive', Gio.SettingsBindFlags.GET);

    const x11Row = new Adw.SwitchRow({
        title: _('Manage X11 Windows'),
        subtitle: _('Applies to apps running through Xwayland. Disable if X11 apps destabilize the session')
    });
    settings.bind('geometry-manage-x11', x11Row, 'active', Gio.SettingsBindFlags.DEFAULT);
    settings.bind('geometry-enabled', x11Row, 'sensitive', Gio.SettingsBindFlags.GET);
    mainGroup.add(wsRow);
    mainGroup.add(x11Row);

    // --- SECTION 2: DATA LIST ---
    const dataGroup = new Adw.PreferencesGroup({
        title: _('Saved Applications'),
        description: _('Manage currently stored window positions')
    });
    page.add(dataGroup);

    // --- HELPER: GET ICON ---
    const getAppIcon = (wmClass) => {
        const iconImage = new Gtk.Image({ pixel_size: 32 });

        // Guard: reserved keys ('__aliases__') and malformed entries have no
        // valid app id. DesktopAppInfo.new throws on a null/empty string.
        if (!wmClass || typeof wmClass !== 'string' || wmClass.startsWith('__')) {
            iconImage.set_from_icon_name('application-x-executable-symbolic');
            return iconImage;
        }

        let appInfo = null;
        try {
            appInfo = Gio.DesktopAppInfo.new(`${wmClass}.desktop`);
            if (!appInfo)
                appInfo = Gio.DesktopAppInfo.new(`${wmClass.toLowerCase()}.desktop`);
        } catch (e) {
            appInfo = null;
        }

        const gicon = appInfo ? appInfo.get_icon() : null;
        if (gicon) {
            iconImage.set_from_gicon(gicon);
        } else {
            const theme = Gtk.IconTheme.get_for_display(Gdk.Display.get_default());
            if (theme.has_icon(wmClass)) {
                iconImage.set_from_icon_name(wmClass);
            } else if (theme.has_icon(wmClass.toLowerCase())) {
                iconImage.set_from_icon_name(wmClass.toLowerCase());
            } else {
                iconImage.set_from_icon_name('application-x-executable-symbolic');
            }
        }
        return iconImage;
    };

    // --- HELPER: ROBUST UPDATE LIST ---
    const updateList = () => {
        let data = {};
        try {
            data = JSON.parse(settings.get_string('geometry-data')) || {};
        } catch(e) {
            console.error(e);
        }

        // Reserved internal keys (e.g. '__aliases__', the learned identity
        // table) are not applications and must never appear as rows.
        const appKeys = Object.keys(data)
            .filter(k => !k.startsWith('__'))
            .sort();

        const describe = (info) => {
            if (!info) return '';
            if (info.max) return _('Maximized');
            if (info.w === undefined || info.x === undefined) return _('No geometry recorded');
            return `Size: ${info.w}\u00d7${info.h} \u2022 Pos: ${info.x},${info.y}`;
        };

        // One row per stored entry. The file manager's Trash and Drive
        // windows are separate ENTRIES (the identity carries the location),
        // not sub-rows of a parent, so nothing here needs a hierarchy.
        const LOC_LABELS = { trash: _('Trash'), drive: _('Drive') };
        const rowDefs = appKeys.map(key => {
            const [base, loc] = key.split('::');
            const name = base.split('.').pop() || base;
            return {
                id: key,
                appKey: key,
                iconKey: base,
                title: loc ? `${name} \u2014 ${LOC_LABELS[loc] || loc}` : name,
                subtitle: describe(data[key] || {}),
            };
        });

        const currentKeys = rowDefs.map(d => d.id);
        const currentKeySet = new Set(currentKeys);

        // 1. REMOVE STALE ROWS
        // Check the memory map. If a key exists in Map but not in Data, delete it.
        for (const [key, rowWidget] of activeRows.entries()) {
            if (!currentKeySet.has(key)) {
                dataGroup.remove(rowWidget);
                activeRows.delete(key);
            }
        }

        // 2. MANAGE EMPTY STATE
        if (currentKeys.length === 0) {
            if (!emptyStateRow) {
                emptyStateRow = new Adw.ActionRow({
                    title: _('No Saved Windows'),
                    subtitle: _('Move windows around to populate this list'),
                    activatable: false
                });
                emptyStateRow.add_prefix(new Gtk.Image({ 
                    icon_name: 'edit-copy-symbolic',
                    pixel_size: 24,
                    css_classes: ['dim-label']
                }));
                dataGroup.add(emptyStateRow);
            }
            return; // Done
        } else {
            // Data present: remove the empty state if it exists
            if (emptyStateRow) {
                dataGroup.remove(emptyStateRow);
                emptyStateRow = null;
            }
        }

        // 3. UPDATE OR CREATE ROWS
        rowDefs.forEach(def => {
            if (activeRows.has(def.id)) {
                // --- UPDATE EXISTING ---
                const row = activeRows.get(def.id);
                if (row.get_subtitle() !== def.subtitle) {
                    row.set_subtitle(def.subtitle);
                }
                return;
            }

            // --- CREATE NEW ---
            const row = new Adw.ActionRow({
                title: def.title,
                subtitle: def.subtitle
            });

            row.add_prefix(getAppIcon(def.iconKey));

            const delBtn = new Gtk.Button({
                icon_name: 'user-trash-symbolic',
                valign: Gtk.Align.CENTER,
                has_frame: false,
                tooltip_text: _('Forget this window')
            });
            delBtn.add_css_class('error');

            delBtn.connect('clicked', () => {
                dataGroup.remove(row);
                activeRows.delete(def.id);

                try {
                    const currentData = JSON.parse(settings.get_string('geometry-data'));
                    if (currentData[def.appKey]) delete currentData[def.appKey];
                    settings.set_string('geometry-data', JSON.stringify(currentData));
                } catch (e) {
                    logError('[Geometry prefs] could not remove entry', e);
                }
            });

            row.add_suffix(delBtn);
            dataGroup.add(row);
            activeRows.set(def.id, row);
        });
    };

    // --- INITIAL BUILD ---
    updateList();

    // --- LIVE UPDATES ---
    let updateTimeoutId = 0;
    const changeSignalId = settings.connect('changed::geometry-data', () => {
        if (updateTimeoutId) return;
        updateTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
            updateTimeoutId = 0;
            updateList();
            return GLib.SOURCE_REMOVE;
        });
    });

    page.connect('destroy', () => {
        if (updateTimeoutId) {
            GLib.source_remove(updateTimeoutId);
            updateTimeoutId = 0;
        }
        if (changeSignalId) settings.disconnect(changeSignalId);
        activeRows.clear();
    });

    // --- SECTION 3: CLEAR ALL ---
    const clearGroup = new Adw.PreferencesGroup();
    page.add(clearGroup);

    const clearRow = new Adw.ActionRow({
        title: _('Clear Saved Geometry'),
        subtitle: _('Remove all remembered window positions and sizes. Entries rebuild as you move windows')
    });

    const clearBtn = new Gtk.Button({
        icon_name: 'edit-clear-all-symbolic', // built-in Adwaita icon
        valign: Gtk.Align.CENTER,
        tooltip_text: _('Clear all saved window geometry'),
    });
    clearBtn.add_css_class('flat'); // low-stakes: data rebuilds through normal use

    clearBtn.connect('clicked', () => {
        // Clearing settings will trigger the signal -> updateList()
        // updateList will see 0 keys -> loop activeRows and remove them all.
        // Preserve the learned identity aliases ('__aliases__'): they are
        // infrastructure (what makes Firefox/Chrome restores instant), not
        // user geometry. Wiping them re-introduced visible late restores
        // until every alias was re-learned.
        let cleared = '{}';
        try {
            const cur = JSON.parse(settings.get_string('geometry-data'));
            if (cur && cur['__aliases__'])
                cleared = JSON.stringify({ '__aliases__': cur['__aliases__'] });
        } catch (e) { logError('[Geometry prefs] stored geometry-data is not valid JSON; clearing', e); }
        settings.set_string('geometry-data', cleared);
    });

    clearRow.add_suffix(clearBtn);
    clearGroup.add(clearRow);

    return page;
}
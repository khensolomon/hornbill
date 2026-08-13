import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';
import Gdk from 'gi://Gdk';
import { AppConfig } from '../config.js';

export function createGeometryUI() {
    const page = new Adw.PreferencesPage();
    const settings = AppConfig.getSettings();

    // Internal tracker for active widgets
    // Map<WindowID, Adw.ActionRow>
    const activeRows = new Map();
    let emptyStateRow = null;

    // --- SECTION 1: SETTINGS ---
    const mainGroup = new Adw.PreferencesGroup({
        title: 'Settings',
    });
    page.add(mainGroup);

    const enableRow = new Adw.SwitchRow({
        title: 'Enable Geometry Saving',
        subtitle: 'Remember window size and position'
    });
    settings.bind('geometry-enabled', enableRow, 'active', Gio.SettingsBindFlags.DEFAULT);
    mainGroup.add(enableRow);

    const wsRow = new Adw.SwitchRow({
        title: 'Restore Workspace',
        subtitle: 'Reopen windows on the workspace they were closed on (recreated if needed)'
    });
    settings.bind('geometry-restore-workspace', wsRow, 'active', Gio.SettingsBindFlags.DEFAULT);
    settings.bind('geometry-enabled', wsRow, 'sensitive', Gio.SettingsBindFlags.GET);

    const x11Row = new Adw.SwitchRow({
        title: 'Manage X11 Windows',
        subtitle: 'Applies to apps running through Xwayland. Disable if X11 apps destabilize the session'
    });
    settings.bind('geometry-manage-x11', x11Row, 'active', Gio.SettingsBindFlags.DEFAULT);
    settings.bind('geometry-enabled', x11Row, 'sensitive', Gio.SettingsBindFlags.GET);
    mainGroup.add(wsRow);
    mainGroup.add(x11Row);

    // --- SECTION 2: DATA LIST ---
    const dataGroup = new Adw.PreferencesGroup({
        title: 'Saved Applications',
        description: 'Manage currently stored window positions'
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
        const currentKeys = Object.keys(data)
            .filter(k => !k.startsWith('__'))
            .sort();
        const currentKeySet = new Set(currentKeys);

        // 1. REMOVE STALE ROWS
        // Check our Memory Map. If a key exists in Map but not in Data, delete it.
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
                    title: 'No Saved Windows',
                    subtitle: 'Move windows around to populate this list',
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
            // We have data, remove empty state if it exists
            if (emptyStateRow) {
                dataGroup.remove(emptyStateRow);
                emptyStateRow = null;
            }
        }

        // 3. UPDATE OR CREATE ROWS
        currentKeys.forEach(key => {
            const info = data[key];
            const subtitleText = `Size: ${info.w}×${info.h} • Pos: ${info.x},${info.y}`;

            if (activeRows.has(key)) {
                // --- UPDATE EXISTING ---
                const row = activeRows.get(key);
                if (row.get_subtitle() !== subtitleText) {
                    row.set_subtitle(subtitleText);
                }
            } else {
                // --- CREATE NEW ---
                const cleanName = key.split('.').pop() || key; 
                const row = new Adw.ActionRow({
                    title: cleanName,
                    subtitle: subtitleText
                });

                row.add_prefix(getAppIcon(key));

                const delBtn = new Gtk.Button({
                    icon_name: 'user-trash-symbolic',
                    valign: Gtk.Align.CENTER,
                    has_frame: false,
                    tooltip_text: 'Forget this window'
                });
                delBtn.add_css_class('error');

                delBtn.connect('clicked', () => {
                    // 1. Remove from UI immediately
                    dataGroup.remove(row);
                    activeRows.delete(key);
                    
                    // 2. Remove from Settings
                    const currentData = JSON.parse(settings.get_string('geometry-data'));
                    if (currentData[key]) {
                        delete currentData[key];
                        settings.set_string('geometry-data', JSON.stringify(currentData));
                    }
                    
                    // 3. Trigger check (handles showing empty state if last item gone)
                    // We call updateList logic again via the signal or manually if needed
                    if (activeRows.size === 0) {
                        // Manually show empty state if we deleted the last one
                        // to ensure instant feedback without waiting for settings signal
                        // (Though the signal will fire shortly after)
                    }
                });

                row.add_suffix(delBtn);
                dataGroup.add(row);
                
                // CRITICAL: Save to map
                activeRows.set(key, row);
            }
        });
    };

    // --- INITIAL BUILD ---
    updateList();

    // --- LIVE UPDATES ---
    let updateTimeout = null;
    const changeSignalId = settings.connect('changed::geometry-data', () => {
        if (updateTimeout) return;
        updateTimeout = setTimeout(() => {
            updateList();
            updateTimeout = null;
        }, 100); 
    });

    page.connect('destroy', () => {
        if (changeSignalId) settings.disconnect(changeSignalId);
        activeRows.clear();
    });

    // --- SECTION 3: CLEAR ALL ---
    const clearGroup = new Adw.PreferencesGroup();
    page.add(clearGroup);

    const clearRow = new Adw.ActionRow({
        title: 'Clear Saved Geometry',
        subtitle: 'Remove all remembered window positions and sizes. Entries rebuild as you move windows'
    });

    const clearBtn = new Gtk.Button({
        icon_name: 'lesion-clear-symbolic', // bundled — theme-proof
        valign: Gtk.Align.CENTER,
        tooltip_text: 'Clear all saved window geometry',
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
        } catch (e) {}
        settings.set_string('geometry-data', cleared);
    });

    clearRow.add_suffix(clearBtn);
    clearGroup.add(clearRow);

    return page;
}
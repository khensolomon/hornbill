import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import { AppConfig } from '../config.js';
import { log, logError } from '../util/logger.js';

// The shell's own extensions service — the same one the official GNOME
// Extensions app drives. A prefs process cannot change live shell state
// directly, but it may call these methods.
const BUS_NAME = 'org.gnome.Shell.Extensions';
const OBJECT_PATH = '/org/gnome/Shell/Extensions';
const IFACE = 'org.gnome.Shell.Extensions';

// Extension "type" as reported by the service.
const TYPE_SYSTEM = 1;
const TYPE_USER = 2;

// Extension "state" (subset we care about).
const STATE_ENABLED = 1;
const STATE_DISABLED = 2;
const STATE_ERROR = 3;
const STATE_UNINSTALLED = 99;

function _proxyAsync(callback) {
    // Async construction — never block the UI thread on D-Bus.
    Gio.DBusProxy.new(
        Gio.DBus.session,
        Gio.DBusProxyFlags.NONE,
        null,
        BUS_NAME,
        OBJECT_PATH,
        IFACE,
        null,
        (source, res) => {
            try {
                callback(Gio.DBusProxy.new_finish(res), null);
            } catch (e) {
                callback(null, e);
            }
        }
    );
}

/**
 * ListExtensions returns a{sa{sv}}: a map of uuid -> info dict. Unpack it
 * into a plain array of { uuid, name, state, type, hasPrefs, ... }.
 * Async: calls back with (array, error).
 */
function _listExtensionsAsync(proxy, callback) {
    proxy.call('ListExtensions', null, Gio.DBusCallFlags.NONE, -1, null, (src, res) => {
        const result = [];
        let reply;
        try {
            reply = proxy.call_finish(res);
        } catch (e) {
            logError('ListExtensions failed', e);
            callback(result, e);
            return;
        }

        try {
            const dict = reply.get_child_value(0); // a{sa{sv}}
            const n = dict.n_children();
            for (let i = 0; i < n; i++) {
                const entry = dict.get_child_value(i); // {s a{sv}}
                const uuid = entry.get_child_value(0).get_string()[0];
                const info = entry.get_child_value(1); // a{sv}

                const get = (key) => {
                    const m = info.n_children();
                    for (let j = 0; j < m; j++) {
                        const kv = info.get_child_value(j);
                        if (kv.get_child_value(0).get_string()[0] === key)
                            return kv.get_child_value(1).get_variant();
                    }
                    return null;
                };

                const nameV = get('name');
                const stateV = get('state');
                const typeV = get('type');
                const prefsV = get('hasPrefs');
                const descV = get('description');

                result.push({
                    uuid,
                    name: nameV ? nameV.get_string()[0] : uuid,
                    description: descV ? descV.get_string()[0] : '',
                    state: stateV ? stateV.get_double() : 0,
                    type: typeV ? typeV.get_double() : 0,
                    hasPrefs: prefsV ? prefsV.get_boolean() : false,
                });
            }
        } catch (e) {
            logError('Failed to unpack extension list', e);
        }
        callback(result, null);
    });
}

export function createExtensionsUI() {
    const page = new Adw.PreferencesPage();

    // A reload hint that appears only when an action needs a session reload
    // to take full effect (e.g. removing an extension).
    const reloadBanner = new Adw.PreferencesGroup();
    const reloadRow = new Adw.ActionRow({
        title: 'Some changes finish after reloading',
        subtitle: 'Log out and back in to complete pending changes.',
    });
    const reloadIcon = new Gtk.Image({ icon_name: 'view-refresh-symbolic', valign: Gtk.Align.CENTER });
    reloadRow.add_prefix(reloadIcon);
    reloadBanner.add(reloadRow);
    reloadBanner.set_visible(false);
    page.add(reloadBanner);

    // A transient status row while the list loads.
    const statusGroup = new Adw.PreferencesGroup();
    const statusRow = new Adw.ActionRow({ title: 'Loading extensions…' });
    const spinner = new Gtk.Spinner({ valign: Gtk.Align.CENTER });
    spinner.start();
    statusRow.add_prefix(spinner);
    statusGroup.add(statusRow);
    page.add(statusGroup);

    // Own extension's uuid, so we never offer to disable/remove ourselves.
    const selfUuid = AppConfig.metadata?.uuid ?? 'lesion@lethil.me';

    const userGroup = new Adw.PreferencesGroup({
        title: 'User Extensions',
        description: 'Installed for your account. These can be enabled, disabled, and removed.',
    });
    const systemGroup = new Adw.PreferencesGroup({
        title: 'System Extensions',
        description: 'Installed system-wide. These can be enabled or disabled, but not removed from here.',
    });
    userGroup.set_visible(false);
    systemGroup.set_visible(false);
    page.add(userGroup);
    page.add(systemGroup);

    let proxy = null;
    let loading = false;
    let loadedOnce = false;
    let _stateChangeSource = 0;

    const rows = [];
    const clearRows = () => {
        for (const r of rows) r.group.remove(r.row);
        rows.length = 0;
    };

    const showReload = () => reloadBanner.set_visible(true);

    // Fire-and-forget action; never blocks the UI.
    const doAction = (method, uuid, onOk) => {
        if (!proxy) return;
        proxy.call(method, new GLib.Variant('(s)', [uuid]),
            Gio.DBusCallFlags.NONE, -1, null, (src, res) => {
                try {
                    proxy.call_finish(res);
                    if (onOk) onOk();
                } catch (e) {
                    logError(`${method} failed for ${uuid}`, e);
                }
            });
    };

    const openPrefs = (uuid) => {
        // Prefer the D-Bus method with a real parent-window handle exported
        // from our own window; without a handle it silently no-ops, which is
        // why it did nothing before. Fall back to the CLI if anything fails.
        const spawnCli = () => {
            try {
                const proc = Gio.Subprocess.new(
                    ['gnome-extensions', 'prefs', uuid],
                    Gio.SubprocessFlags.NONE
                );
                proc.wait_async(null, (p, res) => {
                    try { p.wait_finish(res); }
                    catch (e) { logError('gnome-extensions prefs failed', e); }
                });
            } catch (e) {
                logError('Could not launch extension preferences', e);
            }
        };

        if (!proxy) { spawnCli(); return; }

        proxy.call('OpenExtensionPrefs',
            new GLib.Variant('(ssa{sv})', [uuid, '', {}]),
            Gio.DBusCallFlags.NONE, -1, null, (src, res) => {
                try {
                    proxy.call_finish(res);
                } catch (e) {
                    // Method missing/failed on this shell — use the CLI.
                    spawnCli();
                }
            });
    };

    const buildRow = (ext) => {
        // Lesion itself is filtered out before this point, so no self-handling.
        const isUser = ext.type === TYPE_USER;
        const enabled = ext.state === STATE_ENABLED;

        const row = new Adw.ActionRow({
            title: ext.name || ext.uuid,
            subtitle: ext.uuid,
        });

        if (ext.hasPrefs) {
            const prefsBtn = new Gtk.Button({
                icon_name: 'emblem-system-symbolic',
                tooltip_text: 'Open preference',
                valign: Gtk.Align.CENTER,
                css_classes: ['flat'],
            });
            prefsBtn.connect('clicked', () => openPrefs(ext.uuid));
            row.add_suffix(prefsBtn);
        }

        const removeBtn = new Gtk.Button({
            icon_name: 'user-trash-symbolic',
            tooltip_text: isUser
                ? 'Remove this extension'
                : 'System extensions cannot be removed here',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
            sensitive: isUser,
        });
        removeBtn.connect('clicked', () => {
            _confirmRemove(row.get_root(), ext.name, () => {
                doAction('UninstallExtension', ext.uuid, () => {
                    showReload();
                    refresh();
                });
            });
        });
        row.add_suffix(removeBtn);

        const toggle = new Gtk.Switch({
            active: enabled,
            valign: Gtk.Align.CENTER,
        });
        toggle.connect('state-set', (_sw, state) => {
            doAction(state ? 'EnableExtension' : 'DisableExtension', ext.uuid, null);
            return false; // allow the switch to move immediately
        });
        row.add_suffix(toggle);

        return row;
    };

    const populate = (all) => {
        clearRows();
        statusGroup.set_visible(false);

        const list = all
            .filter(e => e.state !== STATE_UNINSTALLED)
            .filter(e => e.uuid !== selfUuid) // don't manage ourselves
            .sort((a, b) => (a.name || a.uuid).localeCompare(b.name || b.uuid));

        let userCount = 0, systemCount = 0;
        for (const ext of list) {
            const group = ext.type === TYPE_USER ? userGroup : systemGroup;
            const row = buildRow(ext);
            group.add(row);
            rows.push({ group, row });
            if (ext.type === TYPE_USER) userCount++; else systemCount++;
        }

        userGroup.set_visible(userCount > 0);
        systemGroup.set_visible(systemCount > 0);

        if (userCount === 0 && systemCount === 0) {
            statusRow.set_title('No extensions found');
            spinner.stop();
            statusGroup.set_visible(true);
        }
    };

    const refresh = () => {
        if (loading || !proxy) return;
        loading = true;
        _listExtensionsAsync(proxy, (all, err) => {
            loading = false;
            loadedOnce = true;
            if (err) {
                statusRow.set_title('Could not load extensions');
                spinner.stop();
                statusGroup.set_visible(true);
                return;
            }
            populate(all);
        });
    };

    // Build the proxy asynchronously; only then load the list.
    _proxyAsync((p, err) => {
        if (err || !p) {
            logError('Could not reach org.gnome.Shell.Extensions', err);
            spinner.stop();
            statusRow.set_title('Extensions service unavailable');
            statusRow.set_subtitle('Could not reach GNOME Shell.');
            return;
        }
        proxy = p;

        // Live updates: the service emits ExtensionStateChanged whenever any
        // extension is enabled, disabled, installed, or removed — including
        // from the CLI or the official app. Rebuild the list when it fires so
        // our switches always reflect the real state. Debounced, because a
        // single action can emit several signals in a burst.
        try {
            proxy.connect('g-signal', (_proxy, _sender, signalName) => {
                if (signalName !== 'ExtensionStateChanged') return;
                if (_stateChangeSource) return;
                _stateChangeSource = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
                    _stateChangeSource = 0;
                    refresh();
                    return GLib.SOURCE_REMOVE;
                });
            });
        } catch (e) {
            logError('Could not subscribe to ExtensionStateChanged', e);
        }

        refresh();
    });

    // Refresh when the page is re-shown, but not on the very first map (the
    // async load above already covers it) and never while a load is running.
    page.connect('unmap', () => {
        if (_stateChangeSource) {
            GLib.source_remove(_stateChangeSource);
            _stateChangeSource = 0;
        }
    });

    page.connect('map', () => {
        if (loadedOnce && !loading) refresh();
    });

    return page;
}

function _confirmRemove(parent, name, onConfirm) {
    const dialog = new Adw.MessageDialog({
        transient_for: parent,
        modal: true,
        heading: 'Remove extension?',
        body: `“${name}” will be uninstalled from your account. This cannot be undone from here.`,
    });
    dialog.add_response('cancel', 'Cancel');
    dialog.add_response('remove', 'Remove');
    dialog.set_response_appearance('remove', Adw.ResponseAppearance.DESTRUCTIVE);
    dialog.set_default_response('cancel');
    dialog.set_close_response('cancel');
    dialog.connect('response', (_d, response) => {
        if (response === 'remove' && onConfirm) onConfirm();
    });
    dialog.present();
}

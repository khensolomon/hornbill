import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gdk from 'gi://Gdk';
import { AppConfig } from '../config.js';
import { logError } from '../util/logger.js';
import { gettext as _, format } from '../util/gettext.js';

// The shell's own extensions service — the same one the official GNOME
// Extensions app drives. A prefs process cannot change live shell state
// directly, but it may call these methods.
const BUS_NAME = 'org.gnome.Shell.Extensions';
const OBJECT_PATH = '/org/gnome/Shell/Extensions';
const IFACE = 'org.gnome.Shell.Extensions';

// Extension "type" as reported by the service.
const TYPE_USER = 2;

// Extension "state" (only the values this page tests for).
const STATE_ENABLED = 1;
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
                const urlV = get('url');

                result.push({
                    uuid,
                    name: nameV ? nameV.get_string()[0] : uuid,
                    description: descV ? descV.get_string()[0] : '',
                    state: stateV ? stateV.get_double() : 0,
                    type: typeV ? typeV.get_double() : 0,
                    hasPrefs: prefsV ? prefsV.get_boolean() : false,
                    url: urlV ? urlV.get_string()[0] : '',
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
        title: _('Some changes finish after reloading'),
        subtitle: _('Log out and back in to complete pending changes.'),
    });
    const reloadIcon = new Gtk.Image({ icon_name: 'view-refresh-symbolic', valign: Gtk.Align.CENTER });
    reloadRow.add_prefix(reloadIcon);
    reloadBanner.add(reloadRow);
    reloadBanner.set_visible(false);
    page.add(reloadBanner);

    // A transient status row while the list loads.
    const statusGroup = new Adw.PreferencesGroup();
    const statusRow = new Adw.ActionRow({ title: _('Loading extensions…') });
    const spinner = new Gtk.Spinner({ valign: Gtk.Align.CENTER });
    spinner.start();
    statusRow.add_prefix(spinner);
    statusGroup.add(statusRow);
    page.add(statusGroup);

    // The extension's own uuid. Hornbill may be disabled from here (behind a
    // confirmation) but never removed, since uninstalling the running prefs
    // process's own extension is not recoverable from this page.
    const selfUuid = AppConfig.metadata?.uuid ?? 'hornbill@lethil.me';

    const userGroup = new Adw.PreferencesGroup({
        title: _('User Extensions'),
        description: _('Installed for your account. These can be enabled, disabled, and removed.'),
    });
    const systemGroup = new Adw.PreferencesGroup({
        title: _('System Extensions'),
        description: _('Installed system-wide. These can be enabled or disabled, but not removed from here.'),
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

    const buildRow = (ext) => {
        // Hornbill is listed like any other extension. Its toggle works and is
        // confirmed; only its remove button stays insensitive.
        const isUser = ext.type === TYPE_USER;
        const isSelf = ext.uuid === selfUuid;
        const enabled = ext.state === STATE_ENABLED;

        const row = new Adw.ActionRow({
            title: ext.name || ext.uuid,
            subtitle: ext.uuid,
        });

        // OpenExtensionPrefs is unreliable across shell versions (it needs a
        // parent-window handle a prefs process cannot supply, and even the
        // gnome-extensions CLI fallback depends on PATH and the target
        // extension's own prefs.js being well-behaved). A link to the
        // extension's homepage — taken straight from its metadata.json,
        // exposed by the shell's ListExtensions as 'url' — always works and
        // needs nothing from the target extension.
        if (ext.url) {
            const linkBtn = new Gtk.Button({
                icon_name: 'web-browser-symbolic',
                tooltip_text: _('Open extension homepage'),
                valign: Gtk.Align.CENTER,
                css_classes: ['flat'],
            });
            linkBtn.connect('clicked', () => {
                try {
                    Gtk.show_uri(row.get_root(), ext.url, Gdk.CURRENT_TIME);
                } catch (e) {
                    logError('Could not open extension url', e);
                }
            });
            row.add_suffix(linkBtn);
        }

        const removeBtn = new Gtk.Button({
            icon_name: 'user-trash-symbolic',
            tooltip_text: isSelf
                ? 'Cannot remove the extension you are configuring'
                : isUser
                    ? 'Remove this extension'
                    : 'System extensions cannot be removed here',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
            sensitive: isUser && !isSelf,
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
            tooltip_text: isSelf
                ? _('Turning this off disables the extension you are configuring')
                : '',
        });

        // Set while the handler puts the switch back after a cancelled
        // self-disable. set_active() re-emits 'state-set', and without this
        // the revert would be read as the user switching Hornbill back on and
        // fire EnableExtension against an extension that never went off.
        let reverting = false;

        toggle.connect('state-set', (sw, state) => {
            if (reverting) return false;

            // Disabling Hornbill from Hornbill's own preferences is worth a
            // confirmation, matching the indicator's Disable Extension item.
            if (isSelf && !state) {
                _confirmSelfDisable(row.get_root(),
                    () => doAction('DisableExtension', ext.uuid, null),
                    () => {
                        reverting = true;
                        sw.set_active(true);
                        sw.set_state(true);
                        reverting = false;
                    });
                // Hold the underlying state until the user answers. On
                // confirm, ExtensionStateChanged refreshes the whole list and
                // the row is rebuilt from the real state.
                return true;
            }

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
            statusRow.set_title(_('No extensions found'));
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
                statusRow.set_title(_('Could not load extensions'));
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
            statusRow.set_title(_('Extensions service unavailable'));
            statusRow.set_subtitle(_('Could not reach GNOME Shell.'));
            return;
        }
        proxy = p;

        // Live updates: the service emits ExtensionStateChanged whenever any
        // extension is enabled, disabled, installed, or removed — including
        // from the CLI or the official app. Rebuild the list when it fires so
        // the switches always reflect the real state. Debounced, because a
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

function _confirmSelfDisable(parent, onConfirm, onCancel) {
    const dialog = new Adw.MessageDialog({
        transient_for: parent,
        modal: true,
        heading: _('Disable Hornbill?'),
        body: _('The panel customisations and window features provided by this extension will stop. You can re-enable it from this list.'),
    });
    dialog.add_response('cancel', _('Cancel'));
    dialog.add_response('disable', _('Disable'));
    dialog.set_response_appearance('disable', Adw.ResponseAppearance.DESTRUCTIVE);
    dialog.set_default_response('cancel');
    dialog.set_close_response('cancel');
    dialog.connect('response', (_d, response) => {
        if (response === 'disable') onConfirm?.();
        else onCancel?.();
    });
    dialog.present();
}

function _confirmRemove(parent, name, onConfirm) {
    const dialog = new Adw.MessageDialog({
        transient_for: parent,
        modal: true,
        heading: _('Remove extension?'),
        body: format(_('\u201c%s\u201d will be uninstalled from your account. This cannot be undone from here.'), name),
    });
    dialog.add_response('cancel', _('Cancel'));
    dialog.add_response('remove', _('Remove'));
    dialog.set_response_appearance('remove', Adw.ResponseAppearance.DESTRUCTIVE);
    dialog.set_default_response('cancel');
    dialog.set_close_response('cancel');
    dialog.connect('response', (_d, response) => {
        if (response === 'remove' && onConfirm) onConfirm();
    });
    dialog.present();
}

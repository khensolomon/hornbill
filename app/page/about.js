import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import GLib from 'gi://GLib';
import Gdk from 'gi://Gdk';
import { AppConfig } from '../config.js'; 
import { gettext as _ } from '../util/gettext.js';

export function createAboutUI(navigator, goToPage) {
    const page = new Adw.PreferencesPage();
    const metadata = AppConfig.metadata;

    // --- 1. HEADER SECTION ---
    const headerBox = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 6, 
        margin_top: 32,
        margin_bottom: 32,
        halign: Gtk.Align.CENTER
    });

    // Logo Logic
    const rootDir = AppConfig.path || GLib.get_current_dir();
    const iconPath = GLib.build_filenamev([rootDir, 'icon', 'hornbill.svg']);
    
    let logoWidget;
    if (GLib.file_test(iconPath, GLib.FileTest.EXISTS)) {
        logoWidget = new Gtk.Image({ file: iconPath, pixel_size: 96, margin_bottom: 12 });
    } else {
        logoWidget = new Gtk.Image({ icon_name: 'application-x-executable', pixel_size: 96, margin_bottom: 12 });
    }

    // Metadata Labels
    const appName = new Gtk.Label({ label: metadata.name, css_classes: ['title-1'], margin_bottom: 0, wrap: true, justify: Gtk.Justification.CENTER });
    const versionLabel = metadata['version-name']
        ? `${metadata['version-name']} (${metadata.version})`
        : `v${metadata.version}`;
    const version = new Gtk.Label({ label: versionLabel, css_classes: ['title-4', 'dim-label'], margin_bottom: 12 });
    const developer = new Gtk.Label({ label: metadata["developer-name"] || 'Unknown Developer', css_classes: ['heading'] });
    const description = new Gtk.Label({ label: metadata.description || '', justify: Gtk.Justification.CENTER, wrap: true, css_classes: ['body'], margin_top: 6, max_width_chars: 40 });

    headerBox.append(logoWidget);
    headerBox.append(appName);
    headerBox.append(version);
    headerBox.append(developer);
    headerBox.append(description);

    const headerGroup = new Adw.PreferencesGroup();
    headerGroup.add(headerBox);
    page.add(headerGroup);

    // --- SYSTEM / DIAGNOSTICS (moved here from the old dashboard hero) ---
    const sysGroup = new Adw.PreferencesGroup({
        title: _('System'),
    });

    const sessionType = GLib.getenv('XDG_SESSION_TYPE') || 'Unknown';
    sysGroup.add(new Adw.ActionRow({
        title: _('Session'),
        subtitle: sessionType.toUpperCase(),
        activatable: false,
    }));

    const uuidRow = new Adw.ActionRow({
        title: _('Extension UUID'),
        subtitle: AppConfig.uuid,
    });
    const copyBtn = new Gtk.Button({
        icon_name: 'edit-copy-symbolic',
        valign: Gtk.Align.CENTER,
        css_classes: ['flat', 'circular'],
        tooltip_text: _('Copy UUID'),
    });
    copyBtn.connect('clicked', () => {
        Gdk.Display.get_default()?.get_clipboard()?.set(AppConfig.uuid);
    });
    uuidRow.add_suffix(copyBtn);
    sysGroup.add(uuidRow);
    page.add(sysGroup);

    // --- 2. DOCUMENTATION SECTION ---
    // Check if links exist in the metadata loaded by AppConfig
    if (metadata.links && Object.keys(metadata.links).length > 0) {
        const docGroup = new Adw.PreferencesGroup({
            title: _('Documentation'),
            description: _('Resources and help')
        });

        const createLinkRow = (title, uri) => {
            const row = new Adw.ActionRow({ title: title, activatable: true });
            row.add_suffix(new Gtk.Image({ icon_name: 'insert-link-symbolic', css_classes: ['dim-label'] }));
            row.connect('activated', () => {
                try {
                    const launcher = new Gtk.UriLauncher({ uri: uri });
                    launcher.launch(null, null, null);
                } catch (e) {
                    console.error("Gtk.UriLauncher failed:", e);
                }
            });
            return row;
        };

        Object.entries(metadata.links).forEach(([key, rawUrl]) => {
            let targetUrl = rawUrl;
            const isFullUrl = rawUrl.startsWith('http://') || rawUrl.startsWith('https://');

            // Resolve relative URLs using metadata.url
            if (!isFullUrl && metadata.url) {
                const baseUrl = metadata.url.endsWith('/') ? metadata.url.slice(0, -1) : metadata.url;
                const path = rawUrl.startsWith('/') ? rawUrl.slice(1) : rawUrl;
                targetUrl = `${baseUrl}/${path}`;
            }

            const title = key.split(/[-_]/).map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
            docGroup.add(createLinkRow(title, targetUrl));
        });

        page.add(docGroup);
    }

    return page;
}
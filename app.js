#!/usr/bin/env -S gjs --module
/**
 * ./app.js
 * gjs -m app.js
 */
import Gtk from 'gi://Gtk?version=4.0';
import Gdk from 'gi://Gdk?version=4.0';
import Adw from 'gi://Adw?version=1';
import GLib from 'gi://GLib';
import { createUI, installLayout } from './app/window.js';
import { AppConfig } from './app/config.js'; 
import { log } from './app/util/logger.js';

const app = new Adw.Application({
    application_id: AppConfig.defaults.id,
    flags: 0 
});

function loadLocalMetadata() {
    const currentDir = GLib.get_current_dir();
    const metadataPath = GLib.build_filenamev([currentDir, 'metadata.json']);
    if (GLib.file_test(metadataPath, GLib.FileTest.EXISTS)) {
        const [success, contents] = GLib.file_get_contents(metadataPath);
        if (success) {
            const decoder = new TextDecoder('utf-8');
            return JSON.parse(decoder.decode(contents));
        }
    }
    return {};
}

app.connect('activate', () => {
    const metadata = loadLocalMetadata();
    const currentDir = GLib.get_current_dir();

    AppConfig.init(metadata, currentDir, false);

    log("Application activating...");
    log(`Schema ID: ${AppConfig.schemaId}`);

    const display = Gdk.Display.get_default();
    if (display) {
        const iconTheme = Gtk.IconTheme.get_for_display(display);
        iconTheme.add_search_path(currentDir);
    }

    const window = new Adw.ApplicationWindow({
        application: app,
        title: AppConfig.name, 
        default_width: AppConfig.defaults.window.width,
        default_height: AppConfig.defaults.window.height,
        // Match prefs.js settings
        width_request: AppConfig.defaults.window.minWidth,
        height_request: AppConfig.defaults.window.minHeight,
        icon_name: AppConfig.defaults.id 
    });

    const content = createUI();
    window.set_content(content);
    
    installLayout(window, content);

    window.present();
});

app.run([]);
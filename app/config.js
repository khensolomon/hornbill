import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

/**
 * A singleton configuration object.
 * Acts as the Single Source of Truth for App ID, Dimensions, Metadata, and Context.
 */
export const AppConfig = {
    // 1. Static Configuration
    defaults: {
        id: 'org.gnome.shell.extensions.lethil',
        title: 'Gnome Split View',
        window: {
            width: 800,
            height: 600,
            minWidth: 360,
            minHeight: 200
        }
    },

    // 2. Runtime State
    isExtension: false,
    path: null,       
    debug: false,     
    prefix: '[App]',  
    appId: '',        
    
    metadata: {
        name: '', 
        version: '0.0.0',
        description: '',
        url: '',
        links: {},
        "settings-schema": "org.gnome.shell.extensions.lethil", // Default to match XML
        "developer-name": ""
    },
    
    _settings: null,

    init(metadata, path, isExtension = false) {
        this.metadata = { ...this.metadata, ...metadata };
        this.path = path;
        this.isExtension = isExtension;
        this._settings = null; // Path/context may have changed; rebuild lazily
        
        this.debug = this.metadata.debug ?? false;
        
        if (!this.metadata.name) {
            this.metadata.name = this.defaults.title;
        }
        this.prefix = `[${this.metadata.name}]`;

        this.appId = metadata.uuid || this.defaults.id;
    },

    get uuid() {
        return this.metadata.uuid || this.defaults.id;
    },

    get name() {
        return this.metadata.name || this.defaults.title;
    },

    get schemaId() {
        // Critical: Must match schemas/org.gnome.shell.extensions.lethil.gschema.xml
        return this.metadata["settings-schema"] || "org.gnome.shell.extensions.lethil";
    },
    
    get developer() {
        return this.metadata["developer-name"] || "Lethil";
    },

    /**
     * Returns a Gio.Settings for the extension schema.
     *
     * Unlike `new Gio.Settings({ schema_id })`, this resolves the schema from
     * the extension's own `schemas/` directory (falling back to the system
     * source). A missing schema throws a catchable Error instead of aborting
     * the whole process, and the extension no longer needs its schema
     * installed globally in ~/.local/share/glib-2.0/schemas to work.
     */
    getSettings() {
        if (this._settings) return this._settings;
        this._settings = this.createSettings();
        return this._settings;
    },

    /**
     * Returns a NEW, uncached Gio.Settings for the extension schema.
     *
     * Use this for any batch that calls delay()/apply(). g_settings_delay()
     * switches an object into delayed-apply mode permanently — apply() commits
     * the pending writes but does NOT return the object to normal mode, and
     * there is no undelay(). Calling delay() on the shared object returned by
     * getSettings() therefore strands every later write in that process: the
     * preferences UI reads its own pending values back and looks correct while
     * gnome-shell never sees them. Batch on a throwaway object instead.
     */
    createSettings() {
        let source = Gio.SettingsSchemaSource.get_default();
        if (this.path) {
            const dir = GLib.build_filenamev([this.path, 'schemas']);
            if (GLib.file_test(GLib.build_filenamev([dir, 'gschemas.compiled']), GLib.FileTest.EXISTS)) {
                source = Gio.SettingsSchemaSource.new_from_directory(dir, Gio.SettingsSchemaSource.get_default(), false);
            }
        }

        const schema = source.lookup(this.schemaId, true);
        if (!schema)
            throw new Error(`Schema '${this.schemaId}' could not be found for extension ${this.uuid}`);

        return new Gio.Settings({ settings_schema: schema });
    }
};
import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import { AppConfig } from '../config.js';
import { PanelsPresets } from '../data/panels.js';
import { log, logError } from '../util/logger.js';
import { gettext as _, format } from '../util/gettext.js';

export class AppearancePage extends Adw.PreferencesPage {
    static {
        GObject.registerClass(this);
    }

    constructor(goToPage = null) {
        super();

        this._settings = AppConfig.getSettings();
        this._goToPage = goToPage;

        this._initUI();
    }

    _initUI() {
        // --- 1. General Settings ---
        const generalGroup = new Adw.PreferencesGroup({ 
            title: _('General Configuration'),
            description: _('Toggle the entire suite of panel customizations on or off.')
        });
        this.add(generalGroup);

        const enableRow = new Adw.SwitchRow({ title: _('Enable Panel Styling') });
        this._settings.bind('panel-enabled', enableRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        generalGroup.add(enableRow);

        // Reset Button
        const resetRow = new Adw.ActionRow({
            title: _('Reset Style'),
            subtitle: _('Restore panel, popup, and button styling to defaults. Other settings are untouched')
        });
        const resetBtn = new Gtk.Button({
            icon_name: 'edit-clear-symbolic', // built-in Adwaita icon
            valign: Gtk.Align.CENTER,
            tooltip_text: _('Reset styling to defaults')
        });
        resetBtn.add_css_class('flat');
        resetBtn.connect('clicked', () => this._resetStyleSettings());
        resetRow.add_suffix(resetBtn);
        generalGroup.add(resetRow);


        // --- 2. Panel Background ---
        const bgGroup = new Adw.PreferencesGroup({ 
            title: _('Panel Background'),
            description: _('Control the base color, gradients, and transparency levels.')
        });
        this.add(bgGroup);
        
        bgGroup.add(this._createColorRow('Background Color', 'panel-bg-color'));
        
        const gradSwitch = new Adw.SwitchRow({ title: _('Enable Gradient') });
        this._settings.bind('panel-bg-gradient-enabled', gradSwitch, 'active', Gio.SettingsBindFlags.DEFAULT);
        bgGroup.add(gradSwitch);
        
        const gradColorRow = this._createColorRow('Gradient End Color', 'panel-bg-gradient-color');
        this._settings.bind('panel-bg-gradient-enabled', gradColorRow, 'sensitive', Gio.SettingsBindFlags.DEFAULT);
        bgGroup.add(gradColorRow);

        const gradDirRow = this._createComboRow('Gradient Direction', 'panel-bg-gradient-dir', ['Vertical', 'Horizontal'], false);
        this._settings.bind('panel-bg-gradient-enabled', gradDirRow, 'sensitive', Gio.SettingsBindFlags.DEFAULT);
        bgGroup.add(gradDirRow);

        // --- 3.5 Glass Effect (Blur) ---
        const blurGroup = new Adw.PreferencesGroup({ 
            title: _('Glass Effect'),
            description: _('Apply backdrop blur to create a frosted glass look.')
        });
        this.add(blurGroup);

        const blurEnable = new Adw.SwitchRow({ title: _('Enable Backdrop Blur') });
        this._settings.bind('panel-blur-enabled', blurEnable, 'active', Gio.SettingsBindFlags.DEFAULT);
        blurGroup.add(blurEnable);

        const sigmaRow = this._createSpinRow('Blur Radius', 'panel-blur-sigma', 0, 100);
        this._settings.bind('panel-blur-enabled', sigmaRow, 'sensitive', Gio.SettingsBindFlags.DEFAULT);
        blurGroup.add(sigmaRow);

        // --- 3.6 Geometry (Floating) ---
        const geomGroup = new Adw.PreferencesGroup({ 
            title: _('Geometry &amp; Floating'),
            description: _('Detach the panel from the screen edges.')
        });
        this.add(geomGroup);

        geomGroup.add(this._createSpinRow('Outer Margin', 'panel-margin', 0, 100));
        geomGroup.add(this._createSpinRow('Panel Corner Radius', 'panel-corner-radius', 0, 50));

        // --- 4. Panel Border ---
        const borderGroup = new Adw.PreferencesGroup({ 
            title: _('Panel Border'),
            description: _('Define the outline of the panel.')
        });
        this.add(borderGroup);

        borderGroup.add(this._createSpinRow('Size', 'panel-border-size', 0, 10));
        borderGroup.add(this._createColorRow('Color', 'panel-border-color'));
        
        const borderStyles = ['Solid','Dotted','Dashed','Double','Groove','Ridge','Inset','Outset','None'];
        borderGroup.add(this._createComboRow('Style', 'panel-border-style', borderStyles, true));
        
        const bottomOnly = new Adw.SwitchRow({ 
            title: _('Content-Side Border Only'), 
            subtitle: _('Applies border to the bottom (if Top Panel) or top (if Bottom Panel)') 
        });
        this._settings.bind('panel-border-bottom-only', bottomOnly, 'active', Gio.SettingsBindFlags.DEFAULT);
        borderGroup.add(bottomOnly);

        // --- 5. Panel Shadow ---
        const shadowGroup = new Adw.PreferencesGroup({ 
            title: _('Panel Shadow'),
            description: _('Add depth using drop shadows or inner shadow effects.')
        });
        this.add(shadowGroup);

        const shEnable = new Adw.SwitchRow({ title: _('Enable Shadow') });
        this._settings.bind('panel-shadow-enabled', shEnable, 'active', Gio.SettingsBindFlags.DEFAULT);
        shadowGroup.add(shEnable);

        const bindShadow = (widget) => {
            this._settings.bind('panel-shadow-enabled', widget, 'sensitive', Gio.SettingsBindFlags.DEFAULT);
            shadowGroup.add(widget);
        };

        bindShadow(this._createColorRow('Color', 'panel-shadow-color'));
        bindShadow(this._createSpinRow('Offset X', 'panel-shadow-x', -50, 50));
        bindShadow(this._createSpinRow('Offset Y', 'panel-shadow-y', -50, 50));
        bindShadow(this._createSpinRow('Blur', 'panel-shadow-blur', 0, 50));
        bindShadow(this._createSpinRow('Spread', 'panel-shadow-spread', -20, 50));
        
        const insetSw = new Adw.SwitchRow({ title: _('Inset Shadow') });
        this._settings.bind('panel-shadow-inset', insetSw, 'active', Gio.SettingsBindFlags.DEFAULT);
        bindShadow(insetSw);

        // --- 6. Panel Buttons ---
        const btnGroup = new Adw.PreferencesGroup({ 
            title: _('Panel Buttons'),
            description: _('Fine-tune the shape and padding of panel items.')
        });
        this.add(btnGroup);
        
        btnGroup.add(this._createColorRow('Text &amp; Icon Color', 'panel-btn-color'));
        btnGroup.add(this._createSpinRow('Corner Radius', 'panel-btn-radius', 0, 50));
        btnGroup.add(this._createSpinRow('Min Padding', 'panel-btn-pad-min', 0, 50));
        btnGroup.add(this._createSpinRow('Natural Padding', 'panel-btn-pad-nat', 0, 50));

        const hEnable = new Adw.SwitchRow({ title: _('Enable Hover Effect') });
        this._settings.bind('panel-btn-hover-enabled', hEnable, 'active', Gio.SettingsBindFlags.DEFAULT);
        btnGroup.add(hEnable);

        const hColorRow = this._createColorRow('Hover Background', 'panel-btn-bg-hover');
        this._settings.bind('panel-btn-hover-enabled', hColorRow, 'sensitive', Gio.SettingsBindFlags.DEFAULT);
        btnGroup.add(hColorRow);

        const aColorRow = this._createColorRow('Active Background', 'panel-btn-bg-active');
        this._settings.bind('panel-btn-hover-enabled', aColorRow, 'sensitive', Gio.SettingsBindFlags.DEFAULT);
        btnGroup.add(aColorRow);

        // --- 6b. App Buttons ---
        // These keys drive the buttons Lesion adds to the panel (Show Apps,
        // favorites, running apps, drives, trash) and are read by
        // components/apps.js. They live next to Panel Buttons because that is
        // where users look for them, but they are NOT bound to 'panel-enabled':
        // that key only gates components/panels.js, and the app buttons keep
        // rendering with panel styling switched off.
        const appBtnGroup = new Adw.PreferencesGroup({
            title: _('App Buttons'),
            description: _('Icon size, padding, and opacity for Lesion\u2019s own panel buttons.')
        });
        this.add(appBtnGroup);

        appBtnGroup.add(this._createSpinRow('Icon Size', 'apps-icon-size', 12, 64, 2));
        appBtnGroup.add(this._createSpinRow(
            'Item Padding', 'apps-btn-padding', 0, 24, 1,
            _('Horizontal space inside each item, independent of panel button padding')));

        const desatRow = new Adw.SwitchRow({ title: _('Monochrome Icons') });
        this._settings.bind('apps-icon-desaturate', desatRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        appBtnGroup.add(desatRow);

        appBtnGroup.add(this._createSpinRow(
            'Running Opacity', 'apps-opacity-running', 0, 255, 5,
            _('Opacity for running apps (0-255)')));
        appBtnGroup.add(this._createSpinRow(
            'Stopped Opacity', 'apps-opacity-stopped', 0, 255, 5,
            _('Opacity for inactive favorites (0-255)')));

        // --- 7. Popup Menus ---
        const popupGroup = new Adw.PreferencesGroup({ 
            title: _('Popup Menus'),
            description: _('Style the dropdown menus.')
        });
        this.add(popupGroup);
        
        popupGroup.add(this._createSpinRow('Corner Radius', 'popup-radius', 0, 50));
        
        // Popup Border
        popupGroup.add(this._createSpinRow('Border Size', 'popup-border-size', 0, 10));
        popupGroup.add(this._createColorRow('Border Color', 'popup-border-color'));
        popupGroup.add(this._createComboRow('Border Style', 'popup-border-style', borderStyles, true));

        // Popup Shadow
        const psEnable = new Adw.SwitchRow({ title: _('Enable Shadow') });
        this._settings.bind('popup-shadow-enabled', psEnable, 'active', Gio.SettingsBindFlags.DEFAULT);
        popupGroup.add(psEnable);

        const bindPopupShadow = (widget) => {
            this._settings.bind('popup-shadow-enabled', widget, 'sensitive', Gio.SettingsBindFlags.DEFAULT);
            popupGroup.add(widget);
        };

        bindPopupShadow(this._createColorRow('Shadow Color', 'popup-shadow-color'));
        bindPopupShadow(this._createSpinRow('Shadow X', 'popup-shadow-x', -50, 50));
        bindPopupShadow(this._createSpinRow('Shadow Y', 'popup-shadow-y', -50, 50));
        bindPopupShadow(this._createSpinRow('Shadow Blur', 'popup-shadow-blur', 0, 100));
        bindPopupShadow(this._createSpinRow('Shadow Spread', 'popup-shadow-spread', -50, 50));

        // Lock all groups if main enable is off
        const groups = [bgGroup, borderGroup, shadowGroup, btnGroup, popupGroup];
        groups.forEach(g => {
            this._settings.bind('panel-enabled', g, 'sensitive', Gio.SettingsBindFlags.DEFAULT);
        });

        // --- 9. Presets (last: applying one rewrites every group above) ---
        this._buildPresetsGroup();
    }

    _buildPresetsGroup() {
        const presetsGroup = new Adw.PreferencesGroup({ 
            title: _('Presets'),
            description: _('Quickly apply a pre-defined theme.')
        });
        this._settings.bind('panel-enabled', presetsGroup, 'sensitive', Gio.SettingsBindFlags.DEFAULT);
        this.add(presetsGroup);

        if (AppConfig.debug) { 
            const copyRow = new Adw.ActionRow({
                title: _('Dev: Export Config'),
                subtitle: _('Generate JSON configuration for new presets.')
            });

            const viewBtn = new Gtk.Button({
                icon_name: 'text-x-generic-symbolic',
                valign: Gtk.Align.CENTER,
                tooltip_text: _('View JSON Code')
            });
            viewBtn.add_css_class('flat');
            
            viewBtn.connect('clicked', () => {
                 const json = this._generateConfigJSON();
                 this._showDebugDialog(json);
            });

            const copyBtn = new Gtk.Button({
                icon_name: 'edit-copy-symbolic',
                valign: Gtk.Align.CENTER,
                tooltip_text: _('Copy to Clipboard')
            });
            copyBtn.add_css_class('flat');

            copyBtn.connect('clicked', () => {
                this._handleCopyAction(copyBtn);
            });

            copyRow.add_suffix(viewBtn);
            copyRow.add_suffix(copyBtn);
            presetsGroup.add(copyRow);
        }

        PanelsPresets.forEach(preset => {
            const row = new Adw.ActionRow({ 
                title: _(preset.name),
                subtitle: preset.description
            });
            
            const applyBtn = new Gtk.Button({ 
                icon_name: 'media-playback-start-symbolic',
                valign: Gtk.Align.CENTER,
                tooltip_text: format(_('Apply %s'), preset.name)
            });
            
            applyBtn.add_css_class('flat');
            applyBtn.connect('clicked', () => this._applyPreset(preset.data));
            row.add_suffix(applyBtn);
            presetsGroup.add(row);
        });
    }

    // --- Reset Logic ---
    /** Resets ONLY the styling keys handled by this page (panel, popup,
     *  button styling, and the apps toggles the presets touch). A full
     *  reset of every setting lives on Dashboard -> Data Management. */
    _resetStyleSettings() {
        // Use delay/apply here too for consistency
        this._settings.delay();
        
        const keys = [
            'panel-enabled', 'panel-position',
            'panel-bg-color', 'panel-bg-gradient-enabled', 'panel-bg-gradient-color', 'panel-bg-gradient-dir',
            'panel-border-size', 'panel-border-color', 'panel-border-style', 'panel-border-bottom-only',
            'panel-shadow-enabled', 'panel-shadow-color', 'panel-shadow-x', 'panel-shadow-y', 'panel-shadow-blur', 'panel-shadow-spread', 'panel-shadow-inset',
            'panel-btn-radius', 'panel-btn-pad-min', 'panel-btn-pad-nat', 'panel-btn-hover-enabled', 'panel-btn-bg-hover', 'panel-btn-bg-active',
            'popup-radius', 'popup-border-size', 'popup-border-color', 'popup-border-style',
            'popup-shadow-enabled', 'popup-shadow-color', 'popup-shadow-x', 'popup-shadow-y', 'popup-shadow-blur', 'popup-shadow-spread',
            'panel-blur-enabled', 'panel-blur-sigma', 'panel-margin', 'panel-corner-radius',
            'apps-showgrid-enabled', 'apps-favorites-enabled', 'apps-running-enabled',
            'apps-disks-enabled', 'apps-trash-enabled',
            'panel-btn-color'
        ];

        keys.forEach(key => {
            this._settings.reset(key);
        });
        
        this._settings.apply(); // Commit bulk changes
        log('Panel settings reset to defaults.');
    }

    _applyPreset(presetData) {
        // START BATCHING
        this._settings.delay();
        
        // Keys backed by schema enums must go through set_enum.
        // NOTE: 'panel-bg-gradient-dir' is a plain int key (type="i") and was
        // wrongly listed here before — set_enum on it throws mid-batch.
        const enumKeys = [
            'panel-border-style', 'popup-border-style', 'panel-position',
            'apps-showgrid-pos', 'apps-favorites-pos', 'apps-running-pos',
            'apps-disks-pos', 'apps-trash-pos', 'apps-overview-pos'
        ];
        
        Object.keys(presetData).forEach(key => {
            const val = presetData[key];
            const type = typeof val;

            if (enumKeys.includes(key)) {
                this._settings.set_enum(key, val);
                return;
            }

            if (type === 'boolean') {
                this._settings.set_boolean(key, val);
            } else if (type === 'string') {
                this._settings.set_string(key, val);
            } else if (type === 'number') {
                this._settings.set_int(key, val);
            }
        });
        
        // COMMIT BATCH
        this._settings.apply();

        // The controls on this page read their values at construction, so
        // after a preset writes new ones the page would keep showing the
        // old state (colours in particular). Rebuilding the page re-reads
        // everything, so what is displayed matches what was applied.
        if (this._goToPage) {
            try {
                this._goToPage('panel-appearance');
            } catch (e) {
                console.error('Preset applied but page refresh failed', e);
            }
        }
    }

    _generateConfigJSON() {
        const targetKeys = [
            'panel-enabled',
            'panel-position',
            'panel-bg-color', 'panel-bg-gradient-enabled', 'panel-bg-gradient-color', 'panel-bg-gradient-dir',
            'panel-border-size', 'panel-border-color', 'panel-border-style', 'panel-border-bottom-only',
            'panel-shadow-enabled', 'panel-shadow-color', 'panel-shadow-x', 'panel-shadow-y', 'panel-shadow-blur', 'panel-shadow-spread', 'panel-shadow-inset',
            'panel-btn-radius', 'panel-btn-pad-min', 'panel-btn-pad-nat', 'panel-btn-hover-enabled', 'panel-btn-bg-hover', 'panel-btn-bg-active',
            'popup-radius', 
            'popup-border-size', 'popup-border-color', 'popup-border-style',
            'popup-shadow-enabled', 'popup-shadow-color', 'popup-shadow-x', 'popup-shadow-y', 'popup-shadow-blur', 'popup-shadow-spread',
            'panel-blur-enabled', 'panel-blur-sigma', 'panel-margin', 'panel-corner-radius',
            'apps-showgrid-enabled', 'apps-favorites-enabled', 'apps-running-enabled',
            'panel-btn-color'
        ];
        
        const availableKeys = this._settings.list_keys();
        const data = {};

        targetKeys.forEach(k => {
            if (availableKeys.includes(k)) {
                const value = this._settings.get_value(k);
                if (value) data[k] = value.deep_unpack();
            }
        });

        const exportObj = {
            name: "New Preset Name",
            description: "Description...",
            data: data
        };

        return JSON.stringify(exportObj, null, 4);
    }

    _handleCopyAction(copyBtn) {
        try {
            const json = this._generateConfigJSON();
            log('Generated JSON for clipboard:', json);

            let display = copyBtn.get_display();
            if (!display) display = Gdk.Display.get_default();
            
            if (display) {
                const clipboard = display.get_clipboard();
                
                try {
                    clipboard.set_text(json);
                    log('Clipboard set using set_text()');
                } catch (e) {
                    logError('set_text failed, trying set_content', e);
                    try {
                        const content = Gdk.ContentProvider.new_for_value(json);
                        clipboard.set_content(content);
                        log('Clipboard set using Gdk.ContentProvider');
                    } catch (e2) {
                        logError('All clipboard methods failed', e2);
                        throw e2; 
                    }
                }
                
                copyBtn.set_icon_name('emblem-ok-symbolic');
            } else {
                logError('No display found for clipboard');
                copyBtn.set_icon_name('dialog-warning-symbolic');
            }
            
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => {
                copyBtn.set_icon_name('edit-copy-symbolic');
                return GLib.SOURCE_REMOVE;
            });

        } catch (err) {
            logError('Copy Failed:', err);
            copyBtn.set_icon_name('dialog-error-symbolic');
        }
    }

    _showDebugDialog(jsonString) {
        const win = new Adw.Window({
            title: _('Preset Configuration'),
            modal: true,
            transient_for: this.get_root(),
            default_width: 500,
            default_height: 400
        });

        const toolbarView = new Adw.ToolbarView();
        const header = new Adw.HeaderBar();
        toolbarView.add_top_bar(header);

        const scroller = new Gtk.ScrolledWindow({ 
            vexpand: true, 
            hexpand: true 
        });
        scroller.add_css_class('frame');

        const textView = new Gtk.TextView({ 
            monospace: true, 
            wrap_mode: Gtk.WrapMode.NONE,
            editable: false,
            cursor_visible: true,
            top_margin: 12, bottom_margin: 12,
            left_margin: 12, right_margin: 12
        });
        
        textView.get_buffer().set_text(jsonString, -1);
        scroller.set_child(textView);
        
        toolbarView.set_content(scroller);
        win.set_content(toolbarView);
        win.present();
    }

    // --- Helpers ---

    _createColorRow(title, key) {
        const row = new Adw.ActionRow({ title: title });
        const dialog = new Gtk.ColorDialog();
        const btn = new Gtk.ColorDialogButton({ dialog, valign: Gtk.Align.CENTER });
        const rgba = new Gdk.RGBA();
        const savedVal = this._settings.get_string(key);
        if (savedVal && rgba.parse(savedVal)) btn.set_rgba(rgba);

        btn.connect('notify::rgba', () => {
            const c = btn.get_rgba();
            const hexStr = `rgba(${Math.round(c.red*255)},${Math.round(c.green*255)},${Math.round(c.blue*255)},${c.alpha.toFixed(2)})`; 
            this._settings.set_string(key, hexStr);
        });
        row.add_suffix(btn);
        return row;
    }

    _createSpinRow(title, key, min, max, step = 1, subtitle = null) {
        const row = new Adw.SpinRow({
            title: title,
            adjustment: new Gtk.Adjustment({ lower: min, upper: max, step_increment: step }),
            value: this._settings.get_int(key)
        });
        if (subtitle) row.set_subtitle(subtitle);
        this._settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
        return row;
    }

    _createComboRow(title, key, options, isEnum = true) {
        const model = new Gtk.StringList();
        options.forEach(opt => model.append(opt));
        
        let initialVal;
        if (isEnum) {
            initialVal = this._settings.get_enum(key);
        } else {
            initialVal = this._settings.get_int(key);
        }
        
        const row = new Adw.ComboRow({ title: title, model: model, selected: initialVal });
        row.connect('notify::selected', () => {
            if (isEnum) {
                this._settings.set_enum(key, row.selected);
            } else {
                this._settings.set_int(key, row.selected);
            }
        });
        return row;
    }
}

// Backward compatibility wrapper
export function createAppearanceUI(navigator, goToPage) {
    return new AppearancePage(goToPage);
}
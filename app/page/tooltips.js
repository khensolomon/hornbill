import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import { AppConfig } from '../config.js';
import { log, logError } from '../util/logger.js';
import { gettext as _ } from '../util/gettext.js';

const BORDER_STYLES = ['Solid', 'Dotted', 'Dashed', 'Double', 'Groove', 'Ridge', 'Inset', 'Outset', 'None'];
const FONT_WEIGHTS = ['Light', 'Normal', 'Medium', 'Bold'];

/**
 * Styling for the hover labels on Lesion's own panel buttons.
 *
 * The keys keep the 'apps-tooltip-' prefix because components/apps.js owns the
 * buttons these label; the page sits under Panel because that is where the
 * rest of the styling lives.
 */
export class TooltipsPage extends Adw.PreferencesPage {
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
        // --- 1. Behaviour ---
        const behaviourGroup = new Adw.PreferencesGroup({
            title: _('Behaviour'),
            description: _('Hover labels naming each button Lesion adds to the panel.')
        });
        this.add(behaviourGroup);

        const enableRow = new Adw.SwitchRow({
            title: _('Enable Tooltips'),
            subtitle: _('Name each button on hover')
        });
        this._settings.bind('apps-tooltips-enabled', enableRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        behaviourGroup.add(enableRow);

        // Reset sits with the master switch so it is reachable even when
        // everything below is insensitive.
        const resetRow = new Adw.ActionRow({
            title: _('Reset Tooltip Style'),
            subtitle: _('Restore appearance to defaults. Enable and delay are untouched')
        });
        const resetBtn = new Gtk.Button({
            icon_name: 'edit-clear-symbolic',
            valign: Gtk.Align.CENTER,
            tooltip_text: _('Reset tooltip styling to defaults')
        });
        resetBtn.add_css_class('flat');
        resetBtn.connect('clicked', () => this._resetStyle());
        resetRow.add_suffix(resetBtn);
        behaviourGroup.add(resetRow);

        const styleGroups = [];

        behaviourGroup.add(this._createSpinRow(
            'Delay', 'apps-tooltip-delay', 0, 2000, 50,
            _('Milliseconds of hover before the tooltip appears')));
        behaviourGroup.add(this._createSpinRow(
            'Offset', 'apps-tooltip-offset', 0, 40, 1,
            _('Gap between the button edge and the tooltip')));

        // --- 2. Text ---
        const textGroup = new Adw.PreferencesGroup({
            title: _('Text'),
            description: _('Colour and typeface of the label.')
        });
        this.add(textGroup);
        styleGroups.push(textGroup);

        textGroup.add(this._createColorRow('Text Color', 'apps-tooltip-text-color'));
        textGroup.add(this._createSpinRow('Font Size', 'apps-tooltip-font-size', 6, 32, 1));
        textGroup.add(this._createComboRow('Font Weight', 'apps-tooltip-font-weight', FONT_WEIGHTS));

        // --- 3. Background ---
        const bgGroup = new Adw.PreferencesGroup({
            title: _('Background'),
            description: _('Fill colour, corner rounding, and internal spacing.')
        });
        this.add(bgGroup);
        styleGroups.push(bgGroup);

        bgGroup.add(this._createColorRow('Background Color', 'apps-tooltip-bg-color'));
        bgGroup.add(this._createSpinRow('Corner Radius', 'apps-tooltip-radius', 0, 40, 1));
        bgGroup.add(this._createSpinRow(
            'Horizontal Padding', 'apps-tooltip-pad-x', 0, 40, 1,
            _('Space between the text and the left and right edges')));
        bgGroup.add(this._createSpinRow(
            'Vertical Padding', 'apps-tooltip-pad-y', 0, 40, 1,
            _('Space between the text and the top and bottom edges')));

        // --- 4. Border ---
        const borderGroup = new Adw.PreferencesGroup({
            title: _('Border'),
            description: _('Set the size above zero to draw a border.')
        });
        this.add(borderGroup);
        styleGroups.push(borderGroup);

        borderGroup.add(this._createSpinRow('Border Size', 'apps-tooltip-border-size', 0, 10, 1));
        borderGroup.add(this._createColorRow('Border Color', 'apps-tooltip-border-color'));
        borderGroup.add(this._createComboRow('Border Style', 'apps-tooltip-border-style', BORDER_STYLES));

        // --- 5. Shadow ---
        const shadowGroup = new Adw.PreferencesGroup({
            title: _('Shadow'),
            description: _('Drop shadow cast by the tooltip.')
        });
        this.add(shadowGroup);
        styleGroups.push(shadowGroup);

        const shEnable = new Adw.SwitchRow({ title: _('Enable Shadow') });
        this._settings.bind('apps-tooltip-shadow-enabled', shEnable, 'active', Gio.SettingsBindFlags.DEFAULT);
        shadowGroup.add(shEnable);

        const bindShadow = (widget) => {
            this._settings.bind('apps-tooltip-shadow-enabled', widget, 'sensitive', Gio.SettingsBindFlags.GET);
            shadowGroup.add(widget);
        };

        bindShadow(this._createColorRow('Shadow Color', 'apps-tooltip-shadow-color'));
        bindShadow(this._createSpinRow('Shadow X', 'apps-tooltip-shadow-x', -50, 50, 1));
        bindShadow(this._createSpinRow('Shadow Y', 'apps-tooltip-shadow-y', -50, 50, 1));
        bindShadow(this._createSpinRow('Shadow Blur', 'apps-tooltip-shadow-blur', 0, 100, 1));
        bindShadow(this._createSpinRow('Shadow Spread', 'apps-tooltip-shadow-spread', -50, 50, 1));

        // Everything below Behaviour is dead while tooltips are off.
        styleGroups.forEach(g => {
            this._settings.bind('apps-tooltips-enabled', g, 'sensitive', Gio.SettingsBindFlags.GET);
        });
    }

    _resetStyle() {
        // Batch on a throwaway object: delay() is permanent for the lifetime of
        // the object it is called on, so using the shared settings here would
        // strand every later write in this process.
        const batch = AppConfig.createSettings();
        batch.delay();

        [
            'apps-tooltip-offset',
            'apps-tooltip-text-color', 'apps-tooltip-font-size', 'apps-tooltip-font-weight',
            'apps-tooltip-bg-color', 'apps-tooltip-radius', 'apps-tooltip-pad-x', 'apps-tooltip-pad-y',
            'apps-tooltip-border-size', 'apps-tooltip-border-color', 'apps-tooltip-border-style',
            'apps-tooltip-shadow-enabled', 'apps-tooltip-shadow-color',
            'apps-tooltip-shadow-x', 'apps-tooltip-shadow-y',
            'apps-tooltip-shadow-blur', 'apps-tooltip-shadow-spread',
        ].forEach(key => batch.reset(key));

        batch.apply();
        log('Tooltip style reset to defaults.');

        // Colour buttons and combo rows read their value at construction, so
        // without a rebuild the page would keep showing pre-reset state. Same
        // navigation trick AppearancePage._resetStyleSettings uses.
        try {
            if (this._goToPage) this._goToPage('panel-tooltips');
        } catch (e) {
            logError('Tooltip style reset, but page refresh failed', e);
        }
    }

    // --- Helpers ---

    _createColorRow(title, key) {
        const row = new Adw.ActionRow({ title: _(title) });
        const dialog = new Gtk.ColorDialog({ with_alpha: true });
        const btn = new Gtk.ColorDialogButton({ dialog, valign: Gtk.Align.CENTER });
        const rgba = new Gdk.RGBA();
        const savedVal = this._settings.get_string(key);
        if (savedVal && rgba.parse(savedVal)) btn.set_rgba(rgba);

        btn.connect('notify::rgba', () => {
            const c = btn.get_rgba();
            this._settings.set_string(key,
                `rgba(${Math.round(c.red * 255)},${Math.round(c.green * 255)},${Math.round(c.blue * 255)},${c.alpha.toFixed(2)})`);
        });
        row.add_suffix(btn);
        return row;
    }

    _createSpinRow(title, key, min, max, step = 1, subtitle = null) {
        const row = new Adw.SpinRow({
            title: _(title),
            adjustment: new Gtk.Adjustment({ lower: min, upper: max, step_increment: step }),
            value: this._settings.get_int(key)
        });
        if (subtitle) row.set_subtitle(subtitle);
        this._settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
        return row;
    }

    _createComboRow(title, key, options) {
        const model = new Gtk.StringList();
        options.forEach(opt => model.append(_(opt)));

        const row = new Adw.ComboRow({
            title: _(title),
            model: model,
            selected: this._settings.get_enum(key)
        });
        row.connect('notify::selected', () => {
            this._settings.set_enum(key, row.selected);
        });
        return row;
    }
}

export function createTooltipsUI(navigator, goToPage) {
    return new TooltipsPage(goToPage);
}

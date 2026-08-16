# Translations

Lesion uses standard gettext. User-facing strings in the code are wrapped in
`_()` (and data-table strings in `N_()`), extracted into a template, translated
per language, and compiled into `locale/` where the shell loads them at runtime.

- Text domain: **`lesion`** (set as `gettext-domain` in `metadata.json`).
- Helpers live in `app/util/gettext.js` and work in the shell process, the prefs
  process, and the standalone `gjs -m app.js` harness.
- Compiled catalogs load from `locale/<lang>/LC_MESSAGES/lesion.mo`.

## Layout

    po/
      POTFILES.in        list of source files scanned for strings
      lesion.pot         extracted template (the canonical English source)
      en.po              English catalog
      manage.py          unified python tool to update, compile, and add languages
    locale/
      <lang>/LC_MESSAGES/lesion.mo

## Marking strings in code

Display strings are translated where they are shown:

    import { gettext as _ } from '../util/gettext.js';
    new Adw.SwitchRow({ title: _('Move Clock') });

Strings stored in data tables are marked with `N_()` at definition (so they are
extracted) and translated at the display site with `_()`:

    // app/data/panels.js
    import { N_ } from '../util/gettext.js';
    { name: N_('macOS Light'), /* … */ }

    // app/page/appearance.js — at display
    title: _(preset.name)

For runtime values, use `format()` so placeholders stay translatable:

    import { gettext as _, format } from '../util/gettext.js';
    format(_('Apply %s'), preset.name)

## Common tasks

Re-extract after adding or changing strings, then recompile:

    ./po/manage.py update
    ./po/manage.py compile

Start a new language (creates `po/<lang>.po` from the template):

    ./po/manage.py add de
    # translate the msgstr entries in po/de.po, then:
    ./po/manage.py compile

You can also view inline help and command descriptions at any time by running:

    ./po/manage.py --help

The management script requires the standard `gettext` tools (`xgettext`, `msgfmt`, `msgmerge`, `msginit`) to be installed on your system[cite: 6].
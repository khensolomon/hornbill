# Hornbill

Personalize the GNOME desktop from one place — panel, clock, apps, windows, and wallpaper.

Supports GNOME Shell 46–50.

## Features

**Panel** — colors, gradients, blur, borders, shadows, popup menu styling, and per-button appearance. Reorder items or move them between left, center, and right. Presets included, among them a macOS menu bar and a Windows 11 taskbar.

**Apps** — favorites, running apps, removable drives, and trash as panel buttons, each with a hover tooltip and an open or focused indicator.

**Clock** — reposition it, reformat it, or split it into two lines.

**Windows** — remember each application's size and position, round window and screen corners, and dim unfocused windows.

**Wallpaper** — separate light and dark images and colors, with blur, monochrome, and brightness applied to the desktop background.

**Advanced** — custom CSS, a manager for your other extensions, and export, import, or reset settings by group.

## Install

### From a release

The built package, exactly as verified by CI. Nothing to compile.

```sh
curl -LO https://github.com/khensolomon/hornbill/releases/latest/download/hornbill@lethil.me.shell-extension.zip
gnome-extensions install --force hornbill@lethil.me.shell-extension.zip
gnome-extensions enable hornbill@lethil.me
```

`install` does not enable, hence the second command. Log out and back in afterwards — on Wayland the shell will not load a new extension until you do.

### From extensions.gnome.org

Search for **Hornbill** and install from there. Updates arrive through the Extensions app.

### From source

```sh
curl https://raw.githubusercontent.com/khensolomon/hornbill/master/install.py | python3 -
```

Prefer to read it first:

```sh
curl -O https://raw.githubusercontent.com/khensolomon/hornbill/master/install.py
python3 install.py
```

### Which one

| | Release | Source |
|---|---|---|
| Version | The latest release | Whatever is on `master` |
| Needs | Nothing | `glib-compile-schemas` (already on any GNOME system) |
| Enables it for you | No | Yes |
| Removes an old Lesion install | No | Yes |

Use a release unless you want unreleased changes. `install.py --ref v26.09.01.90` pins a tag instead of tracking `master`.

## Usage

Click the Hornbill icon in the panel for preferences, or right-click it for a quick menu. Pages follow the areas above: Dashboard, Wallpaper, Panel, Window, Advanced.

Settings can be exported, imported, or reset by group under **Dashboard → Data Management**. Saved window positions are excluded by default, since they describe your desktop rather than your preferences.

## Development

`schemas/gschemas.compiled` and `locale/*/LC_MESSAGES/*.mo` are generated and **not committed**. A fresh clone has neither, so build once before the extension will run — otherwise preferences cannot open, because there is no compiled schema to read.

```sh
python3 build.py              # compile assets, package to tmp/
python3 build.py --strict     # fail, rather than warn, if a tool is missing
python3 build.py --ego        # the extensions.gnome.org submission package
python3 install.py --mode dev # link this tree into place, for development
```

Translations:

```sh
python3 po/manage.py update    # rescan sources into po/hornbill.pot and merge
python3 po/manage.py compile   # build the .mo files
```

`update` needs `xgettext` (the `gettext` package) — it is a maintainer task. `compile` prefers `msgfmt` for its validation but falls back to a built-in MO writer, which is why installing never requires gettext.

Layout: `app/components/` runs inside GNOME Shell, `app/page/` builds the preferences window, `app/util/` is shared. The two never import each other — the shell and preferences are separate processes.

```sh
./check.sh              # syntax across the tree
node check-symbols.js   # verify every import resolves
```

Releases are cut by CI from a commit whose message starts with `Release: extension;`, using the version in `metadata.json`.

## Contributing

Issues and pull requests welcome. See [Changelog.md](Changelog.md) for recent work and [LICENSE](LICENSE) for terms.

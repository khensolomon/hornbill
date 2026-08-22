# Changelog

Notable changes to the Lesion extension. Version names follow `yy.mm.dd`
(EGO `version-name` allows letters, numbers, spaces, and periods only).

## 26.08.22.70 (version 119) — indicator menu, self-disable switch

### Changed — indicator menu

- Removed the `Lesion <version-name> (<version>)` build stamp. The same
  information is on About, which is one click away in the same menu.
- Reordered to Preferences, Extensions, Disable Extension, About, Close.
  Preferences still hides while preferences are open and Close still appears
  only then, so the menu is Extensions/Disable/About in that state.
- Disable Extension sits between two separators rather than at the end. It is
  the only destructive item, and it now has neighbours on both sides.

Item labels are unchanged; "Disable Extension" keeps its existing wording
rather than being shortened to "Disable".

### Changed — Advanced -> Extensions can now disable Lesion

Lesion's own switch was created with `sensitive: !isSelf`, so it rendered
permanently greyed out. It is now live, guarded by a confirmation that mirrors
the indicator's shell-side dialog: same heading, same explanation, Cancel as
the default response and Disable marked destructive.

The handler needs two pieces of care that are worth recording:

- The `state-set` handler returns `true` for a self-disable, which holds the
  switch's underlying state while the dialog is up. On confirm, the service
  emits `ExtensionStateChanged`, the list refreshes, and the row is rebuilt
  from the real state rather than from anything this handler assumed.
- On cancel the switch has to be put back, but `set_active()` re-emits
  `state-set`. Without a guard that revert reads as the user switching Lesion
  back on and fires `EnableExtension` against an extension that never went
  off. A `reverting` flag suppresses the re-entrant pass.

The remove button stays insensitive for Lesion. Disabling is recoverable from
the same list; uninstalling the extension that owns the running preferences
process is not.

### Removed — Panel -> Appearance -> Panel Position

The Panel Position combo row is gone from General Configuration. The
`panel-position` key itself is untouched and still read by
components/panels.js, still written by the five presets in data/panels.js, and
still reset by Reset Style. Only the direct control is removed, so position is
now set by applying a preset.

### Changed — default settings

| Key | Was | Now |
| --- | --- | --- |
| `popup-shadow-enabled` | `true` | `false` |

All five presets set this key explicitly, so applying any preset still turns
popup shadows on.

## 26.08.21.69 (version 118) — preferences layout, defaults, error visibility

### Changed — default settings

Six schema defaults changed. These affect new installs and any key a user has
never touched; existing dconf values are left alone.

| Key | Was | Now |
| --- | --- | --- |
| `panel-bg-color` | `rgba(0,0,0,1)` | `rgba(0,0,0,0.80)` |
| `clock-format-mode` | `default` | `custom` |
| `clock-custom-format` | `%H:%M  %A %d` | `%H:%M %d.%m.%y` |
| `clock-multiline` | `false` | `true` |
| `geometry-enabled` | `false` | `true` |
| `corners-enabled` | `false` | `true` |

`clock-target` (`right`), `clock-position` (`before`) and `clock-move-enabled`
(`true`) already held the requested values and were not touched.

Note that `geometry-enabled` and `corners-enabled` now default on, so a fresh
install starts with window geometry tracking and rounded corners active rather
than opt-in. Reset Style on Panel -> Appearance calls `settings.reset()`, so it
picks these up with no code change.

### Changed — Panel -> Appearance

- Presets moved from second position to the bottom of the page. Applying a
  preset rewrites every group above it, so it now reads as the action it is
  rather than something encountered before the settings it overwrites.
- New "App Buttons" group, directly below "Panel Buttons", holding the five
  rows that used to be Panel -> Layout -> Global Appearance: icon size, item
  padding, monochrome icons, running opacity, stopped opacity.

  These were deliberately **not** merged into the Panel Buttons group itself.
  That group is bound to `panel-enabled`, which gates components/panels.js
  only. The `apps-*` keys are read by components/apps.js and its buttons keep
  rendering with panel styling switched off, so folding them in would have made
  live settings uneditable. A sibling group gets the same grouping on screen
  without that side effect.
- `_createSpinRow` gained optional `step` and `subtitle` parameters, both
  defaulted so the twenty existing call sites are unaffected. The moved rows
  need step 2 (icon size) and step 5 (opacity), which the old fixed
  `step_increment: 1` could not express.

### Changed — Panel -> Layout

Global Appearance group removed; the page now starts at Running Indicator. No
key was dropped — all five moved to Panel -> Appearance.

### Changed — every blank catch now reports

All 72 `catch {}` / `catch (e) {}` bodies were empty. Each now logs, split two
ways, because `logError()` is not gated on `AppConfig.debug` and `log()` is:

- **`logError` (12 sites)** — paths that run once per enable/disable or once
  per explicit user action: component `onEnable`, wallpaper backup/restore,
  Empty Trash, and the preferences pages. A throw here is a real fault and
  should reach the journal on a stock install.
- **`log` (60 sites)** — per-window, per-actor and per-menu paths, plus the
  teardown loops that call `disconnect()`, `unbind()`, `remove_constraint()`
  and `cancel()` on possibly-disposed objects. These throw as a matter of
  course, so `logError` would have written to every user's journal on every
  panel refresh and every disable. They are visible with `debug: true`.

No guard was removed and no control flow changed; each catch body gained one
statement. Messages name the enclosing method and the guarded call, e.g.
`_detachWindow: disconnect() failed`.

### Removed — unused symbols

- app/page/extensions.js: `TYPE_SYSTEM`, `STATE_DISABLED`, `STATE_ERROR`.
- app/util/gettext.js: `ngettext()`, `pgettext()`. No call site in the tree;
  `gettext()` and `N_()` remain.
- app/components/apps.js: `updateAll`, an arrow function bound to nothing.
- app/page/layout.js: `vals`, a dead array literal inside a callback.
- app/page/appearance.js: the unused `posSignal` handle. The `connect()` call
  it wrapped is unchanged — only the discarded return value is gone.

### Tooling — check-symbols.js gains a shadowed-logger check

Adding the log calls above exposed a gap: `log` and `logError` are also GJS
globals, so a file that calls them without importing from util/logger.js still
runs — it silently binds to the wrong function. The project's `log()` is
debug-gated and the global one is not, so that leaks debug output into every
user's journal. Two files (app/window.js, app/page/geometry.js) hit exactly
this and are now fixed.

The checker reports any file calling `log()` or `logError()` without importing
it. Verified by removing an import and confirming the failure.

## 26.08.20.68 (version 117) — code quality

### Fixed — gschemas.compiled still missing from every package

Version 116 recorded this as fixed. Half of it was: build.py and install.py
both learned gitignore-style `!negation`. The `.extensionignore` line that
uses it was never added, so `*.compiled` in `.gitignore` continued to strip
`schemas/gschemas.compiled` from the zip, and the version 116 package shipped
without it. app/config.js resolves its GSettings schema from exactly that
path, so a clean EGO install would still have failed to open preferences.

`!schemas/gschemas.compiled` is now present, with a comment explaining why
removing it breaks installs. Verified by listing the built archive.

The rest of this release is code quality. No behavioural change intended:
every edit is a provably inert branch, an unreferenced import, or a comment.
Component behaviour is otherwise byte-identical to version 116.

### Removed — inert branches in app/components/geometry.js

The two findings left standing by the version 116 revert are now applied.
`Meta.Window` declares neither method, so both conditions were always false
and neither branch had ever run.

- `_isAlive` and `_identityFor`: dropped `typeof win.is_destroyed === 'function'`.
  `is_destroyed` belongs to `Meta.WindowActor`. In `_identityFor` the check was
  the only statement in its try block, so the whole block went with it;
  `_isAlive` keeps `get_compositor_private() !== null`, which is the real test.
- `_shouldManage`: dropped `typeof win.is_modal === 'function' && win.is_modal()`.

`get_transient_for` and `is_skip_taskbar` are real `Meta.Window` methods and
their guards are untouched, as are the documented version shims in
app/util/compat.js. Nine `typeof` guards are now six.

### Removed — unreferenced imports

Nine bindings with no reference anywhere in the tree. Each was confirmed to
occur exactly once in its file, on its own import line.

- app/components/base.js — `Gio`
- app/page/appearance.js — `N_`
- app/page/extensions.js — `GObject`, `log`
- app/page/stylesheet.js — `log`
- app/page/wallpaper.js — `N_`
- app/panel/indicator.js — `GObject`, `log`
- prefs.js — `logError`

### Changed — app/components/styles.js

- `_applyStyles` used `throw null` to skip the custom-stylesheet section when
  the master switch is off, caught by an outer handler that then had to test
  `if (e)` to tell control flow from a real error. Now a plain
  `if (settings.get_boolean('custom-styles-enabled'))` guard. The outer
  try/catch is gone: `custom-styles` and `custom-styles-enabled` are both
  declared in the schema, so `get_value`/`get_boolean` cannot raise a catchable
  exception. The inner per-URI handler around `load_stylesheet()` is unchanged.
- `_clearMonitors` keeps its guard around `cancel()`, now with a comment saying
  why. It runs from `onDisable()`, where a throw would abort the loop and leak
  every remaining monitor — the failure mode base.js `_cleanup` documents.
  Marked "do not unwrap" so a future sweep leaves it alone.

### Tooling — check-symbols.js

`check.sh` proves each file parses. It cannot see a file that references an
un-imported namespace, or imports a name the target module never exports. Both
fail only at runtime inside GNOME Shell, where the symptom is a silently dead
feature — the `_isEnabled` class of bug.

`check-symbols.js` adds three textual checks: undefined GI namespace, named
import with no matching export, and unused import. It was validated by
injecting one fault of each class and confirming all three were reported.
`check.sh` now runs it, `make check` runs `check.sh`, and `.extensionignore`
excludes both from the package.

## 26.08.18.67 (version 116) — build and packaging fixes

Tooling and packaging only. No behavioural change to any component.

An attempted try/catch reduction across the components was reverted before
release: it broke the Panel, Clock and Geometry features. See "Reverted" below
for what went wrong and why the guards are staying.

### Fixed — packaging (both bugs would have reached users)

- `schemas/gschemas.compiled` was excluded from every package. `.gitignore`
  carries `*.compiled` to keep it out of version control, and build.py reads
  patterns from `.gitignore` and `.extensionignore` alike, so the file was
  dropped from the zip. app/config.js resolves its GSettings schema from
  exactly that path, so an EGO install would have failed to open preferences.
  Both scripts now support gitignore-style `!negation`, and `.extensionignore`
  re-includes the file explicitly.
- `build.py --ego` stripped `links` and `developer-name` from metadata.json,
  and app/page/about.js reads both directly. The submission build would have
  shown "Unknown Developer" and no Documentation group. Both keys are now kept
  in the EGO package; EGO ignores keys it does not recognise.

### Changed — one locale compiler

`po/manage.py` is now both a CLI and an importable module. It exports
`compile_catalogs()`, `update_template()` and `add_language()`, and remains the
only implementation of the translation pipeline.

- build.py and install.py load `po/manage.py` by path (via `importlib`, since
  `po/` is not a package) and call `compile_catalogs()`. Neither script contains
  compile logic; changing how catalogs are built now means changing one file.
- build.py compiles catalogs and GSettings schemas before packaging, so a zip
  can no longer ship a stale `.mo` or a schema that has drifted from
  `schemas/*.gschema.xml`. `--no-compile` opts out. Failures are fatal only
  under `--ego`.
- install.py compiles in both modes. In remote mode this runs on the extracted
  source *before* copying, because `.extensionignore` strips `po/` from the
  installed copy and that is the last moment the sources exist.
- A missing gettext warns and falls back to the committed `.mo` files rather
  than failing: gettext is a developer dependency, not an end-user one.
- `update` now names any file listed in POTFILES.in that does not exist,
  instead of letting xgettext fail part-way through on a stale list.

### Changed — EGO preparation

- metadata.json: removed `"51"` from `shell-version`. GNOME 50 was released on
  18 March 2026 and 51 is unreleased, so EGO's validator would reject it.
  Removed `prefs-page`, which nothing in the source reads.
- .extensionignore: added `check.sh`, which was leaking into the package.
- Removed eleven `// NEW (Safe to remove try/catch)` marker comments from
  extension.js and prefs.js. EGO rejects submissions whose comments read as
  notes to a code generator. Comment lines only; no code was touched.

### Tooling

- Added `check.sh`, which pipes every JS file through
  `node --input-type=module --check`.

  `node --check FILE` treats a bare `.js` as CommonJS and does **not** validate
  ES module syntax. It returns 0 on a function containing `try {` with no
  `catch`. Every release since the syntax gate was introduced has been checked
  with that command, so the gate has been weaker than the Changelog implied.
  The new form immediately caught three real breaks that `node --check` passed.

### Reverted — try/catch reduction across components

A sweep that cut 164 clauses to 64 was reverted in full. All component sources
are byte-identical to version 115. Two failure classes caused it, both worth
recording so the next attempt avoids them:

1. **Removing a guard whose absence changed control flow.** base.js
   `_isEnabled` was dropped as redundant, but panels.js `_queueRefresh` reads
   it: `if (!this._isEnabled) return GLib.SOURCE_REMOVE;`. With the flag gone
   the value was `undefined`, so the debounced refresh returned immediately and
   `_refreshAll()` never ran — the entire Panel feature, silently dead.
2. **Removing duck-type guards on heterogeneous actor trees.** Checks like
   `actor.has_style_class_name && ...` in `_setClockPillNeutralized` and
   `_iterateButtons` are not redundant: the panel tree contains ClutterText and
   other non-St actors that do not declare that method, so the call raises
   TypeError. The same pattern was removed from effects.js
   (`win.get_client_type &&`, `win.get_wm_class?.()`).

The EGO rule that functions which never throw must not be wrapped is sound, but
"never throws" has to be established per call site, not per method name. Where
this codebase wraps a call, a comment usually records the bug that put it there
— base.js `_cleanup` documents a disposed object aborting a cleanup loop, which
is direct evidence that `disconnect()` does throw here. Those notes outrank the
general guideline.

Two findings from the sweep still stand and can be acted on separately:

- `typeof win.is_destroyed === 'function'` in app/components/geometry.js is
  dead code. `is_destroyed` is a method of `Meta.WindowActor`, not
  `Meta.Window` (Meta API 51 reference), so the check is always false and the
  branch never runs. `get_compositor_private() !== null` is already the real
  test. Harmless, but it can go.
- `win.is_modal()` in `_shouldManage` has the same problem: `Meta.Window`
  declares no `is_modal`, so that branch has never fired. Removing it changes
  nothing; keeping the `typeof` guard around it is what makes it inert.

### Known EGO risks, unchanged in this release

- app/page/extensions.js manages other extensions over D-Bus. The review
  guidelines treat extensions that interact with the extension system as
  case-by-case and reject at the reviewer's discretion.
- app/components/apps.js is roughly 75 KB. Very large files can make the EGO
  review page lag while loading diffs; splitting it would help review.
- app/components/apps.js spawns `gnome-control-center` and `gio trash --empty`.
  The guidelines ask that external shell commands be avoided in favour of D-Bus.
- app/util/compat.js imports Clutter and Meta and is shell-process only, but it
  sits in `app/util/` next to modules that both processes share. The guidelines
  ask that process-specific modules be obvious from the directory layout.
- The try/catch count is unchanged at 164. The guideline still applies; it needs
  a per-call-site approach with testing between changes.

## 26.08.15.66 (version 115) — try/catch reduction in entry points

### Changed
- extension.js: removed unnecessary try/catch around signal disconnects,
  window lookups, and the settings write in openPreferences(). Kept isolation
  where it matters: enable() now tracks each component before enabling it (so a
  throw can't orphan an enabled component), and disable() wraps each
  component's disable() so one failure can't stop the others from cleaning up.
- prefs.js: removed unnecessary try/catch around icon-path registration,
  metadata/CSS loading, title/class tagging, and deep-linking setup. The one
  guarded call kept is window.add(Adw.PreferencesPage) so a failure there can
  never replace the real UI with the error page.

## 26.08.15.65 (version 114) — candidate: silence "Extension did not provide any UI"

### Changed (NEEDS VERIFICATION on live GNOME)
- prefs.js: added a single empty Adw.PreferencesPage after set_content(). The
  custom UI is set via window.set_content(splitView), which adds zero
  Adw.PreferencesPages, so GNOME's ExtensionPreferences logs "Extension did
  not provide any UI" on every open (non-fatal — the window still shows).
  Adding one page satisfies that check. Guarded with try/catch so it can never
  block the real UI. Pending confirmation that (a) the JS ERROR stops and
  (b) the split-view prefs still render correctly.

## 26.08.15.64 (version 113) — journal-driven bug fixes

### Fixed
- compat.js: maximize()/unmaximize() were passing MetaMaximizeFlags.BOTH on
  GNOME 49+ where the argument was removed, logging "Too many arguments to
  method Meta.Window.maximize: expected 0, got 1" on every restore-to-maximized.
  The MetaMaximizeFlags enum can persist in the typelib after the argument is
  gone, so the check now gates on the shell major version (>= 49 = flagless),
  keeping the enum-absent case as a secondary signal.
- wallpaper.js: removed two `overflow: hidden;` declarations from the inline
  preset-card CSS. GTK4 has no `overflow` CSS property (it is set via
  Gtk.Widget.set_overflow, already done on the overlay), so these produced
  "Theme parser error: No property named overflow" in the prefs process.

## 26.08.15.63 (version 112) — regression fix + real-bug fixes from journal logs

### Fixed
- REGRESSION (introduced in 26.08.15.62): app/page/geometry.js referenced
  GLib.timeout_add/source_remove after the setTimeout->GLib change but never
  imported GLib, throwing "ReferenceError: GLib is not defined" on every
  geometry-data change while the Geometry page was open. Added the missing
  `import GLib from 'gi://GLib'`.
- Escaped raw ampersands in two preferences titles ('Geometry & Floating',
  'Text & Icon Color') that broke Pango markup parsing in the prefs process
  ("Entity did not end with a semicolon").

### Tooling
- Added an import-verification scan (used in review): every gi:: namespace
  referenced as `Ns.` must be imported. node --check validates syntax only and
  does not catch an undefined global, which is how the GLib regression slipped
  through.

## 26.08.15.62 (version 111) — dead-code removal, impersonal docs, EGO cleanup

### Dead code
- Removed 8 unreachable files (~1,875 lines): app/components/dock.js,
  app/components/mimic.js, app/panel/appbutton.js, and the orphaned
  preferences pages app/page/{dock,appbutton,mimic,setting,demo}.js. None
  were reachable from extension.js, prefs.js, or app.js.
- Dropped the commented-out DockManager/MimicManager/AppButton imports and
  list entries from app/components/index.js.

### EGO review compliance
- Removed an ungated printerr in panels.js that fired on every panel button
  press (violated the no-excessive-logging rule).
- Replaced setTimeout in the Geometry preferences page with a tracked
  GLib.timeout_add that is removed on page destroy (remove-main-loop-sources).
- extension.js now tracks the per-window preferences-adoption timers and
  removes any pending ones in disable().
- Removed scaffolding/narration comments left in window.js
  ("[Rest of your existing createUI code...]", "Keep existing", etc.) that
  read as generated boilerplate.

### Unnecessary try/catch (batch 1 — provably cannot throw)
- app.js: removed the try/catch around loading the extension's own
  metadata.json; existence is already checked with file_test and a malformed
  own-metadata should fail loudly in the dev launcher, not be swallowed.
- Removed three `typeof x === 'function'` guards on methods that always exist:
  indicator.js closePreferences (own class method; dead else-branch removed),
  wallpaper.js row.set_sensitive and panels.js btn.menu.connect (both kept
  their real null checks; only the redundant typeof was dropped).

### Documentation style
- Rewrote comments to impersonal voice: removed all first- and second-person
  pronouns (we/our/us, you/your) across the live source.
- Reconciled the supported-version note in util/compat.js (46-49 -> 46-51) to
  match metadata.json.


## 26.08.15.61 (version 110) — metadata cleanup, README, dead CSS removed

### metadata.json
- Removed the MyOrdbok link from the About page's links list — unrelated to
  this extension.
- Fixed the readme link to point at README.md (the actual filename) instead
  of the old Readme.md casing.

### README.md
- Added a short README: what the extension does, supported GNOME versions,
  install steps, and where to file issues.

### style/
- Removed dynamic-corners.css and panel-clock.css. Neither was referenced
  anywhere in the codebase or the build/packaging script — leftover
  experiments from before the proper geometry engine and the Appearance
  page's preset system existed.

## 26.08.15.60 (version 109) — panel buttons close the overview before acting

### Apps stayed launched behind an open Activities overview / search
- Clicking a panel app button while the Activities overview, its search, or
  the app grid was open still launched the app (or activated/minimized its
  window), but the overview stayed on screen covering it — looking
  unresponsive or as if the click had failed.
- _activate(), the single entry point every panel button's click passes
  through (favorites, running apps, Trash, and other panel buttons), now
  closes the overview first via Main.overview.hide() when it is visible,
  before running the button's own click behaviour.
- The Applications and Overview buttons are exempted (btn._managesOverview),
  since those buttons ARE the overview's own toggle and already handle
  showing/hiding it themselves; forcing a hide first would fight that.

## 26.08.15.59 (version 108) — replaced bundled icons with built-ins

### icon/
- Removed lesion-clear-symbolic.svg, lesion-erase-symbolic.svg,
  lesion-link-symbolic.svg, and lesion-reset-symbolic.svg. Each had a
  suitable built-in Adwaita equivalent, so bundling and shipping them was
  unnecessary:
  - Clear Saved Geometry (geometry.js) -> edit-clear-all-symbolic
  - Reset Style (appearance.js) -> edit-clear-symbolic
  - Reset All Settings (dashboard.js) -> view-refresh-symbolic
  - Documentation link rows (about.js) -> insert-link-symbolic
- hornbill.svg and hornbill-symbolic.svg (the extension's own icon) are
  unaffected and remain bundled, since no built-in theme provides those.

## 26.08.15.58 (version 107) — Extensions page: Lesion listed, link buttons, focus highlight

### Advanced -> Extensions
- Lesion is listed here again like any other extension (its own
  remove/toggle stay disabled, since removing or disabling the
  extension you are currently configuring from inside itself is not a
  safe action).
- The settings-gear button ("Open preference") is replaced with a link
  button that opens the extension's homepage URL, taken from its own
  metadata.json via the shell's ListExtensions. OpenExtensionPrefs
  proved unreliable across shell versions and needs a parent-window
  handle a prefs process cannot supply; a homepage link always works
  and needs nothing from the target extension.

## 26.08.14.57 (version 106) — down to 52, consolidated

Versions 52 through 106 were built and shipped individually during one
long debugging arc but were not each recorded here as separate entries.
This single block covers the whole arc, grouped by what was actually
fixed rather than by build number, since many builds in the middle were
diagnostic-only or superseded by the next attempt.

### Panel app buttons: the GNOME 50 click investigation (v52-v86)
On a fresh Ubuntu 26.04 / GNOME 50.1 install, panel app buttons stopped
responding to clicks entirely (window corners and shadows also briefly
regressed). This took a long forensic chain to resolve:
- **Shader/effects broke first**: `Shell.SnippetHook` moved to
  `Cogl.SnippetHook` in GNOME 47; on 50 the old enum was undefined, so
  window corner/shadow effects silently failed to attach. Fixed by
  importing Cogl directly.
- **Buttons had collapsed to zero size** (confirmed via live actor
  inspection: `w=0 h=0`, later `h=0` alone): `min-width: 0px` plus an
  inner box that requested no intrinsic size let the button's computed
  size resolve to nothing under GNOME 50's stricter layout. Fixed with a
  real minimum size and an inner box set to fill its parent.
- **The root cause of "clicks do nothing"**: `PanelMenu.Button` attaches a
  `Clutter_ClickGesture` that claims the pointer sequence and runs ahead
  of all of the actor's own event handling -- before any connected signal
  handler and before any overridden vfunc. No amount of rewriting the
  click handler could work while that gesture was attached. The fix,
  proven by directly inspecting the actor's attached actions, is
  `clear_actions()` right after construction, followed by the extension's
  own click handling.
- The reliable, final click implementation wraps the button's content in
  an `St.Button` and listens to its `clicked` signal -- the same pattern
  GNOME Shell's own `AppDisplay.AppIcon` uses -- rather than
  hand-assembling press/release pairing from raw button events, which
  proved fragile across shell versions.
- App launch now uses `app.activate_full(-1, timestamp)` so the shell's
  startup notification tracks the launch and clears the busy cursor when
  the window maps, instead of spinning until timeout.

### Preferences UI: reorganisation and an Extensions manager (v46, v87-v104)
- Preferences navigation reorganised into object-based groups: Dashboard
  (ungrouped) / Desktop / Panel / Window / Advanced / About. Several page
  files renamed to match (`style.js` to `appearance.js`, `apps.js` to
  `layout.js`, `css.js` to `stylesheet.js`).
- New page: **Advanced -> Extensions**, a management UI for all installed
  GNOME Shell extensions (user and system), built on the
  `org.gnome.Shell.Extensions` D-Bus service -- the same one the official
  Extensions app uses. Supports enable/disable (live), remove (user
  extensions only -- system extensions are root-owned), and opens each
  extension's homepage URL (read from its own metadata) rather than trying
  to launch its preferences, since `OpenExtensionPrefs` needs a
  parent-window handle a prefs process cannot reliably supply and proved
  unreliable across shell versions.
- The page's D-Bus calls were made fully asynchronous after an early
  version, which used `call_sync` on the UI thread, froze the whole
  preferences window ("Extensions is not responding").
- The page subscribes to the service's `ExtensionStateChanged` signal so
  external changes (CLI, the official app) are reflected live.
- Fixed a crash on every preferences open: `AdwNavigationView` threw
  "Duplicate page tag" when a page (e.g. About) could be pushed onto the
  navigation stack while already present, which aborted UI construction
  and left GNOME reporting "Extension did not provide any UI". Navigation
  now checks for an existing page before pushing, and the preferences
  window is given placeholder content immediately so a later failure can
  no longer produce an empty/error window.
- Fixed an invalid GTK CSS rule (`height` is not a GTK CSS property; the
  intended rule used `min-height`) that had been logging a theme-parser
  error on every preferences load.

### Indicator menu
- Removed the "Options" submenu: both of its entries were guarded on
  extension methods that were never implemented, so it always rendered
  empty.
- Added "Extensions", opening the Advanced -> Extensions page via the
  existing deep-link mechanism.
- The build-version stamp moved from the top of the menu to a dimmed,
  non-interactive line at the bottom.
- "Disable Extension" now asks for confirmation (Cancel default, Disable
  styled as destructive) via the shell's `ModalDialog`, since this code
  runs inside gnome-shell rather than the preferences process.
- The indicator's own click handling hit the same `Clutter_ClickGesture`
  issue as the app buttons and was fixed the same way.

### Preferences window: raising it from behind another window
Bringing an already-open preferences window to the front (from the
indicator's left-click or its "Preferences" menu item) required its own
investigation, separate from the click issue above:
- Matching the window by title or by scanning `list_all_windows()` on
  demand proved unreliable: Adw retitles the window to whatever page is
  visible ("About", "Panel", ...) rather than the extension's name, and a
  scan run at the wrong moment could see nothing, or only a stale
  "Extension Error" dialog left over from an earlier failed launch.
- The reliable fix holds a live reference instead of searching for one:
  the extension connects to `display::window-created` and adopts the
  first new window whose `wm_class` / `gtk-application-id` is
  `org.gnome.Shell.Extensions` (re-checked briefly after creation, since
  `wm_class` is often not set at the moment the window first appears),
  and drops the reference when the window is unmanaged.
- Raising that window unminimizes it, moves it to the active workspace,
  and calls `Main.activateWindow()` -- `activate()` alone does not lift a
  window from behind another on Wayland.
- The indicator now highlights (an `active` style state) while the
  preferences window is open, using the same tracked reference -- a cheap
  boolean check, not a poll of the window list.

## 26.08.07.2 (version 51)

### Panel Layout
- Fixed doubled section toggle title: the per-section switch prepended
  "Show" onto the group title, rendering "Show Show Applications". The
  toggle now reads "Show in Panel" for every section.
- The Show Applications icon-name field now offers a dropdown of common
  symbolic icon names (GtkEntryCompletion) while still accepting any typed
  value — a suggestion, not a constraint.

### Preferences navigation
- Window -> Effects no longer shares Panel -> Appearance's icon; it uses
  focus-windows-symbolic (window-themed, present in the Adwaita set),
  updated in both the sidebar and the Dashboard quick-access row.

## 26.08.07.1 (version 50)

### Versioning correction
- version-name now reflects the actual build date. Earlier builds carried
  a stale `26.07.22` date forward across several releases instead of
  advancing `yy.mm.dd` per build; today's build is correctly `26.08.07.1`.
  The `.N` suffix is the same-day build counter and resets to 1 each day.

## 26.07.22.4 (version 49)

### Stylesheet page
- Custom Styles now appears above Bundled Styles.
- Bundled Styles carries a description stating it is demo material, and
  each bundled style has a "View CSS" button opening a read-only,
  copyable viewer — a cheat sheet for writing custom styles.
- Custom Styles gained a master enable/disable switch (all custom styles
  at once) via a new 'custom-styles-enabled' key, shown as a header
  control alongside a compact Add button once the list has content; the
  empty state keeps the single large "Add Style File…" button.
- Fixed the non-working "Open File": it used Gtk.UriLauncher with a null
  parent, which did nothing. It now uses Gtk.FileLauncher with the window
  as parent.
- The Remove button no longer paints a full-height red background inside
  the row (dropped destructive-action for a flat trash icon); both row
  buttons are vertically centered.

### Stylesheet hot reload
- Applied stylesheets (bundled and custom) are watched on disk; edits
  reapply automatically (debounced), so writing CSS is save-and-see.

### License
- Relicensed to MIT (permissive, GPL-compatible, accepted by
  extensions.gnome.org). LICENSE replaced; the GPL-specific numeric
  license_type key removed from metadata.

## 26.07.22.3 (version 48)

### Publication readiness (extensions.gnome.org)
- debug is now false in metadata: builds were shipping with debug logging
  enabled, writing per-move geometry logs into every user's journal.
- LICENSE added (GPL-2.0-or-later), matching the metadata license link.
- Experimental pages not wired into the registry (demo, dock, mimic,
  appbutton, setting) are excluded from the EGO submission package.
- Audit results, unchanged because already compliant: prefs side imports
  no shell-only libraries; every component's disable() removes actors,
  effects, timers, and signals (with pending saves flushed); no
  session-modes declared; subprocess use is limited to user-triggered
  actions (opening GNOME Settings, emptying trash); --ego build mode
  whitelists standard metadata keys and the About page tolerates the
  stripped ones.

## 26.07.22.2 (version 47)

### Window geometry: paste-conflict dialogs no longer moved
- Nautilus's replace/skip confirmation dialogs (folder conflict, then
  file conflict) were flown to the app's saved window position. Dialog
  markers — window type, transient parent, modality — are often set
  AFTER window-created, so the dialogs passed the one-time filter in
  _beginRestore while still looking like normal windows, and the actual
  moves happened later where nothing re-checked.
- The dialog check now runs at the FINAL gate before any move (the
  deferred apply and every verify pass): a window that has revealed
  itself as a dialog by then is untracked and left exactly where the
  shell placed it. is_modal() added to the filter, since modality often
  lands before the transient parent is wired up.

## 26.07.22 (version 46)

### Preferences navigation reorganized
- The sidebar is now grouped by the object being configured rather than by
  abstract categories: Dashboard (ungrouped) / Desktop (Wallpaper) / Panel
  (Appearance, Layout, Clock) / Window (Effects, Geometry) / Advanced
  (Stylesheet) / About (ungrouped, trailing). Dashboard and About bookend
  the object pages.
- Page renames for clarity, with files and exports renamed to match:
  - Panel "Style" -> "Appearance" (page/style.js -> appearance.js,
    StylePage -> AppearancePage, createStyleUI -> createAppearanceUI, id
    panel-style -> panel-appearance).
  - Panel "Apps" -> "Layout" (page/apps.js -> layout.js, createAppsUI ->
    createLayoutUI, id apps -> panel-layout). The panel component
    (components/apps.js, AppsManager) is unchanged.
  - "CSS" -> "Stylesheet" (page/css.js -> stylesheet.js, createCssUI ->
    createStylesheetUI, id css -> stylesheet), moved under Advanced.
  - Window pages shown as "Effects" and "Geometry" under the Window group.
- Dashboard quick-access rows updated to the new page ids and titles, with
  a Panel Appearance row added.
- No settings-schema changes: every key (panel-*, corners-*,
  transparency-*, geometry-*, apps-*) is unchanged, so no dconf migration.

## 26.07.21.8 (version 45)

### Panel: presets no longer break the panel
- Applying any blur-enabled preset (all except Default) made every panel
  button unclickable. Cause: Shell.BlurEffect was added directly to
  Main.panel in ACTOR mode. That blurs the panel's OWN contents rather
  than what is behind it, and an offscreen effect on the panel breaks
  input picking for its children. The effect now lives on a dedicated
  background actor — reactive: false, inserted below the panel contents,
  size-bound to the panel — using BACKGROUND mode. Effects left on
  Main.panel by earlier builds are removed on load.
- Applying a preset now refreshes the page. Controls read their values at
  construction, so the page kept displaying the previous state (most
  visibly the panel background colour and gradient controls) even though
  the settings had been written.
- "Dev: Export Config" is no longer shown in normal builds: its
  visibility check was `AppConfig.debug || true`.

## 26.07.21.7 (version 44)

### Window geometry: never move windows from inside signal emission
- Journal evidence (Jul 21, Firefox): the session ended immediately after
  "Restoring firefox_firefox" -> ">> move_resize_frame", with NO
  authoritative-apply line preceding it — identifying the EARLY apply,
  which ran synchronously inside the 'window-created' handler. Moving a
  window Mutter is still constructing, from within its own signal
  emission, is re-entrancy into window management at the most fragile
  point in a window's life. This is the same path Chrome took.
- The early apply is removed entirely. It has been redundant since the
  authoritative post-first-frame apply landed, and the cloak covers the
  wait. Identity resolution still happens early — it performs no window
  operations.
- All applies (authoritative and already-mapped) now run from a fresh
  main-loop iteration via a shared deferred-apply helper, so no window
  operation is ever issued from inside 'window-created', 'first-frame' or
  'shown'. X11 clients keep their additional 250ms clearance.

## 26.07.21.6 (version 43)

### Window geometry: recycled identity ids (root cause of the crashes)
- Shell.WindowTracker invents a fallback id of the form 'window:N' for
  windows it cannot match to a .desktop file. Those ids come from an
  internal counter and are RECYCLED across unrelated windows. Version 38
  fed them into the store and the alias learner, producing entries such
  as "window:3 -> google-chrome". When Chrome's Task Manager opened as an
  unmatched window and drew a recycled id, its geometry was resolved to
  Chrome's main window and the small utility window was resized to
  1875x1408 — the final traced operation before each session loss, and
  the reason reopening the Task Manager reproduced it.
- Synthetic ids are now rejected everywhere: identity resolution falls
  back to wm_class, aliases are never learned from them, and neither
  restores nor saves accept them.
- Existing stores self-heal: recycled ids and any aliases referencing
  them are purged on load, with a journal line reporting the count.

## 26.07.21.5 (version 42)

### Window geometry: keep X11 work out of the map sequence
- Correction to the previous entry: the session terminations occur only
  with geometry saving ON. The timing also fits version 38, which gave
  Chrome a resolvable identity for the first time ("No saved entry for
  'Google-chrome'" until then) — so geometry began operating on
  Xwayland-backed windows exactly when the crashes started.
- X11 clients no longer receive any geometry operation during their map
  sequence: the early apply is skipped entirely and the authoritative
  apply is deferred 250ms past first-frame.
- Workspace restore is skipped for X11 clients:
  change_workspace_by_index with append=true mutates the workspace set
  and propagates X11 property updates to Xwayland.
- Every risky window operation (move_resize_frame, maximize,
  change_workspace_by_index) is now traced immediately BEFORE it runs,
  with the client type. Since an Xwayland exit produces no [Lesion]
  error, the final trace line in the journal identifies the exact call
  that preceded a crash.

## 26.07.21.4 (version 41)

### Window Effects: Xwayland safety
- With geometry saving switched OFF the session still terminated, which
  clears geometry of responsibility and leaves effects as the component
  that touches X11 windows: the corner shader is applied to the surface
  child actor of Xwayland-backed windows, and Xwayland is itself a
  Wayland client of the compositor, so operations on its surfaces can
  drop that connection — which ends the session.
- New "Manage X11 Windows" toggle (effects-manage-x11, default on)
  excludes Xwayland windows from effects entirely. Like its geometry
  counterpart it can be flipped from a TTY without loading preferences.

### Geometry page
- Reserved internal keys are no longer rendered as applications: the
  learned identity table ('__aliases__') appeared as a row with undefined
  size and position.

## 26.07.21.3 (version 40)

### Window geometry: X11 client safety (Xwayland termination)
- The journal from the failed session showed the shell did NOT crash:
  Xwayland exited unexpectedly ("Connection to xwayland lost"), and the
  shell then quit because Xwayland is mandatory — that is the forced
  logout. No [Lesion] error appeared in the log at all. Chrome and its
  Task Manager are X11 clients, so the exposure is what the extension
  does to Xwayland-backed windows.
- X11 clients are no longer cloaked: X11 geometry fields are 16-bit
  signed, and the cloak translated actors by -100000px.
- All applied geometry is clamped to a 16-bit-safe range as a hard rail.
- X11 clients receive a single corrective pass instead of up to four:
  rapid repeated configure requests are the other half of the exposure.
- New "Manage X11 Windows" toggle (geometry-manage-x11, default on) to
  exclude Xwayland windows from geometry entirely. It can be flipped from
  a TTY without loading the preferences UI.

## 26.07.21.2 (version 39)

### Window geometry: crash hardening (shell segfault / forced logout)
- Reported: opening Chrome's Task Manager, and subsequently launching
  Chrome at all, terminated the GNOME Shell session; GNOME then disabled
  all extensions. Root hazard identified: deferred work could run against
  an already-unmanaged window. Calling into a destroyed MetaWindow is a
  use-after-free at the C level, which takes down the shell (and on
  Wayland the session). Chrome creates and destroys short-lived windows
  aggressively, making it the likeliest trigger.
- All four deferred timers (identity poll, verify, settle, cloak
  deadline) shared a single id slot, so one could overwrite another and
  become uncancellable — a stale timer could then fire after the window
  was gone. Each now has its own slot, and untracking cancels all of them.
- Every deferred entry point (timers, first-frame, shown, grab-op-end,
  authoritative apply, identity resolution, save path) now verifies the
  window is still alive before touching it.
- The window-created handler no longer lets exceptions escape into shell
  signal emission.
- Workspace restore clamps the target index to the existing workspace set
  (+1 at most); a large stored index with append=true could previously
  spawn many workspaces.

## 26.07.21 (version 38)

### Window geometry: canonical, session-independent identity
- Entries are now keyed by the .desktop app id resolved through
  Shell.WindowTracker, which is identical under Wayland and Xorg, instead
  of wm_class, which is not ('TextEditor' vs 'gnome-text-editor',
  'gnome-terminal-server' vs 'gnome-terminal'). Each session therefore
  stopped building a store the other could not read. wm_class remains the
  fallback for windows the tracker cannot match (many terminals, some
  Electron and Wine apps), and entries saved under old wm_class keys stay
  reachable through a legacy-key lookup, so no saved geometry is lost.
- Fixed the two-stage flight on Xorg: wm_class changes mid-launch there,
  so the early restore and the authoritative apply resolved two different
  entries and applied two positions in sequence. The identity used for a
  window is now locked once its restore resolves; only the per-title slot
  is refreshed afterwards.
- The session type is logged at enable, so a journal capture identifies
  which session produced it.

## 26.07.20.3 (version 37)

### Window geometry: session identity bridge
- Journal analysis (Jul 20 evening) showed a fully healthy pipeline with
  the "flying" occurring on the Xorg session, where every app announces a
  different WM_CLASS than on Wayland ('Google-chrome' vs 'google-chrome',
  'Gnome-terminal' vs 'gnome-terminal-server'): entries saved under
  Wayland names were unreachable, so no restore ran and X11 apps'
  own startup self-placement showed raw. Pure casing variants are now
  bridged with a case-insensitive lookup fallback (logged as
  "Case-variant hit"). Structurally different names cannot be bridged
  automatically and keep per-session entries.

## 26.07.20.2 (version 36)

### Window geometry: teleport-pop on reveal fixed
- The Jul 20 journal confirmed the first structurally healthy pipeline
  (authoritative first-frame apply on every launch, zero verify fights).
  The remaining artifact was the reveal itself: the map animation plays
  while the window is cloaked off-screen, and apps needing ~300ms to
  paint their first frame finished it before the reveal — snapping
  translation on a fully opaque actor read as a teleport-pop, and the
  old elapsed>300ms fade threshold sat exactly on that boundary. The
  reveal now always fades in (120ms) unless a live map animation is
  still running to provide the fade itself.

## 26.07.20 (version 35)

### Window geometry: authoritative apply re-anchored to 'first-frame'
- Journal evidence (three launches, Jul 20) proved the 'shown'-based
  post-placement apply NEVER executed on this Mutter build — the signal
  did not fire, its try/catch hid the failure, and every restore fell
  back to the visible verify correction (the returned flying). The
  authoritative apply is now anchored to the window actor's 'first-frame'
  signal — one the shell itself relies on, guaranteed to fire after
  placement — with 'shown' kept as a secondary trigger. Both routes share
  one idempotent apply and log their reason, so a journal capture shows
  exactly which path ran. Late identity resolution reveals immediately
  when the window is already mapped via either signal.

## 26.07.18.4 (version 34)

### Window geometry: flying-regression hardening
- Clear All no longer wipes the learned identity aliases ('__aliases__'):
  they are infrastructure (what makes late-identity apps restore before
  first paint), not user geometry. Clearing them re-introduced visible
  late restores until every alias was re-learned — the most likely cause
  of the reported flying regression after test-cycle clears.
- Cloak deadline raised 350ms -> 550ms: Chrome-class identities often land
  around 400-600ms, so windows were revealed at spawn moments before
  their restore resolved.
- The authoritative 'shown' apply now logs (including cloak state), making
  a single journal capture decisive about which path a flying launch took.

## 26.07.18.3 (version 33)

### Window Effects: shadow actors no longer swallow clicks
- Fixed intermittent mouse clicks requiring 2-3 attempts: the replacement
  shadow actors are St.Bins extending SHADOW_PADDING (80px) beyond every
  window, and St widgets are input-reactive by default — an invisible
  80px click trap around each rounded window, swallowing clicks aimed at
  windows behind it (worst exactly where background windows are clicked:
  near their edges). Symptoms matched: fine on a fresh session with few
  windows, degrading as windows and their shadow rings accumulate, gone
  with the extension disabled, independent of Wayland/Xorg. Shadow bins
  and their children are now reactive: false / can_focus: false /
  track_hover: false — shadows never participate in input.

## 26.07.18.2 (version 32)

### Window geometry: smart data recycling
- Entries now track a usage count, incremented on RESTORE (the event that
  proves an entry's value; saves fire constantly and measure nothing).
  No settings-schema change: the data lives inside the geometry-data JSON
  and entries self-upgrade.
- Pruning is now frequency-aware with a recency floor: entries used within
  the last 14 days are never evicted (a brand-new app must not lose to an
  old high-count one); beyond the floor, cap eviction removes the
  least-used first with recency as tiebreak. Entries unseen for 180 days
  drop regardless of count, and title sub-slots keep their LRU eviction.
- Pruning also runs opportunistically whenever the store meaningfully
  exceeds the cap between shell restarts, not only at enable.

## 26.07.18 (version 31)

### Window Effects (renamed from Corners)
- The page and component now match their scope: rounding, shadows, smart
  edges, and transparency. Renamed `app/components/corners.js` ->
  `effects.js` (CornersManager -> EffectsManager), `app/page/corners.js`
  -> `effects.js`, page id `window-corners` -> `window-effects`, menu
  title "Corners" -> "Window Effects", and the Dashboard nav row.
  Settings keys are unchanged (corners-*, transparency-*), so no dconf
  migration is needed.

### Geometry page
- "Reset Storage" retitled "Clear Saved Geometry" with an honest subtitle
  (entries rebuild through normal use), and the clear button dropped its
  destructive red styling — the wording and alarm level now match what
  the action actually does.
- Restore logging now records the frame-buffer delta, to diagnose the
  reported shadow strip on edge-snapped Firefox/Chrome restores (a
  nonzero delta at restore time would confirm the app's CSD shadow
  extents were still in floating mode when measured).

## 26.07.16.4 (version 30)

### Bundled icons (end of the icon-theme roulette)
- The extension now ships its own symbolic icons (icon/lesion-*.svg) and
  registers the directory as a GTK icon search path in preferences.
  Recent adwaita-icon-theme trims kept removing symbolics the UI relied
  on (edit-undo, view-refresh, link showed as the generic fallback).
  Distinct visuals per action: Reset All Settings = circular reset arrow
  (destructive red), Geometry Clear All = trash, Reset Style = eraser,
  About documentation links = external-link arrow.

### Window geometry
- Fixed windows flashing 2-4 times in place at launch (most visible with
  Chrome, also when opening links from About): each verify retry against
  an app re-asserting its own size ran the fade animation — fade-out/in
  at the same position is a flash. Verify corrections and the
  position-only fallback are now instant; the fade remains only for a
  first-time late restore.

## 26.07.16.3 (version 29)

### Window geometry: workspace memory and monitor identity
- Windows now reopen on the workspace they were closed on
  (`geometry-restore-workspace`, default on, toggleable on the Geometry
  page). With dynamic workspaces, a trimmed workspace is recreated. A
  wrong workspace counts as a verify mismatch, so it self-corrects.
- Coordinates are now stored monitor-relative alongside the monitor's
  index and geometry fingerprint. On restore, the fingerprint is matched
  first (survives index shuffles after docking/undocking), then the
  index; a missing monitor falls back to absolute coordinates clamped to
  the current work area. Existing entries without monitor data keep
  working via the fallback and upgrade themselves on the next save.

### Dashboard
- Reset All Settings is now a labeled destructive "Reset..." button per
  the HIG — and immune to the icon-theme availability issues that ate two
  icon attempts.

## 26.07.16.2 (version 28)

### Dashboard
- Reset All Settings icon fixed (edit-undo-symbolic did not render on the
  system theme; replaced with view-refresh-symbolic, verified in use
  elsewhere in the UI).
- Window Geometry added to the Features quick-access list, using the same
  icon and target as its menu registration.

## 26.07.16 (version 27)

### Window geometry: restore AFTER Mutter placement (journal-diagnosed)
- Journal analysis showed every restore followed by "moved itself after
  restore; reapplying" — a 100% rate, meaning systematic: Mutter runs its
  own placement when a window is first SHOWN, discarding geometry applied
  earlier. Being early was why restores lost. The authoritative apply now
  happens in a one-shot 'shown' handler (post-placement), re-looking up the
  per-title slot (titles often arrive by then), while the cloak keeps the
  entire sequence off-view; the early apply remains as a hint only.
  Windows are now cloaked whenever a restore resolved pre-shown OR the
  identity is still pending; known apps with nothing saved map naturally.
- User interaction is authoritative: 'grab-op-end' immediately settles a
  window and saves its rect. Previously a new window stayed unsettled for
  up to ~3 seconds (identity polling + grace), silently discarding the
  user's first drags — and a fast drag could be lost to the save debounce.

## 26.07.15.2 (version 26)

### Window geometry: cloak-until-placed (the fly is dead)
- Root cause finally identified: GNOME's map animation shows a window from
  its very first frame, while app identities resolve 50-250ms later — so
  every restore in that gap relocated a window that was already visible
  and mid-zoom. The 250ms "too early to animate" threshold was built on a
  false assumption; nothing after the first frame is invisible.
- Windows whose identity is unknown at creation are now CLOAKED: the actor
  is slid off-screen via translation (a property the map animation never
  contests, unlike opacity/scale), placed while off-view, and revealed at
  the restored geometry — the window's first visible moment IS its saved
  position and size, exactly like the built-in behavior on other systems.
  The corners shadow is translation-bound and cloaks in sync automatically.
- Reveal triggers: restore applied; identity resolved with nothing saved
  (no restore coming); 350ms deadline (identity never resolved — show at
  spawn, any later restore uses the fade); and untrack/disable, which also
  resets translation so no window can be left off-screen.
- Reveals landing after the map animation has ended get a 120ms fade so
  the appearance is soft rather than a pop.

## 26.07.15 (version 25)

### Window geometry: store desync fixed (the root of "still flying")
- The shell-side manager read `geometry-data` once at enable and never
  again, while the preferences window edits it directly. Consequences:
  "Forget This Window" / "Clear All" only appeared to work (the stale
  in-memory cache kept restoring forgotten entries), and any window move
  wrote the whole stale cache back to disk, resurrecting the cleared list.
  The manager now reloads whenever the store changes externally,
  recognizing its own writes to avoid loops. This desync also poisoned the
  identity-alias learning that makes restores instant, which is why
  launches kept animating.
- The first restore attempt now runs synchronously inside window-created
  (instead of one main-loop iteration later), placing known apps before
  the compositor paints their first frame.

## 26.07.14.9 (version 24)

### Window geometry: instant restores via identity aliases
- The appear-then-move launch experience is eliminated for late-identity
  apps from their second launch onward. Observed identity changes (e.g.
  'firefox' -> 'firefox_firefox') are persisted as aliases in the geometry
  store ('__aliases__'), so the early identity resolves the saved entry
  IMMEDIATELY at window creation — the window is sized and positioned
  before its first frame paints, with no animation at all. A one-shot
  first-frame trigger catches identities landing between creation and
  first paint. Pruning preserves the alias table; the save path refuses
  reserved keys.

### Preferences UI
- About shows `version-name` (with the integer release in parentheses)
  instead of the bare integer.
- `page/panels.js` renamed to `page/style.js`; its reset is retitled
  "Reset Style" with scope-clarifying wording (it only ever covered
  styling keys). A confirmed "Reset All Settings" — every schema key —
  now lives in Dashboard -> Data Management.
- Icon audit against the current Adwaita symbolic set: replaced four icons
  absent from GNOME 48+ themes (external-link -> link, desktop-theme ->
  desktop-appearance, applications-development -> view-grid,
  text-x-script -> text-x-generic).

## 26.07.14.8 (version 23)

### Preferences UI
- `page/home.js` renamed to `page/dashboard.js` (page id `home` ->
  `dashboard`); the Dashboard is now a pure action hub: indicator settings,
  quick navigation, and data management.
- The hero row (name, version, session, UUID copy) moved off the Dashboard:
  identity content already lived on the About page, and the two useful
  diagnostics — session type and the UUID copy button — now join it there
  in a new System group.
- Window Corners added to the Dashboard's quick-access module list.

### Metadata
- Rewrote the metadata.json description from the placeholder ("Demo
  extension with personalized settings") to an informative summary of the
  panel styling and presets, clock, app buttons, window geometry, rounded
  corners, transparency, custom CSS, and wallpaper features.

## 26.07.14.7 (version 22)

### Window Corners / Transparency
- Fixed the "focused window looks transparent" bug: it was not opacity at
  all. Mutter restacks window actors on focus/raise, but the replacement
  shadow actors kept their old depth, so a stale shadow could sit ABOVE a
  newly raised window and paint a dark rim over its edges — reading as
  translucency. Shadows now re-sort directly below their windows on every
  `restacked` signal (same approach as Rounded Window Corners Reborn).
- New Focused Opacity setting (`transparency-focused-opacity`, default
  100): the focused window can now optionally be made translucent too,
  with its own percentage, while the default keeps it fully opaque.

## 26.07.14.6 (version 21)

### Window Corners: smart screen edges
- Corners flush against a screen (work area) edge now stay square while
  interior-facing corners remain rounded (`corners-smart-edges`, default
  on). Side-by-side windows at the screen edges read as tiles: square
  outer corners, rounded inner ones. Implemented as a per-corner mask
  uniform in the shader (TL/TR/BL/BR), an edge-flush test against the
  window's work area (within 2px, where GNOME snap places windows), and
  matching per-corner radii on the replacement shadow body so a squared
  window corner never sits on a rounded shadow.
- Windows now also refresh on position changes, since moving a window
  onto or off a screen edge changes its corner mask without any resize.

## 26.07.14.5 (version 20)

### Window Transparency
- Hardened the focused-window guarantee: if focus changed while a geometry
  fade animation was in flight on a window, the fade could restore a stale
  opacity and the correction was skipped. Transparency updates now retry
  once after an in-flight fade completes, and pending retries are cleaned
  up on detach.

## 26.07.14.4 (version 19)

### Build tooling
- `build.py --ego` builds an extensions.gnome.org submission package:
  excludes all development tooling (build/install/dev scripts, ui mockups,
  notes, the standalone app.js runner), strips nonstandard keys from
  metadata.json inside the zip (debug, links, license_type, prefs-page,
  developer-name \u2014 the runtime falls back safely, so debug is
  automatically off in EGO builds), and names the file
  `<uuid>.shell-extension.zip` per the `gnome-extensions pack` convention.

### Window Transparency (new, on the Corners page)
- Opt-in unfocused-window transparency (`transparency-enabled`, default
  off; `transparency-opacity`, default 92%). The focused window always
  stays fully opaque, so the window being actively worked in \u2014 a
  graphics editor during visual inspection \u2014 is never dimmed; only
  background windows are. Works independently of Uniform Rounded Corners
  (transparency alone attaches no GPU effect or shadow machinery), defers
  to in-flight geometry fade animations, and restores full opacity on
  detach/disable.

## 26.07.14.3 (version 18)

### Schema migration (BREAKING for existing settings)
- GSettings schema id renamed from `dev.lethil.lesion` to
  `org.gnome.shell.extensions.lethil` (EGO publication requirement; also
  the ecosystem convention). Updated everywhere: the schema XML filename,
  schema id, all enum ids, the dconf path (now
  `/org/gnome/shell/extensions/lethil/`), gettext-domain, metadata.json
  `settings-schema`, and the AppConfig fallbacks.
- Existing settings live under the old dconf path and are NOT migrated
  automatically. To carry them over once:
  `dconf dump /dev/lethil/lesion/ | dconf load /org/gnome/shell/extensions/lethil/`
  Afterwards the old tree can be removed with
  `dconf reset -f /dev/lethil/lesion/`, and any globally installed old
  schema in `~/.local/share/glib-2.0/schemas/` can be deleted and
  recompiled.

## 26.07.14.2 (version 17)

### Compatibility
- Added GNOME Shell 50 to supported versions. The GNOME 50 porting guide
  lists no relevant changes to metadata, extension.js, or prefs.js, and no
  changes to the APIs Lesion uses; all breaking changes from 46-49
  (get_maximized, MaximizeFlags, St.BoxLayout vertical, Clutter blur) are
  already isolated in app/util/compat.js. Note: GNOME 50 removed X11
  sessions; Xwayland clients remain and the X11 client handling in the
  corners component stays valid.

### Fixes
- Dashboard navigation: the "Window Styles" quick-access row targeted the
  page id 'styles' while the CSS page is registered as 'css'.
- Window Corners now skips Desktop Icons NG (ships with Ubuntu), which
  manages the desktop itself as a window; rounding it and replacing its
  shadow would deform the desktop.

## 26.07.14 (version 16)

### Window Corners
- Fixed windows rendering as half a window after Maximize -> Restore: the
  mask uniforms were baked while the actor still had its maximized
  allocation, so the outside-the-frame deletion erased everything past the
  midpoint. Uniforms now also refresh when the effect target's own size
  settles (notify::size).
- Shadow actor property bindings reduced to exact parity with Rounded
  Window Corners Reborn (dropped the extra 'opacity' binding).

### Window geometry
- Fixed windows left permanently semi-transparent ("a bit of transparent"):
  a second fade-move starting while one was mid-flight captured a partial
  opacity as the resting value and restored the window to it. Follow-up
  corrections during a fade now apply instantly instead of stacking fades,
  and untracking restores any partial opacity to full.

## 26.07.12.4 (version 15)

### Window Corners (shadow architecture, ported from RWC Reborn)
- The corner marks are the window's OWN drop shadow: apps draw their shadow
  shaped for the original corners, hugging them densely, and cutting a
  rounded corner exposes the shadow hiding underneath — visible over light
  backgrounds, invisible over dark ones (which is why the purple terminal
  looked correct). No mask tuning can fix this; the shadow itself must be
  replaced. Following Rounded Window Corners Reborn's architecture:
  - The mask shader now removes everything outside the frame bounds (the
    app's entire in-buffer shadow) in addition to rounding the corners.
  - Each rounded window gets a replacement shadow actor below it, shaped
    for the rounded window: a white rounded box casting a CSS box-shadow,
    with a second shader erasing the white body so only the shadow remains.
  - The shadow tracks the window through moves, resizes, animations,
    minimize, and focus changes (stronger shadow when focused), and hides
    for maximized/fullscreen windows.

## 26.07.12.3 (version 14)

### Window Corners (mask math ported from Rounded Window Corners Reborn)
- Fixed the corner marks becoming MORE visible in the last two builds: the
  inward-biased antialiasing band was sitting over the window's brighter
  interior pixels instead of its already-antialiased edge pixels, so each
  inward step made the arc brighter. The mask now uses the field-proven
  approach from Rounded Window Corners Reborn: an antialiasing band centered
  exactly on the curve (radius +/- 0.5px) with a linear falloff, plain
  multiply, and no fragment discard.
- Removed the opacity-254 "culling" clamps on window and surface actors:
  the misdiagnosed mechanism they addressed does not exist (RWC ships no
  such workaround), and they added signal churn for nothing.
- X11 clients (e.g. VSCode/Electron under Xwayland) now get the effect on
  the surface child actor rather than the window actor, matching RWC —
  the probable reason some applications appeared entirely unaffected.

## 26.07.12.2 (version 13)

### Window Corners
- Further reduced the faint light arc remaining at corners of bright
  windows over dark backgrounds: CSD windows draw a ~1px bright border
  along their perimeter, and cutting exactly at the frame corner left that
  border's arc at partial alpha. The cut is now biased half a pixel inward,
  strongly attenuating the border arc without creating a jog where the
  curve meets the straight edges.

## 26.07.12 (version 12)

### Window Corners
- Fixed light "marks" at window corners (visible over dark backgrounds,
  including on windows that were already rounded). Two causes addressed in
  the mask shader: the antialiasing band was centered ON the curve, leaving
  the boundary pixels of edges and corners at ~50% alpha (a light fringe
  for bright windows); and any premultiplied-alpha mismatch could leak the
  window color at partial weight in the cut region. The mask is now gated
  strictly to the four corner squares (straight edges are never touched),
  the antialiasing is biased fully inward so nothing survives at or outside
  the mathematical curve, and fully-cut fragments are discarded — a
  discarded fragment writes nothing, making the cut immune to blend-mode
  and premultiplication differences.

## 26.07.11.2 (version 11)

### Window Corners
- Fixed rounded corners still revealing an unpainted background: Mutter's
  opaque-region culling checks the SURFACE actor's opacity (the child
  holding the window texture), not the window actor that was previously
  clamped. Both actors are now clamped to 254 while the effect is active
  and restored on detach.

### Window geometry
- Fixed the repeated animation storm when pasting files over existing ones
  in Files: conflict dialogs report type NORMAL with no transient parent at
  window-created (both are set moments later), so each dialog was tracked
  as a new app window, animated to the app's saved position, and then saved
  its own dialog geometry into the app slot. The window's nature is now
  re-validated at restore time and on every save; late-identified dialogs
  are untracked instead.
- Restore animation is now a fade-through instead of a slide: the window
  fades out (~90ms), moves while invisible, and fades back in at its
  destination, eliminating the visible travel from the arbitrary spawn
  position. A disable mid-fade restores full opacity.

## 26.07.11 (version 10)

### Window Corners
- Fixed rounded corners revealing a white/unpainted region instead of the
  window behind when overlapping: Mutter's opaque-region culling skips
  painting whatever lies under a fully opaque window, so the transparent
  corners exposed an unrendered area. The window actor's opacity is now
  clamped to 254 while the effect is attached (visually indistinguishable,
  disables the culling); the clamp is re-applied on notify::opacity because
  the shell's map animation eases opacity back to 255, and 255 is restored
  on detach.
- Attach/skip decisions and frame/buffer rects are now logged in debug mode
  to diagnose windows the effect does not reach; if the actor is not ready
  at window-created, attachment retries on 'shown'.

## 26.07.03.2 (version 9)

### Window Corners (re-enabled, rewritten)
- Uniform rounded corners for application windows: all four corners get the
  same antialiased rounding (new keys `corners-enabled`, `corners-radius`,
  default 12), fixing the rounded-top/flat-bottom look of legacy apps.
  Maximized and fullscreen windows are automatically square.
- The mask is now computed against the frame rect INSIDE the actor buffer;
  the previous shader rounded the actor's corners, which for client-side
  decorated apps meant rounding the invisible drop-shadow margins instead
  of the window. Ported from the legacy Clutter.ShaderEffect path to a
  Shell.GLSLEffect fragment snippet with smoothstep antialiasing (the old
  'discard' produced jagged edges).
- Removed the "Flatten Windows" (square) mode: apps draw their own rounded
  top corners and the pixels outside that curve do not exist, so an effect
  can only remove pixels, never invent content. The preferences page states
  this limitation. Also removed the shell-CSS injection that fought
  PanelsManager with !important rules on the same selectors.

## 26.07.03 (version 8)

### Window geometry
- Per-title memory within each app: windows of one app sharing a wm_class
  (Nautilus Files vs Trash vs mounted drives) previously shared a single
  slot, so the last-touched window's geometry leaked onto its siblings.
  Distinctly titled windows now get their own sub-slot (up to 10 per app,
  oldest pruned); apps with volatile titles such as browsers fall back to
  the app-level slot.
- Restore no longer feels like remote control: the first attempt now runs
  immediately (fast apps get placed while the map animation still covers
  the window), and any correction applied to an already-visible window
  glides there over 220ms instead of teleporting. Sub-8px corrections are
  not animated; size changes remain instant to avoid distorting window
  contents. Glide state is reset if a window is untracked mid-animation.

## 26.07.02.6 (version 7)

### Window geometry
- Fixed restore never firing for apps that establish or change their
  identity after mapping (Firefox 'firefox' -> 'firefox_firefox', Chrome,
  and GTK4 single-instance apps such as Nautilus, Text Editor, Settings,
  and Boxes). Saves run under the final identity, but restore looked up the
  cache with the first non-null wm_class and silently missed. Restore now
  waits until the identity matches a saved entry (up to ~3s), reacts to
  wm-class change notifications, and only then applies.
- Verification extended to 4 passes; if an app insists on its own size, the
  final pass enforces at least the saved position (position-only moves
  always stick on Wayland since clients cannot position themselves).
- Saves are now logged (debug mode) with identity and geometry for easier
  diagnosis.

## 26.07.02.5 (version 6)

### Defaults
- Panel Buttons: Corner Radius now defaults to 6, Natural Padding to 4
  (Min Padding stays 4). The Default (GNOME) preset matches.

### Panel buttons
- Buttons now stay highlighted while their menu is open (active background),
  including the extension indicator, which swallows press events for its
  custom click handling and previously never highlighted. Menu-open ranks
  above hover, so moving the pointer into an open menu no longer clears the
  highlight.

### Clock
- Restored hover and active feedback on the clock: neutralizing the theme's
  inner pill had removed its only hover styling. The clock stylesheet now
  provides hover/active/checked backgrounds using the configured colors
  (or a shell-like overlay when the hover effect is disabled).

### Window geometry
- Maximized state is now saved and restored: an app closed maximized reopens
  maximized, and unmaximizing returns it to the last remembered floating
  size and position.
- Restore now verifies itself and reapplies up to two times, beating apps
  that asynchronously restore their own size after mapping (libadwaita
  apps, browsers, terminals) and previously overrode the extension's
  placement.

## 26.07.02.4 (version 5)

### Defaults
- Show Apps, Favorites, Running, Disks, and Trash buttons are now enabled by
  default on fresh installs.

### Style -> Presets (reworked)
- Removed Daylight and Neon Cyber. Presets are now: Default (GNOME),
  macOS Light, macOS Dark, Windows 11 Light, Windows 11 Dark, tuned to the
  real platform values (macOS: heavy-blur translucent bar, no border or
  shadow, 5px selection rounding, 10px menus with soft large shadows,
  status-items-only bar; Windows 11: bottom Mica bar with hairline edge
  divider, 6px hover rounding, 8px flyouts with tight shadows, Start +
  pinned + running on the bar).
- Every preset now sets all visual keys, so switching presets is
  deterministic and leaves no residue from the previous one.
- Fixed preset application crashes: `panel-bg-gradient-dir` (a plain int
  key) was written via set_enum, and app position enum keys were written
  via set_int; both threw mid-batch.

## 26.07.02.3 (version 4)

### App buttons
- New Apps -> Item Padding setting (`apps-btn-padding`, default 4px): custom
  app/disk/trash buttons keep their own inner spacing even when the global
  Style -> Panel Buttons padding is 0. Previously the global button styler
  overwrote the buttons' hardcoded padding, leaving icons with no space.

### Clock button styling
- Corner Radius and padding are now enforced on the clock via a loaded
  stylesheet covering all pseudo-states (:hover/:active/:checked), since the
  theme's pill rules could not be reliably overridden with inline actor
  styles across GNOME versions and themes. The stylesheet is unloaded when
  panel styling is disabled.

## 26.07.02.2 (version 3)

### Clock button styling
- The clock now follows Style -> Panel Buttons -> Corner Radius and the
  configured padding like every other button. The stock GNOME theme zeroes
  the clock button's own padding and draws a fixed-radius pill on the inner
  `.clock` label; the button styler now gives the clock button explicit
  symmetric padding and neutralizes the inner pill, restoring both when
  styling is disabled.

## 26.07.02 (version 2)

### Panel layout
- Default button order is now: Show Apps, Overview, Favorites, Running on
  the left; Disks, Trash, Indicator on the right (before native indicators,
  clock, and system menu).
- Multi-button groups (Disks, Favorites) no longer swallow the items placed
  after them: Trash offsets past the Disks group and Running past the
  Favorites group, so static index settings keep their logical meaning.
- The rebuild order now builds groups before the items positioned after them.

### Clock
- Fixed the double hover background on the custom clock. The inner clock box
  is now a passive container; the enclosing dateMenu button owns hover,
  active state, click handling, and the roundness/background styling applied
  to `.panel-button`, matching every other panel button.

### Window geometry (rewritten)
- No longer restores already-open windows on enable; GNOME re-enables
  extensions on every unlock and shell restart, which previously snapped all
  open windows back to their saved slots.
- Fixed the save/restore race: a new window's own initial self-placement can
  no longer overwrite the saved slot before restore reads it.
- Restore now waits briefly for `wm_class` (often set late on Wayland).
- Only normal, non-transient windows participate; dialogs sharing an app's
  `wm_class` no longer corrupt the app's saved geometry.
- Restored geometry is clamped to the current work area so disconnected or
  not-yet-configured monitors cannot push windows off-screen.
- The geometry store is pruned by age (180 days) and size (300 apps).
- Pending geometry saves are flushed on disable instead of dropped.

### Compatibility (GNOME 46-49)
- New `app/util/compat.js` isolates version-sensitive shell APIs.
- `Meta.Window.get_maximized()` (removed in GNOME 49) replaced via compat
  helper using `is_maximized()`.
- Deprecated `St.BoxLayout` `vertical` property replaced with `orientation`
  via compat helper (clock, apps identity dialog).
- Wallpaper blur switched from legacy `Clutter.BlurEffect` to
  `Shell.BlurEffect`.

### Settings and stability
- All settings objects are now resolved from the extension's own `schemas/`
  directory via `AppConfig.getSettings()`; the schema no longer needs to be
  installed globally, and backend/preferences can no longer read diverging
  schemas.
- Removed `run_dispose()` on shared `Gio.Settings`; signals are tracked and
  disconnected properly.
- Component signal cleanup is resilient to already-disposed objects.
- The apps update debounce timer is removed on disable so it cannot fire
  against destroyed buttons.

### Wallpaper
- Backup moved from the extension directory (read-only for system installs,
  wiped on updates) to the user state directory, with one-time migration.
- Blur/brightness effects are re-applied after monitor changes instead of
  silently disappearing.

### Behavior and review compliance
- "Disable Extension" now goes through the GNOME extension manager instead
  of calling `disable()` directly (which desynced shell state and destroyed
  the menu mid-signal).
- Opening preferences no longer force-closes other applications' windows or
  spawns `gnome-extensions prefs` as a subprocess.

## 1.34-beta (version 1)

- Initial development versions.

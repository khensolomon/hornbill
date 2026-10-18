# Define the extension UUID as a variable
EXT ?= hornbill@lethil.me

# Mark targets as PHONY so Make doesn't look for files with these names
.PHONY: check prefs reset uninstall disable enable refresh reload logs

check:
	@./check.sh

prefs:
	@echo "-- Opening preferences for extension $(EXT) ..."
	gnome-extensions prefs $(EXT)

reset:
	@echo "-- Resetting extension $(EXT) ..."
	dconf reset -f /org/gnome/shell/extensions/$(EXT)/

uninstall:
	@echo "-- Uninstalling extension $(EXT) ..."
	gnome-extensions uninstall $(EXT)

disable:
	@echo "-- Disabling extension $(EXT) ..."
	gnome-extensions disable $(EXT)

enable:
	@echo "-- Enabling extension $(EXT) ..."
	gnome-extensions enable $(EXT)

refresh:
	@echo "Compiling schemas..."
	glib-compile-schemas schemas/
	@echo "-- Reloading extension $(EXT) ..."
	-gnome-extensions disable $(EXT) 2>/dev/null || true
	sleep 0.5
	gnome-extensions enable $(EXT)
	@echo "Done."

# org.gnome.Shell.Eval is disabled outside unsafe mode since GNOME 41, and
# dbus-send exits 0 even when Eval refuses, so the old target reported a
# restart that never happened. Restarting cannot be scripted; say how instead.
reload:
	@echo "GNOME Shell cannot be restarted from a script."
	@echo "  X11:     Alt+F2, type r, Enter."
	@echo "  Wayland: log out and back in, or test in a nested session"
	@echo "           (dbus-run-session gnome-shell --devkit on GNOME 49+,"
	@echo "            dbus-run-session gnome-shell --nested --wayland on 46-48)."
	@exit 1

logs:
	@echo "-- Watching logs for gnome-shell:"
	journalctl -f -o cat /usr/bin/gnome-shell
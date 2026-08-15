# Define the extension UUID as a variable
EXT ?= lesion@lethil.me

# Mark targets as PHONY so Make doesn't look for files with these names
.PHONY: uninstall disable enable refresh reload logs

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

reload:
	@echo "Attempting to restart GNOME Shell via D-Bus..."
	@if dbus-send --session --type=method_call --dest=org.gnome.Shell /org/gnome/Shell org.gnome.Shell.Eval string:'true' >/dev/null 2>&1; then \
		dbus-send --session --type=method_call --dest=org.gnome.Shell /org/gnome/Shell org.gnome.Shell.Eval string:'global.reexec_self();'; \
		echo "GNOME Shell restarted."; \
	else \
		echo "GNOME Shell not available on D-Bus (Are you on Wayland?)."; \
	fi

logs:
	@echo "-- Watching logs for gnome-shell:"
	journalctl -f -o cat /usr/bin/gnome-shell
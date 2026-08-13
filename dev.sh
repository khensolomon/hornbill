#!/bin/bash
# bash dev.sh
set -e

ln -s "$(pwd)" ~/.local/share/gnome-shell/extensions/lesion@lethil.me
echo "Compiling schemas..."
glib-compile-schemas schemas/
echo "Reloading GNOME Shell..."
gnome-extensions disable lesion@lethil.me || true
gnome-extensions enable lesion@lethil.me
echo "Done."

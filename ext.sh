#!/usr/bin/env bash
#
# DOCSTRING_START
# EXT.SH - GNOME Extension Management & Development Helper
# ==============================================================================
# A lightweight automation script for building, testing, refreshing, 
# packaging, and debugging GNOME Shell extensions under Wayland.
#
# USAGE:
#   ./ext.sh [OPTIONS] [COMMAND]
#
# OPTIONS:
#   -p, --path <dir>   Path to extension source directory.
#                      (Defaults to current working directory if omitted/invalid)
#   -h, --help         Show this documentation and exit.
#
# COMMANDS:
#   install      Syncs source files, compiles schemas, and enables extension.
#   reload       Alias for refresh.
#   refresh      Syncs source changes, compiles schemas, and toggles
#                the extension off/on (Default action if none provided).
#   enable       Enables the installed extension.
#   disable      Disables the installed extension.
#   reset-prefs  Clears all dconf/gsettings user preferences for the extension.
#   logs         Streams live journalctl logs for GNOME Shell / your extension.
#   watch        Monitors files for changes and auto-refreshes on save.
#   pack         Creates a production .zip respecting .gitignore & .extensionignore.
#   check        Validates metadata.json structure.
#   uninstall    Disables and deletes installed extension files.
#   nested       Launches an isolated nested GNOME Shell window for debugging.
#   help         Show this documentation and exit.
#
# EXAMPLES:
#   ./ext.sh
#   ./ext.sh watch
#   ./ext.sh logs
#   ./ext.sh pack
#   ./ext.sh --path ~/projects/my-extension reset-prefs
# ==============================================================================
# DOCSTRING_END

set -e

# --- ANSI Colors ---
CLR_RESET="\033[0m"
CLR_INFO="\033[1;34m"
CLR_SUCCESS="\033[1;32m"
CLR_WARN="\033[1;33m"
CLR_ERR="\033[1;31m"

log_info()    { echo -e "${CLR_INFO}[INFO]${CLR_RESET} $1"; }
log_success() { echo -e "${CLR_SUCCESS}[OK]${CLR_RESET} $1"; }
log_warn()    { echo -e "${CLR_WARN}[WARN]${CLR_RESET} $1"; }
log_err()     { echo -e "${CLR_ERR}[ERR]${CLR_RESET} $1"; }

# --- Helper Function: Show Docstring ---
show_help() {
    sed -n '/^# DOCSTRING_START/,/^# DOCSTRING_END/p' "$0" \
        | sed '1d;$d' \
        | sed 's/^# \?//'
    exit 0
}

TARGET_PATH="$(pwd)"
POSITIONAL_ARGS=()

while [[ $# -gt 0 ]]; do
  case $1 in
    --path|-p)
      if [[ -n "$2" && ! "$2" =~ ^-- ]]; then
        TARGET_PATH="$2"
        shift 2
      else
        log_err "Argument $1 requires a non-empty path."
        exit 1
      fi
      ;;
    --help|-h)
      show_help
      ;;
    *)
      POSITIONAL_ARGS+=("$1")
      shift
      ;;
  esac
done

set -- "${POSITIONAL_ARGS[@]}"

COMMAND="${1:-refresh}"

if [[ "$COMMAND" == "help" ]]; then
    show_help
fi

# --- Path Validation ---
if [[ ! -d "$TARGET_PATH" ]]; then
    log_warn "Directory '${TARGET_PATH}' does not exist. Falling back to current directory."
    TARGET_PATH="$(pwd)"
fi

SRC_DIR="$(cd "$TARGET_PATH" && pwd)"
METADATA_FILE="${SRC_DIR}/metadata.json"

if [[ ! -f "$METADATA_FILE" ]]; then
    log_err "No 'metadata.json' found in target directory: ${SRC_DIR}"
    exit 1
fi

UUID=$(python3 -c "import json; print(json.load(open('${METADATA_FILE}')).get('uuid', ''))")
SETTINGS_SCHEMA=$(python3 -c "import json; print(json.load(open('${METADATA_FILE}')).get('settings-schema', ''))")

if [[ -z "$UUID" ]]; then
    log_err "'uuid' field is missing or empty in ${METADATA_FILE}"
    exit 1
fi

INSTALL_DIR="${HOME}/.local/share/gnome-shell/extensions/${UUID}"

log_info "Target Directory : ${SRC_DIR}"
log_info "Extension UUID   : ${UUID}"

# --- Helper Functions ---
compile_schemas() {
    if [[ -d "${SRC_DIR}/schemas" ]]; then
        log_info "Compiling GSettings schemas..."
        glib-compile-schemas "${SRC_DIR}/schemas" || log_warn "Failed to compile schemas."
    fi
}

install_ext() {
    compile_schemas
    log_info "Installing extension to ${INSTALL_DIR}..."
    mkdir -p "${INSTALL_DIR}"
    rsync -av --delete \
        --exclude='.git*' \
        --exclude='*.sh' \
        --exclude='*.zip' \
        --exclude='README*' \
        "${SRC_DIR}/" "${INSTALL_DIR}/"
    log_success "Installed successfully."
}

enable_ext() {
    log_info "Enabling extension..."
    gnome-extensions enable "${UUID}" || log_warn "Failed to enable or already enabled."
}

disable_ext() {
    log_info "Disabling extension..."
    gnome-extensions disable "${UUID}" || log_warn "Failed to disable or already disabled."
}

reload_ext() {
    log_info "Reloading extension..."
    disable_ext
    sleep 0.4
    enable_ext
    log_success "Reload triggered."
}

reset_prefs() {
    log_info "Resetting preferences..."
    SCHEMA_ID="$SETTINGS_SCHEMA"
    
    if [[ -z "$SCHEMA_ID" && -d "${SRC_DIR}/schemas" ]]; then
        SCHEMA_FILE=$(find "${SRC_DIR}/schemas" -maxdepth 1 -name "*.gschema.xml" | head -n 1)
        if [[ -n "$SCHEMA_FILE" ]]; then
            SCHEMA_ID=$(python3 -c "import xml.etree.ElementTree as ET; tree = ET.parse('${SCHEMA_FILE}'); print(tree.getroot().find('schema').attrib['id'])" 2>/dev/null || true)
        fi
    fi

    if [[ -z "$SCHEMA_ID" ]]; then
        CLEAN_UUID=$(echo "$UUID" | tr '-' '_' | tr '@' '_')
        SCHEMA_ID="org.gnome.shell.extensions.${CLEAN_UUID}"
    fi

    if dconf list "/org/gnome/shell/extensions/${UUID}/" &>/dev/null; then
        dconf reset -f "/org/gnome/shell/extensions/${UUID}/"
    fi

    if gsettings list-relocatable-schemas | grep -q "org.gnome.shell.extensions"; then
        gsettings reset-recursively "${SCHEMA_ID}" 2>/dev/null || true
    fi

    log_success "Preferences reset complete."
}

stream_logs() {
    log_info "Streaming GNOME Shell journalctl logs (Ctrl+C to stop)..."
    journalctl -f -o cat /usr/bin/gnome-shell | grep -i --line-buffered -E "(${UUID}|extension|JS ERROR|Gjs)"
}

watch_changes() {
    if ! command -v inotifywait &> /dev/null; then
        log_err "'inotifywait' is not installed. Install it via: sudo apt install inotify-tools"
        exit 1
    fi

    log_info "Watching ${SRC_DIR} for changes (Ctrl+C to stop)..."
    install_ext
    reload_ext

    inotifywait -m -r -e modify,create,delete --exclude '(\.git|\.zip|schemas/gschemas\.compiled)' "${SRC_DIR}" | while read -r path action file; do
        log_info "Change detected in ${file}. Refreshing..."
        install_ext
        reload_ext
    done
}

pack_extension() {
    compile_schemas
    ZIP_NAME="${UUID}.shell-extension.zip"
    log_info "Packaging extension to ${ZIP_NAME}..."
    
    cd "${SRC_DIR}"
    
    # 1. Require a Git repository for resolution
    if ! git rev-parse --is-inside-work-tree &>/dev/null; then
        log_err "pack command requires a Git repository to resolve file lists."
        exit 1
    fi

    # 2. Get clean file list (inherits .gitignore automatically)
    TMP_FILELIST=$(mktemp)
    git ls-files --cached --others --exclude-standard > "$TMP_FILELIST"

    # 3. Filter out tracked files listed in .extensionignore
    if [[ -f "${SRC_DIR}/.extensionignore" ]]; then
        log_info "Applying .extensionignore filter..."
        GREP_EXCLUDES=()
        while IFS= read -r line || [[ -n "$line" ]]; do
            [[ -z "$line" || "$line" =~ ^# ]] && continue
            GREP_EXCLUDES+=("-e" "^${line}")
        done < "${SRC_DIR}/.extensionignore"

        if [[ ${#GREP_EXCLUDES[@]} -gt 0 ]]; then
            grep -v "${GREP_EXCLUDES[@]}" "$TMP_FILELIST" > "${TMP_FILELIST}.tmp" && mv "${TMP_FILELIST}.tmp" "$TMP_FILELIST"
        fi
    fi

    # 4. Remove system files and script from zip payload
    grep -v -E "(ext\.sh|${ZIP_NAME}|\.extensionignore)" "$TMP_FILELIST" > "${TMP_FILELIST}.tmp" && mv "${TMP_FILELIST}.tmp" "$TMP_FILELIST"

    # 5. Build clean archive
    rm -f "${ZIP_NAME}"
    zip -q "${ZIP_NAME}" -@ < "$TMP_FILELIST"
    rm -f "$TMP_FILELIST"
    
    log_success "Created clean archive: ${SRC_DIR}/${ZIP_NAME}"
}

check_syntax() {
    log_info "Validating metadata.json structure..."
    python3 -c "
import json
data = json.load(open('${METADATA_FILE}'))
required = ['uuid', 'name', 'description', 'shell-version']
missing = [field for field in required if field not in data]
if missing:
    print('  [x] Missing required fields:', missing)
    exit(1)
else:
    print('  [✓] metadata.json structure valid.')
"
    log_success "Checks completed."
}

uninstall_ext() {
    log_info "Uninstalling extension..."
    disable_ext 2>/dev/null || true
    if [[ -d "${INSTALL_DIR}" ]]; then
        rm -rf "${INSTALL_DIR}"
        log_success "Removed ${INSTALL_DIR}"
    else
        log_warn "Extension directory does not exist."
    fi
}

nested_shell() {
    log_info "Launching nested GNOME Shell instance..."
    dbus-run-session gnome-shell --nested --wayland
}

# --- Command Handler ---
case "$COMMAND" in
    install)
        install_ext
        enable_ext
        ;;
    enable)
        enable_ext
        ;;
    disable)
        disable_ext
        ;;
    reload|refresh)
        install_ext
        reload_ext
        ;;
    reset-prefs)
        reset_prefs
        reload_ext
        ;;
    logs)
        stream_logs
        ;;
    watch)
        watch_changes
        ;;
    pack)
        pack_extension
        ;;
    check)
        check_syntax
        ;;
    uninstall)
        uninstall_ext
        ;;
    nested)
        nested_shell
        ;;
    *)
        log_err "Unknown command '$COMMAND'\n"
        show_help
        ;;
esac
#!/usr/bin/env python3
"""
Universal GNOME Shell Extension Installer & Dev Tool.

This script manages the installation of GNOME Shell extensions for both
end-users (installing from GitHub) and developers (symlinking local source).

--------------------------------------------------------------------------------
MODES OF OPERATION
--------------------------------------------------------------------------------

1. Auto-Detection (Default behavior):
   - The script checks for 'metadata.json' in the current directory.
   - If FOUND: Assumes a DEVELOPER working in the source repo.
     Switches to 'Dev Mode' (symlinking).
   - If MISSING: Assumes an END-USER running a standalone script.
     Switches to 'Remote Mode' (downloading from GitHub).

2. Dev Mode (--mode dev):
   - Creates a symbolic link from the current directory (or --src) to
     ~/.local/share/gnome-shell/extensions/<uuid>.
   - Compiles GSettings schemas globally in ~/.local/share/glib-2.0/schemas. 
     CRITICAL: This allows settings to work immediately upon Shell restart
     (Alt+F2 -> r) without needing a full logout/login.

3. Remote Mode (--mode remote):
   - Downloads a specific tag/branch (default: master) from GitHub.
   - Extracts and copies files to the extensions directory, respecting 
     .extensionignore and .gitignore.
   - Compiles schemas globally (just like Dev Mode) to prevent 
     "Preferences Error" issues.

--------------------------------------------------------------------------------
USAGE EXAMPLES
--------------------------------------------------------------------------------

  [Developer]
  1. Setup environment (run from repo root):
     $ python3 install.py

  [End-User]
  1. Install latest master branch:
     curl https://raw.githubusercontent.com/khensolomon/hornbill/master/install.py | python3 -
"""

import os
import sys
import shutil
import json
import argparse
import importlib.util
import subprocess
import tarfile
import tempfile
import urllib.request
import textwrap
import fnmatch
import xml.etree.ElementTree as ET

# --- Configuration ---
# Set to the target repository to allow seamless curl piping
DEFAULT_REPO = os.environ.get("GNOME_EXT_REPO", "khensolomon/hornbill")
DEFAULT_REF = os.environ.get("GNOME_EXT_REF", "master")

# Standard GNOME paths
GLOBAL_SCHEMAS_DIR = os.path.expanduser("~/.local/share/glib-2.0/schemas")
EXTENSIONS_PATH = os.path.expanduser("~/.local/share/gnome-shell/extensions")

# Colors for diagnostics
RED = "\033[91m"
YELLOW = "\033[93m"
GREEN = "\033[92m"
RESET = "\033[0m"

def load_po_manager(root_dir):
    """
    Load po/manage.py as a module from `root_dir`.

    po/ is not a Python package, so it is loaded by path. This keeps
    po/manage.py the single implementation of the translation pipeline —
    this script never compiles catalogs itself.

    Returns the module, or None when po/manage.py is not present (the curl
    one-liner runs before any source exists, and an installed copy has no po/).
    """
    manage_py = os.path.join(root_dir, "po", "manage.py")
    if not os.path.isfile(manage_py):
        return None
    spec = importlib.util.spec_from_file_location("hornbill_po_manage", manage_py)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def compile_locales(root_dir):
    """
    Refresh locale/<lang>/LC_MESSAGES/*.mo via po/manage.py.

    gettext is a developer dependency, not an end-user one, so compile_catalogs()
    falls back to its own MO writer when msgfmt is absent. .mo files are no
    longer committed, so there is nothing to fall back on otherwise — the old
    "using the .mo files already in locale/" message described files that would
    not be there.
    """
    manage = load_po_manager(root_dir)
    if manage is None:
        print(f"{YELLOW}No po/ directory in this source; interface stays in English.{RESET}")
        return False

    try:
        written = manage.compile_catalogs(root_dir, verbose=True)
    except manage.MissingToolError as e:
        print(f"{YELLOW}Locale compilation skipped: {e}{RESET}")
        print("The interface will stay in English.")
        return False
    except subprocess.CalledProcessError as e:
        print(f"{YELLOW}Locale compilation failed: msgfmt exited {e.returncode}{RESET}")
        return False

    if written:
        print(f"{GREEN}Compiled {len(written)} translation catalog(s).{RESET}")
    return bool(written)


def check_dependencies():
    """Validates required system binaries are present."""
    missing = []
    if not shutil.which("glib-compile-schemas"):
        missing.append("glib-compile-schemas (install glib2-devel or libglib2.0-dev)")
    if not shutil.which("gsettings"):
        missing.append("gsettings (install glib2 or libglib2.0-bin)")
        
    if missing:
        sys.exit(f"{RED}Error: Missing required system dependencies:\n- " + "\n- ".join(missing) + f"{RESET}")

def load_ignore_patterns(*roots):
    """
    Parse .gitignore and .extensionignore into (excludes, negations).

    Negation ('!pattern', gitignore syntax) is supported because the two files
    have different jobs: .gitignore keeps build artefacts out of version
    control, while packaging REQUIRES some of them. schemas/gschemas.compiled
    is the case that matters — '*.compiled' in .gitignore was silently dropping
    it from every zip, and the extension looks for that exact file at runtime.
    """
    excludes, negations = [], []
    root = roots[0] if roots else "."
    for ignore_file in [".gitignore", ".extensionignore"]:
        target = os.path.join(root, ignore_file)
        if not os.path.exists(target):
            continue
        with open(target, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                if line.startswith("!"):
                    negations.append(line[1:].strip())
                else:
                    excludes.append(line)
    return excludes, negations


def _matches(filename, patterns):
    """True when `filename` matches any pattern (path, basename, or parent dir)."""
    normalized = filename.replace(os.sep, "/")
    parts = normalized.split("/")

    for pattern in patterns:
        pattern = pattern.strip()
        if not pattern:
            continue
        clean_pattern = pattern.rstrip("/")

        # 1. Full path match (handles "tests/*" and exact paths)
        if fnmatch.fnmatch(normalized, pattern) or fnmatch.fnmatch(normalized, clean_pattern):
            return True

        # 2. Basename match (handles extensions like "*.zip")
        if fnmatch.fnmatch(parts[-1], clean_pattern):
            return True

        # 3. Parent directory match (nested files inside ignored folders)
        for i in range(len(parts) - 1):
            if fnmatch.fnmatch(parts[i], clean_pattern):
                return True
            if fnmatch.fnmatch("/".join(parts[: i + 1]), clean_pattern):
                return True

    return False


def should_exclude(filename, patterns):
    """
    Check `filename` against loaded ignore patterns.

    `patterns` is the (excludes, negations) tuple from load_ignore_patterns();
    a negation match always wins.
    """
    excludes, negations = patterns
    if _matches(filename, negations):
        return False
    return _matches(filename, excludes)

def copy_with_ignore(src, dest, ignore_patterns):
    """Recursively copies files while adhering to ignore patterns."""
    os.makedirs(dest, exist_ok=True)
    for root, dirs, files in os.walk(src):
        # Filter directories in-place to prevent walking into ignored ones
        dirs[:] = [d for d in dirs if not should_exclude(os.path.relpath(os.path.join(root, d), src).replace(os.sep, '/'), ignore_patterns)]
        
        for file in files:
            rel_path = os.path.relpath(os.path.join(root, file), src).replace(os.sep, '/')
            if not should_exclude(rel_path, ignore_patterns):
                dest_dir = os.path.join(dest, os.path.relpath(root, src))
                os.makedirs(dest_dir, exist_ok=True)
                shutil.copy2(os.path.join(root, file), os.path.join(dest_dir, file))

def get_metadata_path(src_dir):
    return os.path.join(src_dir, "metadata.json")

def load_metadata(src_dir):
    path = get_metadata_path(src_dir)
    if not os.path.isfile(path):
        sys.exit(f"{RED}Error: metadata.json not found in {src_dir}{RESET}")
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception as e:
        sys.exit(f"{RED}Error parsing metadata.json: {e}{RESET}")

def run_cmd(cmd, check=False, quiet=False):
    stdout = subprocess.DEVNULL if quiet else None
    stderr = subprocess.DEVNULL if quiet else None
    try:
        subprocess.run(cmd, check=check, stdout=stdout, stderr=stderr)
        return True
    except (subprocess.CalledProcessError, FileNotFoundError):
        return False

def get_schema_ids_from_file(xml_path):
    ids = []
    try:
        tree = ET.parse(xml_path)
        root = tree.getroot()
        if root.tag == 'schema':
             if 'id' in root.attrib: ids.append(root.attrib['id'])
        else:
            for schema in root.findall(".//schema"):
                if 'id' in schema.attrib:
                    ids.append(schema.attrib['id'])
    except Exception:
        pass
    return ids

def install_schemas(src_schemas_dir):
    """
    Compiles schemas locally AND installs them globally to the user local share.
    Returns a list of Schema IDs found in the files.
    """
    found_ids = []
    
    if os.path.isdir(src_schemas_dir):
        # 1. Global Install (for immediate effect and stability)
        os.makedirs(GLOBAL_SCHEMAS_DIR, exist_ok=True)
        files_found = 0
        
        for f in os.listdir(src_schemas_dir):
            if f.endswith(".gschema.xml"):
                src_file = os.path.join(src_schemas_dir, f)
                found_ids.extend(get_schema_ids_from_file(src_file))
                shutil.copy(src_file, GLOBAL_SCHEMAS_DIR)
                files_found += 1
        
        if files_found > 0:
            try:
                subprocess.run(["glib-compile-schemas", GLOBAL_SCHEMAS_DIR], check=True)
                print(f"Compiled {files_found} global schema(s) in {GLOBAL_SCHEMAS_DIR}")
            except subprocess.CalledProcessError:
                print(f"{RED}Warning: Failed to compile global schemas.{RESET}")
            except FileNotFoundError:
                # Only CalledProcessError was caught before, so an ABSENT
                # binary escaped as a traceback rather than a message. The
                # compiled schema is not optional — without it the extension
                # cannot open its preferences at all.
                sys.exit(
                    f"{RED}Error: 'glib-compile-schemas' not found.{RESET}\n"
                    "It ships with GLib and is normally present on any GNOME system.\n"
                    "Debian/Ubuntu: sudo apt install libglib2.0-bin\n"
                    "Fedora:        sudo dnf install glib2-devel"
                )

        # 2. Local Compile (for portability/standard compliance)
        try:
            subprocess.run(["glib-compile-schemas", src_schemas_dir], check=False)
            print("Compiled schemas locally.")
        except FileNotFoundError:
            print(f"{YELLOW}Warning: local schema compile skipped (glib-compile-schemas absent).{RESET}")
    
    return found_ids

def run_diagnostics(target_schema_id, found_ids):
    """Checks if the system can accurately detect the schema."""
    if not target_schema_id:
        return

    # A. Check Consistency
    if target_schema_id not in found_ids:
        print(f"\n{RED}!!! CONFIGURATION ERROR DETECTED !!!{RESET}")
        print(f"{YELLOW}metadata.json requests schema: '{target_schema_id}'{RESET}")
        print(f"{YELLOW}However, local XML files only defined: {found_ids}{RESET}")
        print(f"-> Please open schemas/*.gschema.xml and ensure <schema id=\"{target_schema_id}\" ...>")
        return

    print(f"{GREEN}✓ Schema ID '{target_schema_id}' found in XML files.{RESET}")

    # B. Check System Registry
    print(f"Verifying system registry...")
    proc = subprocess.run(
        ["gsettings", "list-keys", target_schema_id], 
        stdout=subprocess.PIPE, 
        stderr=subprocess.PIPE, 
        text=True
    )
    
    if proc.returncode == 0:
            print(f"{GREEN}✓ System successfully sees schema '{target_schema_id}'.{RESET}")
    else:
            print(f"\n{RED}X System cannot find schema '{target_schema_id}' yet.{RESET}")
            print(f"{YELLOW}Diagnosed Cause:{RESET}")
            print(f"The XML file is installed, but the desktop session has not loaded it.")
            print(f"{YELLOW}Solution:{RESET}")
            print(f"A logout and login sequence is required to fix the Preferences window.")

def reset_settings_logic(schema_id):
    """Attempts to reset settings for the given schema ID."""
    if not schema_id:
        print(f"{YELLOW}Warning: No 'settings-schema' in metadata.json. Cannot reset settings.{RESET}")
        return

    print(f"Resetting settings for {schema_id}...")
    
    # Check if schema is visible first
    if not run_cmd(["gsettings", "list-keys", schema_id], quiet=True):
        print(f"{RED}Error: Schema '{schema_id}' is not visible to gsettings.{RESET}")
        print(f"Compilation was attempted globally, but the schema remains invisible. A logout and login sequence is recommended.")
        return

    if run_cmd(["gsettings", "reset-recursively", schema_id]):
        print(f"{GREEN}✓ Settings reset to default.{RESET}")
    else:
        print(f"{RED}Error: Failed to execute gsettings reset.{RESET}")

def get_archive_url(repo, ref):
    if ref.startswith("v"):
        return f"https://github.com/{repo}/archive/refs/tags/{ref}.tar.gz"
    return f"https://github.com/{repo}/archive/refs/heads/{ref}.tar.gz"

def install_remote(args, target_base):
    """Downloads and installs the extension from GitHub (User Mode)."""
    repo = args.repo
    ref = args.ref
    
    url = get_archive_url(repo, ref)

    print(f"--- Remote Install Mode ---")
    print(f"Source: GitHub ({repo} @ {ref})")
    print(f"Downloading: {url}...")

    with tempfile.TemporaryDirectory() as tmpdir:
        archive_path = os.path.join(tmpdir, "source.tar.gz")
        try:
            urllib.request.urlretrieve(url, archive_path)
        except Exception as e:
            sys.exit(f"{RED}Download failed: {e}{RESET}")

        try:
            with tarfile.open(archive_path, "r:gz") as tar:
                tar.extractall(tmpdir)
        except Exception as e:
            sys.exit(f"{RED}Extraction failed: {e}{RESET}")

        extracted_items = [
            os.path.join(tmpdir, d) for d in os.listdir(tmpdir)
            if os.path.isdir(os.path.join(tmpdir, d))
        ]
        if not extracted_items:
            sys.exit(f"{RED}Error: Archive contained no directories.{RESET}")
        
        src_dir = extracted_items[0]
        metadata = load_metadata(src_dir)
        uuid = metadata.get("uuid")
        if not uuid:
            sys.exit(f"{RED}Error: UUID missing in downloaded metadata.json{RESET}")

        remove_superseded(target_base, uuid)

        dest_dir = os.path.join(target_base, uuid)
        
        if os.path.exists(dest_dir):
            if os.path.islink(dest_dir):
                os.unlink(dest_dir)
            else:
                shutil.rmtree(dest_dir)

        # Compile catalogs in the extracted source BEFORE copying: .extensionignore
        # excludes po/ from the installed copy, so this is the last moment the
        # sources are available.
        compile_locales(src_dir)

        # Parse ignore files from the downloaded source
        ignore_patterns = load_ignore_patterns(src_dir)

        # Install files using the custom copy function
        copy_with_ignore(src_dir, dest_dir, ignore_patterns)
        print(f"Installed to: {dest_dir} (Ignored {len(ignore_patterns)} patterns)")

        # --- UNIFIED SCHEMA LOGIC ---
        schemas_dir = os.path.join(dest_dir, "schemas")
        found_ids = install_schemas(schemas_dir)

        # Enable
        if run_cmd(["which", "gnome-extensions"], quiet=True):
            run_cmd(["gnome-extensions", "enable", uuid])
            print("Extension enabled via gnome-extensions.")
        
        # Check
        target_schema_id = metadata.get("settings-schema")
        run_diagnostics(target_schema_id, found_ids)
        
        # Support Reset in Remote Mode
        if args.reset_settings:
            reset_settings_logic(target_schema_id)
        
        print("\nDone! If the extension fails to appear, execute a logout and login sequence.")

# UUIDs this extension has shipped under previously. The UUID *is* the identity
# to GNOME, so a rename installs a second, independent extension rather than
# replacing the first. Left in place both load together: duplicate panel
# buttons, and two hard failures — addToStatusArea() rejects a duplicate role,
# and a GTypeName can only be registered once per process. Removing the
# predecessor is not tidiness, it is what makes the new one able to run.
# HISTORICAL VALUE — do not update to the current UUID. This names what to
# find and delete; pointing it at hornbill@lethil.me would match the guard
# below, skip, and leave the old Lesion install running alongside the new one.
SUPERSEDED_UUIDS = ["lesion@lethil.me"]


def remove_superseded(target_base, current_uuid):
    """Disable and delete any earlier UUID of this extension."""
    for old_uuid in SUPERSEDED_UUIDS:
        if old_uuid == current_uuid:
            continue
        old_dir = os.path.join(target_base, old_uuid)
        if not os.path.exists(old_dir) and not os.path.islink(old_dir):
            continue

        print(f"{YELLOW}Found predecessor '{old_uuid}' — removing it.{RESET}")
        if run_cmd(["which", "gnome-extensions"], quiet=True):
            run_cmd(["gnome-extensions", "disable", old_uuid], quiet=True)
        try:
            if os.path.islink(old_dir):
                os.unlink(old_dir)
            else:
                shutil.rmtree(old_dir)
            print(f"Removed: {old_dir}")
        except OSError as exc:
            print(f"{RED}Could not remove {old_dir}: {exc}{RESET}")
            print(f"{YELLOW}Remove it by hand before logging back in, or both will load.{RESET}")


def install_local(args, target_base):
    """Symlinks the current directory for development (Dev Mode)."""
    src_dir = os.path.abspath(args.src) if args.src else os.getcwd()
    metadata = load_metadata(src_dir)
    
    uuid = args.uuid or metadata.get("uuid")
    target_schema_id = args.schema or metadata.get("settings-schema")

    if not uuid:
        sys.exit(f"{RED}Error: UUID not found in metadata.json{RESET}")

    remove_superseded(target_base, uuid)

    dest_dir = os.path.join(target_base, uuid)

    print(f"--- Dev Install Mode ---")
    print(f"UUID: {uuid}")
    print(f"Source: {src_dir}")
    print(f"Destination: {dest_dir}")

    # 1. Schemas (Execute this FIRST to ensure reset functionality)
    local_schemas_dir = os.path.join(src_dir, "schemas")
    found_ids = install_schemas(local_schemas_dir)

    # 1b. Translations. The symlink means locale/ is read straight from the
    #     working tree, so compiling here is what makes edited .po files show up.
    compile_locales(src_dir)

    # 2. Reset Settings (Execute this BEFORE symlink check)
    if args.reset_settings:
        reset_settings_logic(target_schema_id)

    # 3. Symlink Logic
    os.makedirs(target_base, exist_ok=True)
    
    if os.path.islink(dest_dir):
        if os.readlink(dest_dir) != src_dir:
            os.unlink(dest_dir)
            os.symlink(src_dir, dest_dir)
            print("Updated existing symlink.")
        else:
            print("Symlink already correct.")
    elif os.path.exists(dest_dir):
        print(f"{YELLOW}Warning: Target {dest_dir} exists and is NOT a symlink (it is a directory).{RESET}")
        print(f"{YELLOW}Skipping symlink creation to prevent data loss.{RESET}")
        print(f"To switch to symlink mode, manually delete the folder and execute the script again.")
    else:
        os.symlink(src_dir, dest_dir)
        print("Created symlink.")

    # 4. Diagnostics
    run_diagnostics(target_schema_id, found_ids)

    print("\nDev setup complete.")
    print("For initial installations, restart GNOME Shell (Alt+F2 -> r).")

def main():
    # Pre-flight checks
    check_dependencies()
    
    parser = argparse.ArgumentParser(
        description="Install GNOME Shell Extension (Dev & User modes)",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=textwrap.dedent("""
            examples:
              # Dev: Link current dir and compile schemas
              ./install.py
              
              # Dev: Wipe settings for a fresh start
              ./install.py --reset-settings
              
              # User: Download and install master branch
              curl https://raw.githubusercontent.com/khensolomon/hornbill/master/install.py | python3 -
        """)
    )
    
    # Mode selection
    parser.add_argument("--mode", choices=["auto", "dev", "remote"], default="auto", 
                        help="Force install mode (default: auto-detect based on metadata.json presence)")
    
    # Dev options
    parser.add_argument("--src", help="Source directory (Dev mode only)")
    parser.add_argument("--uuid", help="Override UUID (Dev mode only)")
    parser.add_argument("--schema", help="Override schema ID (Dev mode only)")
    parser.add_argument("--reset-settings", action="store_true", help="Reset GSettings to defaults")
    
    # Remote options
    parser.add_argument("--ref", default=DEFAULT_REF, help=f"Git reference/tag to install (default: {DEFAULT_REF})")
    parser.add_argument("--repo", default=DEFAULT_REPO, help=f"GitHub repository (default: {DEFAULT_REPO})")

    args = parser.parse_args()

    mode = args.mode
    if mode == "auto":
        has_local_meta = os.path.isfile("metadata.json") or (args.src and os.path.isfile(os.path.join(args.src, "metadata.json")))
        mode = "dev" if has_local_meta else "remote"

    if mode == "remote":
        install_remote(args, EXTENSIONS_PATH)
    else:
        install_local(args, EXTENSIONS_PATH)

if __name__ == "__main__":
    main()
#!/usr/bin/env python3
"""
GNOME Extension Builder
-----------------------
This script automates the packaging of a GNOME Shell extension.
It reads the `metadata.json` file to determine the UUID and version,
creates a zip file with the correct naming convention, and moves
it to a target directory.

USAGE EXAMPLES:
-----------------------
1. Standard Build (Recommended)
   Includes 'build.py' in the zip to ensure the tool remains available in backups.
   $ python3 build.py

2. Production Build (Clean)
   Excludes 'build.py' from the final zip file.
   $ python3 build.py --no-self

3. EGO Submission Build
   Clean package for extensions.gnome.org: strips nonstandard keys from 
   metadata.json, names the package correctly. Relies on .extensionignore 
   for file exclusion.
   $ python3 build.py --ego

4. Help
   View available options.
   $ python3 build.py --help
"""

import json
import os
import zipfile
import shutil
import fnmatch
import argparse
import importlib.util
import subprocess
import sys

# --- CONFIGURATION ---
# Output directory relative to the current working directory
TARGET_DIR = os.path.abspath("tmp")

# Keys extensions.gnome.org recognizes in metadata.json
EGO_METADATA_KEYS = [
    "uuid", "name", "description", "shell-version", "url",
    "version", "version-name", "settings-schema", "gettext-domain",
    "session-modes", "donations",
    # Not part of EGO's own schema, but app/page/about.js reads both directly:
    # stripping them blanks the developer label and removes the entire
    # Documentation group from the About page in the submitted build.
    # EGO ignores keys it does not recognise.
    "developer-name", "links",
]
# ---------------------

def load_po_manager(root_dir):
    """
    Load po/manage.py as a module from `root_dir`.

    po/ is not a Python package, so it is loaded by path. This keeps
    po/manage.py the single implementation of the translation pipeline —
    this script never compiles catalogs itself.

    Returns the module, or None when po/manage.py is not present (an installed
    copy of the extension has no po/ directory).
    """
    manage_py = os.path.join(root_dir, "po", "manage.py")
    if not os.path.isfile(manage_py):
        return None
    spec = importlib.util.spec_from_file_location("hornbill_po_manage", manage_py)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def compile_locales(root_dir, required=False):
    """
    Refresh locale/<lang>/LC_MESSAGES/*.mo via po/manage.py.

    `required` is passed through as strict=, so a release build demands real
    msgfmt rather than accepting the built-in fallback writer. The fallback
    exists for end-user installs; it does not run msgfmt --check, so it cannot
    catch a malformed format string or plural form, and a published release
    should not be the first place such a mistake shows up.
    """
    manage = load_po_manager(root_dir)
    if manage is None:
        return False

    try:
        written = manage.compile_catalogs(root_dir, verbose=True, strict=required)
    except manage.MissingToolError as e:
        message = f"Locale compilation skipped: {e}"
        if required:
            sys.exit(f"Error: {message}")
        print(f"   Warning: {message}")
        print("   Using the .mo files already in locale/.")
        return False
    except subprocess.CalledProcessError as e:
        message = f"msgfmt failed with status {e.returncode}"
        if required:
            sys.exit(f"Error: {message}")
        print(f"   Warning: {message}")
        return False

    return bool(written)


def compile_schemas(root_dir, required=False):
    """
    Compile schemas/*.gschema.xml into schemas/gschemas.compiled.

    EGO installs the package as-is, so the compiled schema has to be current
    in the zip; an out-of-date one produces a "Preferences Error" for users.
    """
    schemas_dir = os.path.join(root_dir, "schemas")
    if not os.path.isdir(schemas_dir):
        return False
    if shutil.which("glib-compile-schemas") is None:
        message = "glib-compile-schemas not found (install glib2-devel / libglib2.0-dev)"
        if required:
            sys.exit(f"Error: {message}")
        print(f"   Warning: {message}")
        print("   Using schemas/gschemas.compiled as it stands.")
        return False

    subprocess.run(["glib-compile-schemas", schemas_dir], check=True)
    print(f"   Compiled schemas in {schemas_dir}")
    return True


def parse_arguments():
    """Defines and parses command line arguments."""
    parser = argparse.ArgumentParser(
        description="Package a GNOME Shell extension into a deployable zip file.",
        epilog="Example: python3 build.py --no-self",
        formatter_class=argparse.RawDescriptionHelpFormatter
    )

    parser.add_argument(
        "--no-self", 
        action="store_false", 
        dest="include_self",
        help="Do NOT include this build.py script in the final zip file."
    )

    parser.add_argument(
        "--strict",
        action="store_true",
        help=(
            "Fail instead of warning when glib-compile-schemas or msgfmt is "
            "missing. Use in CI: the default warn-and-continue would publish a "
            "release with a stale or absent gschemas.compiled."
        )
    )

    parser.add_argument(
        "--ego",
        action="store_true",
        help=(
            "Build a submission package for extensions.gnome.org: strips nonstandard "
            "keys from metadata.json inside the zip, and names the file "
            "<uuid>.shell-extension.zip (the `gnome-extensions pack` "
            "convention). Implies --no-self."
        ),
    )

    parser.add_argument(
        "--no-compile",
        action="store_false",
        dest="compile_assets",
        help="Do NOT recompile translation catalogs and GSettings schemas before packaging.",
    )

    # Default is True (include self)
    parser.set_defaults(include_self=True, compile_assets=True)

    return parser.parse_args()

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

def main():
    args = parse_arguments()
    ignore_patterns = load_ignore_patterns(os.getcwd())

    # 1. Read metadata.json
    meta_file = "metadata.json"
    if not os.path.exists(meta_file):
        print(f"Error: {meta_file} not found in {os.getcwd()}")
        sys.exit(1)

    try:
        with open(meta_file, 'r', encoding='utf-8') as f:
            data = json.load(f)
            uuid = data.get("uuid")
            # Prioritize version-name, fallback to integer version
            version = data.get("version-name", str(data.get("version", "0")))
            
            if not uuid:
                print("Error: 'uuid' missing in metadata.json")
                sys.exit(1)
    except json.JSONDecodeError:
        print(f"Error: Failed to parse {meta_file}. Check the JSON syntax.")
        sys.exit(1)

    # 2. Compile bundled assets so the package never ships a stale catalog or
    #    a schema that no longer matches schemas/*.gschema.xml.
    if args.compile_assets:
        print("Compiling translation catalogs...")
        compile_locales(os.getcwd(), required=args.ego or args.strict)
        print("Compiling GSettings schemas...")
        compile_schemas(os.getcwd(), required=args.ego or args.strict)

    # 3. Define Filename
    if args.ego:
        zip_filename = f"{uuid}.shell-extension.zip"
        print(f"Packaging (EGO submission): {zip_filename}")
    else:
        zip_filename = f"{uuid}_v{version}.zip"
        print(f"Packaging: {zip_filename}")

    # 4. Create Zip File
    try:
        with zipfile.ZipFile(zip_filename, 'w', zipfile.ZIP_DEFLATED) as zipf:
            for root, dirs, files in os.walk("."):
                for file in files:
                    file_path = os.path.join(root, file)
                    abs_file_path = os.path.abspath(file_path)
                    archive_name = os.path.relpath(file_path, ".")

                    # --- EXCLUSION LOGIC ---
                    
                    # Prevent recursive zipping of the output directory or the zip file itself
                    if abs_file_path.startswith(TARGET_DIR):
                        continue
                    if file == zip_filename:
                        continue

                    if should_exclude(archive_name, ignore_patterns):
                        continue

                    # EGO mode: sanitize metadata
                    if args.ego:
                        if archive_name == "metadata.json":
                            clean = {k: data[k] for k in EGO_METADATA_KEYS if k in data}
                            dropped = sorted(set(data) - set(clean))
                            if dropped:
                                print(f"   [EGO metadata] stripped keys: {', '.join(dropped)}")
                            zipf.writestr(archive_name, json.dumps(clean, indent=2) + "\n")
                            continue

                    # Check build.py specifically
                    if file == os.path.basename(__file__) and not (args.include_self and not args.ego):
                        print(f"   [Excluded] Builder script ({file})")
                        continue
                    
                    # -----------------------

                    zipf.write(file_path, arcname=archive_name)
                    
        print("Zip created successfully.")

    except Exception as e:
        print(f"Error creating zip: {e}")
        sys.exit(1)

    # 5. Move to Target Directory
    try:
        if not os.path.exists(TARGET_DIR):
            os.makedirs(TARGET_DIR)
            print(f"   Created directory: {TARGET_DIR}")

        destination = os.path.join(TARGET_DIR, zip_filename)
        # Handle case where file might already exist in tmp/
        if os.path.exists(destination):
            os.remove(destination)
            
        shutil.move(zip_filename, destination)
        
        print("-" * 40)
        print("Build Complete.")
        print(f"File moved to: {destination}")
        print("-" * 40)

    except Exception as e:
        print(f"Error moving file: {e}")

if __name__ == "__main__":
    main()
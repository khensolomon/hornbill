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
   Includes 'build.py' in the zip so you have the tool available in backups.
   $ python3 build.py

2. Production Build (Clean)
   Excludes 'build.py' from the final zip file.
   $ python3 build.py --no-self

3. EGO Submission Build
   Clean package for extensions.gnome.org: no dev tooling, sanitized
   metadata.json, gnome-extensions pack naming.
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
import sys

# --- CONFIGURATION ---
TARGET_DIR = os.path.expanduser("~/dev/backup")

# Keys extensions.gnome.org recognizes in metadata.json; everything else is
# stripped from the packaged metadata in --ego mode (review hygiene). The
# runtime tolerates the missing keys: AppConfig falls back to debug=false
# and the About page guards missing links.
EGO_METADATA_KEYS = [
    "uuid", "name", "description", "shell-version", "url",
    "version", "version-name", "settings-schema", "gettext-domain",
    "session-modes", "donations",
]

# Development-only content that must not reach an EGO submission package
EGO_EXCLUDE = [
    "build.py", "install.py", "dev.sh", "reload.sh", "restart.sh",
    "app.js",            # standalone gjs runner for UI mockups
    "ui/*", "notes*", "tmp*", "Todo.md",
    "desire-*", "prompt*",
    # Experimental pages not wired into the registry: reviewers read every
    # file, and dead code invites questions.
    "app/page/demo.js", "app/page/dock.js", "app/page/mimic.js",
    "app/page/appbutton.js", "app/page/setting.js",
]

# Global exclude patterns (always ignored)
ALWAYS_EXCLUDE = [
    "*.git*", 
    "*.vscode*", 
    ".idea/*", 
    "__pycache__*",
    "tmp",
    "*.zip", 
    "schemas/gschemas.compiled"
]
# ---------------------

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
        "--ego",
        action="store_true",
        help=(
            "Build a submission package for extensions.gnome.org: excludes "
            "all development tooling, strips nonstandard keys from "
            "metadata.json inside the zip, and names the file "
            "<uuid>.shell-extension.zip (the `gnome-extensions pack` "
            "convention). Implies --no-self."
        ),
    )

    # Default is True (include self)
    parser.set_defaults(include_self=True)

    return parser.parse_args()

def main():
    args = parse_arguments()

    # 1. Read metadata.json
    meta_file = "metadata.json"
    if not os.path.exists(meta_file):
        print(f"Error: {meta_file} not found in {os.getcwd()}")
        sys.exit(1)

    try:
        with open(meta_file, 'r') as f:
            data = json.load(f)
            uuid = data.get("uuid")
            # Prioritize version-name, fallback to integer version
            version = data.get("version-name", str(data.get("version", "0")))
            
            if not uuid:
                print("Error: 'uuid' missing in metadata.json")
                sys.exit(1)
    except json.JSONDecodeError:
        print(f"Error: Failed to parse {meta_file}. Check your JSON syntax.")
        sys.exit(1)

    # 2. Define Filename
    if args.ego:
        zip_filename = f"{uuid}.shell-extension.zip"
        print(f"Packaging (EGO submission): {zip_filename}")
    else:
        zip_filename = f"{uuid}_v{version}.zip"
        print(f"Packaging: {zip_filename}")

    # 3. Create Zip File
    try:
        with zipfile.ZipFile(zip_filename, 'w', zipfile.ZIP_DEFLATED) as zipf:
            for root, dirs, files in os.walk("."):
                for file in files:
                    file_path = os.path.join(root, file)
                    archive_name = os.path.relpath(file_path, ".")

                    # --- EXCLUSION LOGIC ---
                    
                    # 1. Check global patterns
                    if should_exclude(archive_name, ALWAYS_EXCLUDE):
                        continue

                    # 2. EGO mode: exclude dev tooling, sanitize metadata
                    if args.ego:
                        if should_exclude(archive_name, EGO_EXCLUDE):
                            print(f"   [EGO excluded] {archive_name}")
                            continue
                        if archive_name == "metadata.json":
                            clean = {k: data[k] for k in EGO_METADATA_KEYS if k in data}
                            dropped = sorted(set(data) - set(clean))
                            if dropped:
                                print(f"   [EGO metadata] stripped keys: {', '.join(dropped)}")
                            zipf.writestr(archive_name, json.dumps(clean, indent=2) + "\n")
                            continue

                    # 3. Check build.py specifically
                    if file == os.path.basename(__file__) and not (args.include_self and not args.ego):
                        print(f"   [Excluded] Builder script ({file})")
                        continue
                    
                    # -----------------------

                    zipf.write(file_path, arcname=archive_name)
                    
        print("Zip created successfully.")

    except Exception as e:
        print(f"Error creating zip: {e}")
        sys.exit(1)

    # 4. Move to Target Directory
    try:
        if not os.path.exists(TARGET_DIR):
            os.makedirs(TARGET_DIR)
            print(f"   Created directory: {TARGET_DIR}")

        destination = os.path.join(TARGET_DIR, zip_filename)
        shutil.move(zip_filename, destination)
        
        print("-" * 40)
        print("Build Complete.")
        print(f"File moved to: {destination}")
        print("-" * 40)

    except Exception as e:
        print(f"Error moving file: {e}")

def should_exclude(filename, patterns):
    """Checks if a filename matches any exclude pattern."""
    for pattern in patterns:
        if fnmatch.fnmatch(filename, pattern):
            return True
        if fnmatch.fnmatch(os.path.dirname(filename), pattern):
            return True
    return False

if __name__ == "__main__":
    main()
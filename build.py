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
import sys

# --- CONFIGURATION ---
# Output directory relative to the current working directory
TARGET_DIR = os.path.abspath("tmp")

# Keys extensions.gnome.org recognizes in metadata.json
EGO_METADATA_KEYS = [
    "uuid", "name", "description", "shell-version", "url",
    "version", "version-name", "settings-schema", "gettext-domain",
    "session-modes", "donations",
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
            "Build a submission package for extensions.gnome.org: strips nonstandard "
            "keys from metadata.json inside the zip, and names the file "
            "<uuid>.shell-extension.zip (the `gnome-extensions pack` "
            "convention). Implies --no-self."
        ),
    )

    # Default is True (include self)
    parser.set_defaults(include_self=True)

    return parser.parse_args()

def load_ignore_patterns():
    """Parses patterns from .gitignore and .extensionignore files."""
    patterns = []
    for ignore_file in [".gitignore", ".extensionignore"]:
        if os.path.exists(ignore_file):
            with open(ignore_file, 'r', encoding='utf-8') as f:
                for line in f:
                    line = line.strip()
                    if line and not line.startswith('#'):
                        patterns.append(line)
    return patterns

def should_exclude(filename, patterns):
    """Checks if a filename matches any loaded ignore pattern."""
    # Normalize path to use forward slashes for cross-OS compatibility
    normalized = filename.replace(os.sep, '/')
    parts = normalized.split('/')
    
    for pattern in patterns:
        pattern = pattern.strip()
        if not pattern: 
            continue
        
        clean_pattern = pattern.rstrip('/')
        
        # 1. Full path match (handles patterns like "tests/*" or exact paths)
        if fnmatch.fnmatch(normalized, pattern) or fnmatch.fnmatch(normalized, clean_pattern):
            return True
            
        # 2. File basename match (handles extensions like "*.zip")
        if fnmatch.fnmatch(parts[-1], clean_pattern):
            return True
            
        # 3. Parent directory match (handles nested files inside ignored folders)
        for i in range(len(parts) - 1): 
            # Check individual directory name (e.g., 'ui' in 'src/ui/file.js')
            if fnmatch.fnmatch(parts[i], clean_pattern):
                return True
            
            # Check cumulative path (e.g., 'src/ui' in 'src/ui/file.js')
            dir_to_check = '/'.join(parts[:i+1])
            if fnmatch.fnmatch(dir_to_check, clean_pattern):
                return True
                
    return False

def main():
    args = parse_arguments()
    ignore_patterns = load_ignore_patterns()

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

    # 4. Move to Target Directory
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
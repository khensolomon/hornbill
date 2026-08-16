#!/usr/bin/env python3
"""
Lesion Translation Management Tool

This script manages translations for the Lesion package.
It requires standard gettext tools (xgettext, msgfmt, msgmerge, msginit) to be installed.

Commands:
  add <lang>  : Start a translation for a new language (e.g., de, fr, pt_BR).
                Creates po/<lang>.po from the current template, then you can
                edit its msgstr entries and run the 'compile' command.
                
  compile     : Compile every po/*.po into locale/<lang>/LC_MESSAGES/lesion.mo.
                Run this after adding or modifying translations.

  update      : Regenerate po/lesion.pot from source files listed in po/POTFILES.in,
                then automatically merge the changes into every existing po/*.po file.

Usage Examples:
  ./po/manage.py add pt_BR
  ./po/manage.py compile
  ./po/manage.py update
"""

import argparse
import subprocess
import sys
from pathlib import Path

# Constants based on bash configurations
DOMAIN = "lesion"

def get_root_dir():
    """Returns the repository root directory by stepping up one level from the script."""
    return Path(__file__).resolve().parent.parent

def run_add(args):
    root_dir = get_root_dir()
    lang = args.lang
    po_file = root_dir / f"po/{lang}.po"
    pot_file = root_dir / f"po/{DOMAIN}.pot"

    if po_file.exists():
        print(f"{po_file} already exists — nothing to do.", file=sys.stderr)
        sys.exit(1)

    # Initialize the new language file without a predefined translator
    cmd = [
        "msginit", 
        "--no-translator", 
        f"--locale={lang}", 
        f"--input={pot_file}", 
        f"--output-file={po_file}"
    ]
    subprocess.run(cmd, check=True, cwd=root_dir)
    print(f"Created {po_file.relative_to(root_dir)} — translate its msgstr entries, then run compile")

def run_compile(args):
    root_dir = get_root_dir()
    po_dir = root_dir / "po"
    found = False

    # Compile every .po file found in the po/ directory
    for po in po_dir.glob("*.po"):
        found = True
        lang = po.stem
        dest = root_dir / f"locale/{lang}/LC_MESSAGES"
        dest.mkdir(parents=True, exist_ok=True)
        
        mo_file = dest / f"{DOMAIN}.mo"
        
        # Check and compile into the locale directory
        cmd = ["msgfmt", "--check", f"--output-file={mo_file}", str(po)]
        subprocess.run(cmd, check=True, cwd=root_dir)
        print(f"Compiled {po.relative_to(root_dir)} -> {mo_file.relative_to(root_dir)}")

    if not found:
        print("No po/*.po files found. Add one with the 'add' command.")

def run_update(args):
    root_dir = get_root_dir()
    pot_file = root_dir / f"po/{DOMAIN}.pot"
    potfiles_in = root_dir / "po/POTFILES.in"

    # Read files to scan, ignoring comments and blank lines
    files_to_scan = []
    if potfiles_in.exists():
        with open(potfiles_in, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#"):
                    files_to_scan.append(line)

    # Regenerate the template from source code using specific keyword markers
    xgettext_cmd = [
        "xgettext",
        "--from-code=UTF-8",
        "--language=JavaScript",
        "--keyword=_",
        "--keyword=gettext",
        "--keyword=N_",
        "--keyword=ngettext:1,2",
        "--keyword=pgettext:1c,2",
        "--add-comments=Translators",
        "--sort-by-file",
        "--package-name=Lesion",
        "--copyright-holder=Khen Solomon Lethil",
        "--msgid-bugs-address=https://github.com/khensolomon/lesion/issues",
        "-o", str(pot_file)
    ] + files_to_scan

    subprocess.run(xgettext_cmd, check=True, cwd=root_dir)
    print(f"Wrote {pot_file.relative_to(root_dir)}")

    # Keep existing translations in sync with the newly generated template
    for po in (root_dir / "po").glob("*.po"):
        merge_cmd = [
            "msgmerge", 
            "--update", 
            "--backup=none", 
            "--quiet", 
            str(po), 
            str(pot_file)
        ]
        subprocess.run(merge_cmd, check=True, cwd=root_dir)
        print(f"Merged {po.relative_to(root_dir)}")

def main():
    # Pass the module docstring as the description and use RawDescriptionHelpFormatter
    # so that the formatting remains exactly as typed above.
    parser = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter
    )
    
    subparsers = parser.add_subparsers(dest="command", required=True)

    # Subparser for 'add' command
    add_parser = subparsers.add_parser("add", help="Start a translation for a new language")
    add_parser.add_argument("lang", help="Language code (e.g., de, fr, pt_BR)")
    add_parser.set_defaults(func=run_add)

    # Subparser for 'compile' command
    compile_parser = subparsers.add_parser("compile", help="Compile .po files into .mo files")
    compile_parser.set_defaults(func=run_compile)

    # Subparser for 'update' command
    update_parser = subparsers.add_parser("update", help="Regenerate template and merge with .po files")
    update_parser.set_defaults(func=run_update)

    args = parser.parse_args()
    args.func(args)

if __name__ == "__main__":
    main()
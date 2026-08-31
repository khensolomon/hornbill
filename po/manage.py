#!/usr/bin/env python3
"""
Hornbill Translation Management Tool

This is the single implementation of the translation pipeline. It works two
ways:

  * As a command line tool:   ./po/manage.py compile
  * As an importable module:  compile_catalogs(root) from build.py / install.py

build.py and install.py do not carry their own copy of the compile logic; they
load this file and call compile_catalogs(). Changing how catalogs are built
therefore means changing this file and nothing else.

Requires the standard gettext tools (xgettext, msgfmt, msgmerge, msginit).

Commands:
  add <lang>  : Start a translation for a new language (e.g. de, fr, pt_BR).
                Creates po/<lang>.po from the current template, then you can
                edit its msgstr entries and run the 'compile' command.

  compile     : Compile every po/*.po into locale/<lang>/LC_MESSAGES/hornbill.mo.
                Run this after adding or modifying translations.

  update      : Regenerate po/hornbill.pot from source files listed in
                po/POTFILES.in, then merge the changes into every existing
                po/*.po file.

Usage Examples:
  ./po/manage.py add pt_BR
  ./po/manage.py compile
  ./po/manage.py update
"""

import argparse
import shutil
import subprocess
import sys
from pathlib import Path

DOMAIN = "hornbill"

# Tools each command needs, so a missing dependency is reported by name rather
# than surfacing as a bare FileNotFoundError from subprocess.
TOOLS = {
    "add": ["msginit"],
    "compile": ["msgfmt"],
    "update": ["xgettext", "msgmerge"],
}


class MissingToolError(RuntimeError):
    """Raised when a required gettext binary is not on PATH."""


def get_root_dir():
    """Repository root: one level up from this script."""
    return Path(__file__).resolve().parent.parent


def require_tools(command):
    """Raise MissingToolError naming every gettext binary that is absent."""
    missing = [t for t in TOOLS[command] if shutil.which(t) is None]
    if missing:
        raise MissingToolError(
            f"missing gettext tool(s): {', '.join(missing)} "
            "(install the 'gettext' package)"
        )


# --- Importable API -------------------------------------------------------

def compile_catalogs(root_dir=None, domain=DOMAIN, verbose=True):
    """
    Compile every po/*.po into locale/<lang>/LC_MESSAGES/<domain>.mo.

    This is the ONLY place .mo files are produced. build.py and install.py both
    call it instead of shelling out to msgfmt themselves.

    Returns the list of .mo Paths written (empty when there are no catalogs).
    Raises MissingToolError when msgfmt is not installed.
    """
    require_tools("compile")
    root_dir = Path(root_dir) if root_dir else get_root_dir()
    written = []

    for po in sorted((root_dir / "po").glob("*.po")):
        dest = root_dir / "locale" / po.stem / "LC_MESSAGES"
        dest.mkdir(parents=True, exist_ok=True)
        mo_file = dest / f"{domain}.mo"

        subprocess.run(
            ["msgfmt", "--check", f"--output-file={mo_file}", str(po)],
            check=True,
            cwd=root_dir,
        )
        written.append(mo_file)
        if verbose:
            print(f"Compiled {po.relative_to(root_dir)} -> {mo_file.relative_to(root_dir)}")

    if not written and verbose:
        print("No po/*.po files found. Add one with the 'add' command.")
    return written


def update_template(root_dir=None, domain=DOMAIN, verbose=True):
    """
    Regenerate po/<domain>.pot from POTFILES.in, then merge into every po/*.po.

    Returns the Path of the written template.
    """
    require_tools("update")
    root_dir = Path(root_dir) if root_dir else get_root_dir()
    pot_file = root_dir / "po" / f"{domain}.pot"
    potfiles_in = root_dir / "po" / "POTFILES.in"

    files_to_scan = []
    if potfiles_in.exists():
        for line in potfiles_in.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#"):
                files_to_scan.append(line)

    # xgettext reports a missing source as a generic error part-way through;
    # naming them up front makes a stale POTFILES.in obvious.
    missing = [f for f in files_to_scan if not (root_dir / f).exists()]
    if missing:
        raise FileNotFoundError(
            "po/POTFILES.in lists files that do not exist: " + ", ".join(missing)
        )

    subprocess.run(
        [
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
            "--package-name=Hornbill",
            "--copyright-holder=Khen Solomon Lethil",
            "--msgid-bugs-address=https://github.com/khensolomon/hornbill/issues",
            "-o",
            str(pot_file),
        ]
        + files_to_scan,
        check=True,
        cwd=root_dir,
    )
    if verbose:
        print(f"Wrote {pot_file.relative_to(root_dir)}")

    for po in sorted((root_dir / "po").glob("*.po")):
        subprocess.run(
            ["msgmerge", "--update", "--backup=none", "--quiet", str(po), str(pot_file)],
            check=True,
            cwd=root_dir,
        )
        if verbose:
            print(f"Merged {po.relative_to(root_dir)}")

    return pot_file


def add_language(lang, root_dir=None, domain=DOMAIN, verbose=True):
    """Create po/<lang>.po from the current template. Returns its Path."""
    require_tools("add")
    root_dir = Path(root_dir) if root_dir else get_root_dir()
    po_file = root_dir / "po" / f"{lang}.po"
    pot_file = root_dir / "po" / f"{domain}.pot"

    if po_file.exists():
        raise FileExistsError(f"{po_file.relative_to(root_dir)} already exists")
    if not pot_file.exists():
        raise FileNotFoundError(
            f"{pot_file.relative_to(root_dir)} is missing — run 'update' first"
        )

    subprocess.run(
        [
            "msginit",
            "--no-translator",
            f"--locale={lang}",
            f"--input={pot_file}",
            f"--output-file={po_file}",
        ],
        check=True,
        cwd=root_dir,
    )
    if verbose:
        print(
            f"Created {po_file.relative_to(root_dir)} — "
            "translate its msgstr entries, then run compile"
        )
    return po_file


# --- CLI ------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    add_parser = subparsers.add_parser("add", help="Start a translation for a new language")
    add_parser.add_argument("lang", help="Language code (e.g. de, fr, pt_BR)")
    add_parser.set_defaults(func=lambda a: add_language(a.lang))

    compile_parser = subparsers.add_parser("compile", help="Compile .po files into .mo files")
    compile_parser.set_defaults(func=lambda a: compile_catalogs())

    update_parser = subparsers.add_parser("update", help="Regenerate template and merge with .po files")
    update_parser.set_defaults(func=lambda a: update_template())

    args = parser.parse_args()
    try:
        args.func(args)
    except (MissingToolError, FileExistsError, FileNotFoundError) as e:
        sys.exit(f"Error: {e}")
    except subprocess.CalledProcessError as e:
        sys.exit(f"Error: {e.cmd[0]} exited with status {e.returncode}")


if __name__ == "__main__":
    main()

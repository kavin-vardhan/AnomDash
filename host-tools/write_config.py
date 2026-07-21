#!/usr/bin/env python3
"""
write_config.py - create or update the dashboard's runtime config.json.

The dashboard reads ./config.json at startup for its control token, captures folder and server URL.
Setup.bat calls this to stamp the operator's captures folder into that file WITHOUT disturbing the
controlToken the owner shipped in the delivery bundle (the token is the one value Setup must never
invent or clobber).

Writing JSON from a .bat is a quoting minefield, and Python is already located by Setup before this
runs, so the file is edited here instead.

Usage:
  python write_config.py --file "<dashboard>/config.json" --captures-root "D:/AnomalyCaptures"
  python write_config.py --file "<...>/config.json" --captures-root "..." --token "..." --server-url "..."
"""

import argparse
import json
import os
import sys

DEFAULT_SERVER_URL = "ws://127.0.0.1:8077"


def _rescue(path, reason):
    """Preserve an unreadable config next to itself before it is replaced.

    An unparseable file still has to be rewritten (capturesRoot must land somewhere), but the
    controlToken inside it cannot be recovered automatically - so the original is kept as a .bak and
    the caller warns loudly rather than losing the owner's token silently.
    """
    backup = path + ".bak"
    try:
        os.replace(path, backup)
        kept = backup
    except OSError:
        kept = None
    print("  WARNING: existing config.json could not be read (%s)." % reason)
    if kept:
        print("           The old file was kept as: %s" % kept)
    print("           controlToken could NOT be preserved - check it before delivering/using this bundle.")
    return {}


def load_existing(path):
    """Return the existing config dict, or {} if it is missing/unreadable/not an object.

    Read with utf-8-sig so a byte-order mark (Notepad, PowerShell Set-Content -Encoding utf8, and other
    Windows editors write one) is tolerated rather than treated as corruption - a BOM here used to make
    the file unparseable and cost the shipped controlToken.
    """
    if not os.path.isfile(path):
        return {}
    try:
        with open(path, "r", encoding="utf-8-sig") as fh:
            data = json.load(fh)
    except (OSError, ValueError) as exc:
        return _rescue(path, exc)
    if not isinstance(data, dict):
        return _rescue(path, "it was not a JSON object")
    return data


def main():
    ap = argparse.ArgumentParser(description="Create or update the dashboard's config.json.")
    ap.add_argument("--file", required=True, help="path to config.json")
    ap.add_argument("--captures-root", required=True, help="folder captures are written to")
    ap.add_argument("--token", default=None, help="control token (default: keep the existing one)")
    ap.add_argument("--server-url", default=None, help="control server URL (default: keep or %s)" % DEFAULT_SERVER_URL)
    args = ap.parse_args()

    cfg = load_existing(args.file)

    cfg["capturesRoot"] = args.captures_root.replace("\\", "/")
    if args.token is not None:
        cfg["controlToken"] = args.token
    cfg.setdefault("controlToken", "")
    if args.server_url is not None:
        cfg["serverUrl"] = args.server_url
    cfg.setdefault("serverUrl", DEFAULT_SERVER_URL)

    parent = os.path.dirname(os.path.abspath(args.file))
    if parent and not os.path.isdir(parent):
        print("  ERROR: folder does not exist: %s" % parent)
        return 1

    try:
        with open(args.file, "w", encoding="utf-8") as fh:
            json.dump(cfg, fh, indent=2)
            fh.write("\n")
    except OSError as exc:
        print("  ERROR: could not write %s - %s" % (args.file, exc))
        return 1

    print("  config.json updated: %s" % args.file)
    print("    capturesRoot = %s" % cfg["capturesRoot"])
    if cfg["controlToken"]:
        print("    controlToken = (present, unchanged)")
    else:
        print("    controlToken = (EMPTY - the dashboard will ask for a token on its connect screen)")
    return 0


if __name__ == "__main__":
    sys.exit(main())

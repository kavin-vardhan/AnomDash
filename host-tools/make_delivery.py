#!/usr/bin/env python3
"""
make_delivery.py - assemble a complete client bundle from bundle_manifest.txt.

Run it through make_delivery.bat. It is a DEV TOOL and never ships: it is not in the
manifest, so it cannot copy itself into the bundle.

Why an allowlist manifest rather than copy-except: a blocklist silently ships whatever is
added next. The manifest is the SOURCE OF TRUTH - a client-facing file that is not listed
does not ship, deliberately and visibly.

The failure this is really guarding against is NOT a missing file. It is a bundle where
every file copies perfectly and dist/ is weeks old, shipping an outdated dashboard with no
error anywhere. Automating the copy makes that MORE likely, because copying stops being the
step anyone is thinking about. So: dist/ absent is a refusal, dist/ older than src/ is a
loud warning needing explicit confirmation, and dist/'s build time is printed every run
whether or not anything is wrong.

It does not run npm run build. A packaging script that builds is one that can fail halfway
and leave a half-built dist.

CROSS-REPO FILES ARE OPT-IN. PLUGINFILE entries come from the AnomalyInjector repo, which is
NOT present on every machine that packages a bundle - deriving its path from this repo's
location assumed the two trees sit side by side, and on the packaging machine they do not.
So: with no --plugin-repo, those entries are SKIPPED, the bundle is built from this repo
alone, the run exits 0, and a closing notice names exactly which files are missing and where
they go. With --plugin-repo, they are resolved and a missing one FAILS LOUDLY - an explicit
request that cannot be satisfied is still an error.

Everything sourced from THIS repo keeps the original fail-loudly behaviour. Only the
cross-repo class became optional.
"""

import argparse
import os
import shutil
import sys
from datetime import datetime

REPO = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
MANIFEST = os.path.join(os.path.dirname(os.path.abspath(__file__)), "bundle_manifest.txt")


def read_manifest(path):
    entries = []
    with open(path, "r", encoding="utf-8") as fh:
        for lineno, raw in enumerate(fh, 1):
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            parts = line.split()
            if len(parts) != 3 or parts[0] not in ("DIR", "FILE", "PLUGINFILE"):
                print("ERROR: manifest line %d is malformed: %s" % (lineno, line))
                return None
            entries.append((parts[0], parts[1], parts[2]))
    return entries


def newest_mtime(root):
    newest = 0.0
    newest_path = None
    for base, _dirs, files in os.walk(root):
        for name in files:
            p = os.path.join(base, name)
            try:
                m = os.path.getmtime(p)
            except OSError:
                continue
            if m > newest:
                newest = m
                newest_path = p
    return newest, newest_path


def stamp(ts):
    return datetime.fromtimestamp(ts).strftime("%Y-%m-%d %H:%M:%S") if ts else "(none)"


def check_dist(assume_yes):
    dist = os.path.join(REPO, "dist")
    src = os.path.join(REPO, "src")

    if not os.path.isdir(dist) or not os.path.isfile(os.path.join(dist, "index.html")):
        print("REFUSING TO RUN: no built dashboard at %s" % dist)
        print("  The bundle would ship without a dashboard. Build it first:")
        print("      npm run build")
        return False

    dist_m, _dp = newest_mtime(dist)
    print("  dist/ built : %s" % stamp(dist_m))

    if os.path.isdir(src):
        src_m, src_p = newest_mtime(src)
        print("  src/ newest : %s" % stamp(src_m))
        if src_m > dist_m:
            print("")
            print("  *** WARNING: SOURCE IS NEWER THAN THE BUILD ***")
            print("  %s" % (src_p or "(a source file)"))
            print("  changed AFTER dist/ was built. The bundle would ship an OUTDATED dashboard,")
            print("  and nothing downstream would report it. Run 'npm run build' first.")
            if assume_yes:
                print("  --yes given: continuing anyway.")
            else:
                ans = input("  Continue with the STALE build anyway? (type YES to continue): ")
                if ans.strip() != "YES":
                    print("  Stopped. Nothing was copied.")
                    return False
    return True


def main():
    ap = argparse.ArgumentParser(description="Assemble a client delivery bundle.")
    ap.add_argument("--dest", required=True, help="destination folder for the bundle")
    ap.add_argument("--yes", action="store_true", help="skip the stale-build confirmation")
    ap.add_argument("--plugin-repo", default=None,
                    help="OPTIONAL. AnomalyInjector repo root, source of PLUGINFILE entries. "
                         "Omit it on a machine that has only the dashboard repo: the bundle is "
                         "built from this repo alone and the cross-repo files are listed as not "
                         "included. Give it and every PLUGINFILE must resolve or the run fails.")
    args = ap.parse_args()

    dest = os.path.abspath(args.dest)
    plugin_repo = os.path.abspath(args.plugin_repo) if args.plugin_repo else None
    print("=" * 62)
    print("  Anomaly delivery bundle")
    print("=" * 62)
    print("  repo   : %s" % REPO)
    if plugin_repo:
        print("  plugin : %s  (--plugin-repo given; cross-repo files WILL be included)" % plugin_repo)
    else:
        print("  plugin : (not given - cross-repo files will NOT be included; see the notice at the end)")
    print("  dest   : %s" % dest)
    print("")

    entries = read_manifest(MANIFEST)
    if entries is None:
        return 1

    if plugin_repo and not os.path.isdir(plugin_repo):
        print("FAILED: --plugin-repo was given but that directory does not exist.")
        print("  %s" % plugin_repo)
        print("")
        print("  Passing --plugin-repo is an explicit request to include the cross-repo files,")
        print("  so a path that is not there is an error, not something to work around. Either")
        print("  correct the path, or omit --plugin-repo entirely to build a dashboard-only")
        print("  bundle and add those files by hand.")
        return 2

    omitted = [e for e in entries if e[0] == "PLUGINFILE"] if not plugin_repo else []
    included = [e for e in entries if e[0] != "PLUGINFILE"] if not plugin_repo else entries

    if os.path.exists(dest) and os.listdir(dest):
        print("STOPPING: destination is not empty.")
        print("  %s" % dest)
        print("  A bundle merged into an existing one can carry a stale file from a previous")
        print("  delivery, which is the same failure this script exists to prevent.")
        print("  Empty it or choose a new folder.")
        return 1

    if not check_dist(args.yes):
        return 1

    print("")
    if omitted:
        print("  copying %d of %d manifest entries (%d cross-repo entries skipped - no --plugin-repo)..."
              % (len(included), len(entries), len(omitted)))
    else:
        print("  copying %d manifest entries..." % len(included))
    os.makedirs(dest, exist_ok=True)
    missing_sources = []
    for kind, rel_src, rel_dst in included:
        base_repo = plugin_repo if kind == "PLUGINFILE" else REPO
        s = os.path.join(base_repo, rel_src.replace("/", os.sep))
        d = os.path.join(dest, rel_dst.replace("/", os.sep))
        if kind == "DIR":
            if not os.path.isdir(s):
                missing_sources.append((kind, rel_src, s))
                continue
            shutil.copytree(s, d, dirs_exist_ok=True)
        else:
            if not os.path.isfile(s):
                missing_sources.append((kind, rel_src, s))
                continue
            os.makedirs(os.path.dirname(d), exist_ok=True)
            shutil.copy2(s, d)
            if kind == "PLUGINFILE":
                print("    cross-repo: %s <- %s" % (rel_dst, s))

    if missing_sources:
        print("")
        print("FAILED: these manifest entries do not exist. NO BUNDLE WAS PRODUCED.")
        for kind, rel_src, looked_in in missing_sources:
            print("    MISSING  %-11s %s" % (kind, rel_src))
            print("             looked in: %s" % looked_in)
        if any(k == "PLUGINFILE" for k, _r, _l in missing_sources):
            print("")
            print("  A PLUGINFILE entry comes from the AnomalyInjector repo, NOT this one.")
            print("  Point --plugin-repo at it, or check the file still exists there.")
        print("")
        print("  The bundle would be INCOMPLETE and must not be delivered. This script will")
        print("  not invent a missing file and will not report success without one.")
        shutil.rmtree(dest, ignore_errors=True)
        return 2

    print("")
    print("  verifying every INCLUDED manifest entry arrived...")
    ok = True
    for kind, rel_src, rel_dst in included:
        d = os.path.join(dest, rel_dst.replace("/", os.sep))
        present = os.path.isdir(d) if kind == "DIR" else os.path.isfile(d)
        print("    %-11s %-40s %s" % (kind, rel_dst, "present" if present else "*** MISSING ***"))
        if not present:
            ok = False
    if not ok:
        print("")
        print("FAILED: the copy did not produce every entry. Do not deliver this folder.")
        return 3

    total_files = 0
    total_bytes = 0
    for base, _dirs, files in os.walk(dest):
        for name in files:
            total_files += 1
            try:
                total_bytes += os.path.getsize(os.path.join(base, name))
            except OSError:
                pass

    print("")
    print("=" * 62)
    if omitted:
        print("  BUNDLE BUILT - DASHBOARD-ONLY, NOT COMPLETE")
        print("  entries: %d/%d manifest entries present (dashboard-only; %d plugin-side"
              % (len(included), len(entries), len(omitted)))
        print("           file(s) NOT included - see the notice below)")
    else:
        print("  BUNDLE COMPLETE")
        print("  entries: %d/%d manifest entries present (including %d cross-repo file(s))"
              % (len(entries), len(entries),
                 sum(1 for k, _s, _d in entries if k == "PLUGINFILE")))
    print("  files  : %d" % total_files)
    print("  size   : %.1f MB" % (total_bytes / 1048576.0))
    print("  dest   : %s" % dest)
    print("")
    print("  config.json was NOT copied - it carries your token. Setup.bat writes it on")
    print("  the client machine, into dashboard\\ where the app fetches it from.")
    print("=" * 62)

    if omitted:
        print("")
        print("!" * 62)
        print("  ACTION REQUIRED BEFORE YOU DELIVER THIS FOLDER")
        print("!" * 62)
        print("")
        print("  This bundle was built WITHOUT a plugin repo, so these file(s) are NOT in it.")
        print("  You must copy them in by hand before delivering:")
        print("")
        for _kind, rel_src, rel_dst in omitted:
            print("      %-24s ->  %s" % (os.path.basename(rel_src), os.path.join(dest, rel_dst.replace("/", os.sep))))
        print("")
        print("  Take them from the AnomalyInjector plugin repo:")
        for _kind, rel_src, rel_dst in omitted:
            print("      %-24s is at  <AnomalyInjector>/%s" % (os.path.basename(rel_src), rel_src))
        print("")
        print("  Until they are in place the client has no guide and no overlay inspector.")
        print("  Nothing here invented a placeholder for them, and nothing will.")
        print("")
        print("  On a machine that HAS both trees you can avoid this step entirely:")
        print("      make_delivery.py --dest <folder> --plugin-repo <AnomalyInjector repo>")
        print("!" * 62)
    return 0


if __name__ == "__main__":
    sys.exit(main())

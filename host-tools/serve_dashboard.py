#!/usr/bin/env python3
"""
serve_dashboard.py - static file server for the PACKAGED Anomaly Dashboard build.

The client no longer runs Node: the dashboard is built on the BUILD machine (npm run build) and
delivered as plain static files, which this stdlib server hands to the browser. Python is already a
client prerequisite (encode_watcher.py), so this adds no new install.

Why a wrapper rather than `python -m http.server`:
  - MIME types are FORCED here. http.server resolves types through the Windows registry, and a machine
    whose HKCR\\.js carries a "Content Type" of text/plain will serve JavaScript as text/plain - which
    makes the browser refuse the ES module and renders a blank dashboard, on the client's box, with the
    only clue buried in devtools. We cannot inspect the client's registry, so we do not depend on it.
  - Cache-Control: no-store. http.server otherwise serves conditional/cached responses, so a config.json
    rewritten by a re-run of Setup.bat could keep serving the OLD token until a hard refresh.
  - Binds 127.0.0.1 by default (http.server defaults to all interfaces - wrong for a local control tool).
  - A readable message when the port is busy, instead of a traceback.

There is deliberately NO SPA/index.html fallback: the dashboard is a single view with no client-side
router, so a 404 should stay a 404 (that is what tells the app config.json is absent).

Usage:
  python serve_dashboard.py --directory "<dir with index.html + config.json>" [--port 5180] [--bind 127.0.0.1]
"""

import argparse
import errno
import os
import sys
from functools import partial
from http.server import HTTPServer, SimpleHTTPRequestHandler

FORCED_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".map": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".txt": "text/plain; charset=utf-8",
}


class DashboardHandler(SimpleHTTPRequestHandler):
    """SimpleHTTPRequestHandler with forced MIME types and caching disabled.

    guess_type() consults extensions_map BEFORE the mimetypes/registry lookup, so overriding it here
    makes the served content types independent of the host machine's registry.
    """

    extensions_map = dict(SimpleHTTPRequestHandler.extensions_map, **FORCED_TYPES)
    server_version = "AnomalyDashboard"
    sys_version = ""

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
        self.send_header("Expires", "0")
        SimpleHTTPRequestHandler.end_headers(self)

    def log_message(self, fmt, *args):
        return

    def log_error(self, fmt, *args):
        sys.stdout.write("  [%s] %s\n" % (self.log_date_time_string(), fmt % args))
        sys.stdout.flush()


def main():
    if sys.version_info < (3, 7):
        print("ERROR: Python 3.7 or newer is required (found %d.%d)."
              % (sys.version_info[0], sys.version_info[1]))
        print("       This server relies on SimpleHTTPRequestHandler's 'directory' argument,")
        print("       which was added in 3.7. Install a newer Python and re-run Setup.bat.")
        return 3

    ap = argparse.ArgumentParser(description="Serve the packaged Anomaly Dashboard build.")
    ap.add_argument("--directory", required=True, help="folder containing index.html and config.json")
    ap.add_argument("--port", type=int, default=5180, help="port to serve on (default 5180)")
    ap.add_argument("--bind", default="127.0.0.1", help="address to bind (default 127.0.0.1)")
    ap.add_argument("--verify-only", action="store_true",
                    help="serve briefly, fetch ./config.json over HTTP, report and exit")
    args = ap.parse_args()

    root = os.path.abspath(args.directory)
    if not os.path.isdir(root):
        print("ERROR: dashboard folder not found: %s" % root)
        print("       Re-run Setup.bat, or check the delivery folder layout.")
        return 1
    if not os.path.isfile(os.path.join(root, "index.html")):
        print("ERROR: no index.html in %s" % root)
        print("       That folder should hold the BUILT dashboard (index.html + assets/ + config.json).")
        return 1
    if not os.path.isfile(os.path.join(root, "config.json")):
        print("WARNING: no config.json in %s" % root)
        print("         The dashboard will open on its manual connect screen and ask for a token.")
        print("         Re-run Setup.bat to write it.")

    handler = partial(DashboardHandler, directory=root)
    try:
        httpd = HTTPServer((args.bind, args.port), handler)
    except OSError as exc:
        if getattr(exc, "errno", None) in (errno.EADDRINUSE, 10048, 98):
            print("ERROR: port %d is already in use." % args.port)
            print("       Another dashboard window is probably already running - use that one,")
            print("       or close it and start Run.bat again.")
        else:
            print("ERROR: could not start the server on %s:%d - %s" % (args.bind, args.port, exc))
        return 2

    url = "http://%s:%d/" % (args.bind, args.port)

    if args.verify_only:
        import threading
        import urllib.request
        import json as _json
        t = threading.Thread(target=httpd.handle_request)
        t.daemon = True
        t.start()
        try:
            with urllib.request.urlopen(url + "config.json", timeout=5) as resp:
                body = resp.read().decode("utf-8")
                _json.loads(body)
                ctype = resp.headers.get("Content-Type", "")
        except Exception as exc:
            print("FAIL: config.json is not fetchable from the served root - %s" % exc)
            httpd.server_close()
            return 4
        httpd.server_close()
        if "application/json" not in ctype:
            print("FAIL: config.json served as '%s', expected application/json." % ctype)
            return 4
        print("OK: config.json is fetchable from %s and parses as JSON." % url)
        return 0

    print("=" * 60)
    print("  Anomaly Dashboard is being served")
    print("  Open:   %s" % url)
    print("  Files:  %s" % root)
    print("  Leave this window open while you use the dashboard; close it when done.")
    print("=" * 60)
    sys.stdout.flush()

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nDashboard server stopped.")
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())

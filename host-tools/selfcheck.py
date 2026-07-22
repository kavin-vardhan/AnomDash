#!/usr/bin/env python3
"""
selfcheck.py - report whether the three moving parts of a capture session are up.

Run.bat calls this a few seconds after launching its windows, so the most common client mistake -
"I forgot to start the game" - is visible immediately in the launcher window, instead of showing up
later as an unexplained problem in the app.

Three checks:
  dashboard    the desktop app process is running (--dashboard-exe), OR a served port is open
               (--dashboard-port, the M2 Python-served fallback route)
  watcher      heartbeat file touched within --max-age    (written each poll by encode_watcher.py)
  game server  TCP connect to the control-server port     (the in-game IAI.Server)

Only the game server is expected to be down at this point in the flow - the client starts the game
separately - so that line carries the instruction rather than an error.

Always exits 0: this is information, never a gate.
"""

import argparse
import os
import socket
import subprocess
import sys
import time

OK = "  OK   "
DOWN = " ---   "


def port_open(host, port, timeout=1.5):
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def process_running(exe_name):
    try:
        out = subprocess.run(
            ["tasklist", "/FI", "IMAGENAME eq %s" % exe_name, "/NH"],
            capture_output=True, text=True, timeout=5,
        )
        return exe_name.lower() in out.stdout.lower()
    except Exception:
        return False


def heartbeat_fresh(path, max_age):
    if not path or not os.path.isfile(path):
        return False
    try:
        return (time.time() - os.path.getmtime(path)) <= max_age
    except OSError:
        return False


def main():
    ap = argparse.ArgumentParser(description="Report dashboard / watcher / game-server status.")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--dashboard-exe", default="", help="desktop app image name (e.g. Dashboard.exe)")
    ap.add_argument("--dashboard-port", type=int, default=0, help="served dashboard port (fallback route)")
    ap.add_argument("--game-port", type=int, default=8077)
    ap.add_argument("--heartbeat", default="", help="watcher heartbeat file")
    ap.add_argument("--max-age", type=float, default=15.0, help="seconds a heartbeat stays fresh")
    args = ap.parse_args()

    if args.dashboard_exe:
        dashboard = process_running(args.dashboard_exe)
        dash_ok = "%s dashboard    %s running" % (OK, args.dashboard_exe)
        dash_down = "%s dashboard    %s is not running - check the app window" % (DOWN, args.dashboard_exe)
    else:
        dashboard = port_open(args.host, args.dashboard_port)
        dash_ok = "%s dashboard    http://%s:%d/" % (OK, args.host, args.dashboard_port)
        dash_down = "%s dashboard    not serving on port %d - check the Anomaly Dashboard window" % (DOWN, args.dashboard_port)

    watcher = heartbeat_fresh(args.heartbeat, args.max_age)
    game = port_open(args.host, args.game_port)

    print("")
    print("  Status check")
    print("  ------------------------------------------------------------")
    print(dash_ok if dashboard else dash_down)
    if watcher:
        print("%s watcher      running (videos will be encoded automatically)" % OK)
    else:
        print("%s watcher      no heartbeat yet - check the Anomaly Watcher window" % DOWN)
    if game:
        print("%s game server  connected on port %d" % (OK, args.game_port))
    else:
        print("%s game server  NOT RUNNING YET - start the game, then the dashboard will connect" % DOWN)
        print("               (the dashboard shows 'reconnecting' until it does)")
    print("  ------------------------------------------------------------")
    print("")
    return 0


if __name__ == "__main__":
    sys.exit(main())

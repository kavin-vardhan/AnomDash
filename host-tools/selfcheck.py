#!/usr/bin/env python3
"""
selfcheck.py - report whether the three moving parts of a capture session are up.

Run.bat calls this a few seconds after launching its windows, so the most common client mistake -
"I forgot to start the game" - is visible immediately in the launcher window, instead of showing up
later as a red dot in the browser that needs explaining.

Three checks:
  dashboard    TCP connect to the dashboard port          (served by serve_dashboard.py)
  watcher      heartbeat file touched within --max-age    (written each poll by encode_watcher.py)
  game server  TCP connect to the control-server port     (the in-game IAI.Server)

Only the game server is expected to be down at this point in the flow - the client starts the game
separately - so that line carries the instruction rather than an error.

Always exits 0: this is information, never a gate.
"""

import argparse
import os
import socket
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
    ap.add_argument("--dashboard-port", type=int, default=5180)
    ap.add_argument("--game-port", type=int, default=8077)
    ap.add_argument("--heartbeat", default="", help="watcher heartbeat file")
    ap.add_argument("--max-age", type=float, default=15.0, help="seconds a heartbeat stays fresh")
    args = ap.parse_args()

    dashboard = port_open(args.host, args.dashboard_port)
    watcher = heartbeat_fresh(args.heartbeat, args.max_age)
    game = port_open(args.host, args.game_port)

    print("")
    print("  Status check")
    print("  ------------------------------------------------------------")
    if dashboard:
        print("%s dashboard    http://%s:%d/" % (OK, args.host, args.dashboard_port))
    else:
        print("%s dashboard    not serving on port %d - check the Anomaly Dashboard window" % (DOWN, args.dashboard_port))

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

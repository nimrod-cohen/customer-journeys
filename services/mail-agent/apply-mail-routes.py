#!/usr/bin/env python3
"""Apply the app's mail route plan to Postfix. Runs as root after each hourly probe.

The plan file is written by an unprivileged process from a network answer, so nothing
in it is trusted: only well-formed domains are accepted, and any doubt leaves the
current routes alone. Postfix is reloaded only when the routes actually change.
"""
import json
import os
import re
import shutil
import subprocess
import sys

PLAN_FILE = os.environ.get("ROUTE_PLAN_FILE", "/var/lib/mail-health-probe/routes.json")
TRANSPORT_FILE = os.environ.get("TRANSPORT_FILE", "/etc/postfix/transport")
TRANSPORT = "direct-mx"
DOMAIN = re.compile(r"^[a-z0-9-]+(\.[a-z0-9-]+)+$")
MAX_DOMAINS = 100
HEADER = "# Managed by apply-mail-routes.py from the app's Mail health checks. Do not edit.\n"


def render(domains):
    return HEADER + "".join(f"{d} {TRANSPORT}:{d}\n" for d in sorted(set(domains)))


def load_plan():
    with open(PLAN_FILE, encoding="utf-8") as handle:
        domains = json.load(handle)["direct_domains"]
    if not isinstance(domains, list) or len(domains) > MAX_DOMAINS:
        raise ValueError("invalid plan")
    if not all(isinstance(d, str) and DOMAIN.fullmatch(d) for d in domains):
        raise ValueError("invalid domain in plan")
    return domains


def run(*command):
    subprocess.run(command, check=True, capture_output=True, timeout=30)


def main():
    try:
        wanted = render(load_plan())
    except FileNotFoundError:
        return 0
    except (OSError, ValueError, KeyError, TypeError) as error:
        print(f"route plan refused: {error}", file=sys.stderr)
        return 1
    try:
        with open(TRANSPORT_FILE, encoding="utf-8") as handle:
            current = handle.read()
    except FileNotFoundError:
        current = None
    if current == wanted:
        return 0

    backup = TRANSPORT_FILE + ".previous"
    if current is not None:
        shutil.copy2(TRANSPORT_FILE, backup)
    temp = TRANSPORT_FILE + ".tmp"
    with open(temp, "w", encoding="utf-8") as handle:
        handle.write(wanted)
    os.chmod(temp, 0o644)
    os.replace(temp, TRANSPORT_FILE)
    try:
        run("postmap", TRANSPORT_FILE)
        run("postfix", "check")
        run("postfix", "reload")
    except (OSError, subprocess.SubprocessError) as error:
        if current is not None:
            shutil.copy2(backup, TRANSPORT_FILE)
            run("postmap", TRANSPORT_FILE)
            run("postfix", "reload")
        print(f"route change rolled back: {error}", file=sys.stderr)
        return 1
    print(json.dumps({"routes_changed": True, "direct_domains": wanted.count("\n") - 1}))
    return 0


if __name__ == "__main__":
    sys.exit(main())

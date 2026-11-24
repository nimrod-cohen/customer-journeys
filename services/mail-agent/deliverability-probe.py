#!/usr/bin/env python3
"""Deliverability probe: runs ON each mail server, hourly, and reports to the app.

A provider only reveals an IP block to a connection FROM that IP, so this cannot run
anywhere else. It opens an SMTP session to each provider and stops after MAIL FROM:
no RCPT, no DATA, so no message is ever sent. It also asks public blocklists about
our IPs, including each list's test entry so the app can tell "not listed" from "this
resolver is refused".

Like mail-agent it is deliberately thin. It forwards raw answers and decides nothing.
Standard library only, because the relay box has no Node.

Install: /opt/mail-agent/deliverability-probe.py, run by a systemd timer.
Env: MAIL_AGENT_SECRET, PROBE_IP, PROBE_EHLO, optional HEALTH_URL, and on the server
that routes mail ROUTE_PLAN_FILE: the app's answer is saved there for apply-mail-routes.py,
which runs as root. This script runs unprivileged and never touches Postfix.
"""
import datetime
import json
import os
import smtplib
import socket
import subprocess
import sys
import urllib.request

ENDPOINT = os.environ.get("HEALTH_URL", "https://journeys.on-grow.com/internal/mail-health")
SECRET = os.environ.get("MAIL_AGENT_SECRET", "")
PROBE_IP = os.environ.get("PROBE_IP", "")
EHLO = os.environ.get("PROBE_EHLO", socket.getfqdn())
MAIL_FROM = os.environ.get("PROBE_MAIL_FROM", "postmaster@bounce.journeys.on-grow.com")
SMTP_TIMEOUT = 20
ROUTE_PLAN_FILE = os.environ.get("ROUTE_PLAN_FILE", "")
TRANSPORT_FILE = "/etc/postfix/transport"

TARGETS = [
    ("google", "gmail-smtp-in.l.google.com"),
    ("microsoft", "hotmail-com.olc.protection.outlook.com"),
    ("microsoft", "outlook-com.olc.protection.outlook.com"),
    ("apple", "mx01.mail.icloud.com"),
]
OUR_IPS = ["2.28.76.169", "194.195.243.92"]
TEST_POINT = "127.0.0.2"
ZONES = ["zen.spamhaus.org", "bl.spamcop.net", "b.barracudacentral.org"]


class IPv4SMTP(smtplib.SMTP):
    """Connect over IPv4, because blocks and our published identity are per IPv4."""

    def _get_socket(self, host, port, timeout):
        address = socket.getaddrinfo(host, port, socket.AF_INET, socket.SOCK_STREAM)[0][4]
        return socket.create_connection(address, timeout)


def text(value):
    if isinstance(value, bytes):
        value = value.decode("utf-8", "replace")
    return " ".join(str(value).split())[:1000]


def probe_smtp(provider, mx):
    result = {"provider": provider, "mx": mx, "stage": "connect", "code": None, "reply": ""}
    client = IPv4SMTP(timeout=SMTP_TIMEOUT)
    try:
        code, reply = client.connect(mx, 25)
        result.update(stage="banner", code=code, reply=text(reply))
        if code != 220:
            return result
        code, reply = client.ehlo(EHLO)
        result.update(stage="ehlo", code=code, reply=text(reply))
        if not 200 <= code < 300:
            return result
        code, reply = client.mail(MAIL_FROM)
        result.update(stage="mail", code=code, reply=text(reply))
        return result
    except (OSError, smtplib.SMTPException) as error:
        # A dropped session after a good step must not read as a pass.
        result.update(code=None, reply=text(error) or type(error).__name__)
        return result
    finally:
        try:
            client.rset()
            client.quit()
        except (OSError, smtplib.SMTPException):
            client.close()


def lookup(target, zone):
    name = ".".join(reversed(target.split("."))) + "." + zone
    try:
        answers = sorted({info[4][0] for info in socket.getaddrinfo(name, None, socket.AF_INET)})
        return {"target": target, "zone": zone, "answers": answers[:10], "error": None}
    except socket.gaierror as error:
        if error.errno == socket.EAI_NONAME:
            return {"target": target, "zone": zone, "answers": [], "error": None}
        return {"target": target, "zone": zone, "answers": [], "error": text(error)}


def relayhost():
    try:
        out = subprocess.run(
            ["postconf", "-h", "relayhost"], capture_output=True, text=True, timeout=10, check=True
        )
        return out.stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return None


def direct_domains():
    try:
        with open(TRANSPORT_FILE, encoding="utf-8") as handle:
            lines = [line.split() for line in handle if line.strip() and not line.startswith("#")]
        return sorted({parts[0] for parts in lines if len(parts) == 2})
    except FileNotFoundError:
        return []


def save_plan(answer):
    domains = answer.get("direct_domains")
    if not ROUTE_PLAN_FILE or not isinstance(domains, list):
        return
    temp = ROUTE_PLAN_FILE + ".tmp"
    with open(temp, "w", encoding="utf-8") as handle:
        json.dump({"direct_domains": domains}, handle)
    os.replace(temp, ROUTE_PLAN_FILE)


def main():
    if not SECRET or not PROBE_IP:
        print("MAIL_AGENT_SECRET and PROBE_IP are required", file=sys.stderr)
        return 2
    socket.setdefaulttimeout(10)
    report = {
        "ip": PROBE_IP,
        "checked_at": datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z"),
        "relayhost": relayhost(),
        **({"direct_domains": direct_domains()} if ROUTE_PLAN_FILE else {}),
        "smtp": [probe_smtp(provider, mx) for provider, mx in TARGETS],
        "dnsbl": [lookup(target, zone) for zone in ZONES for target in [TEST_POINT, *OUR_IPS]],
    }
    if "--dry-run" in sys.argv:
        print(json.dumps(report, indent=1))
        return 0
    request = urllib.request.Request(
        ENDPOINT,
        data=json.dumps(report).encode(),
        headers={"Authorization": f"Bearer {SECRET}", "Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=20) as response:
        save_plan(json.loads(response.read() or b"{}"))
        print(json.dumps({"status": response.status, "ip": PROBE_IP}))
    return 0


if __name__ == "__main__":
    sys.exit(main())

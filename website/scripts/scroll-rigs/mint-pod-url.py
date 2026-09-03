"""Mint a fresh pod dashboard URL for the scroll rigs.

Usage: python3 mint-pod-url.py <pod-worktree-name> <session-key> [kirocrew-bin]

Writes the URL to /tmp/kc-pod-url.txt. Pod dashboard tokens expire within
minutes, so re-mint immediately before every rig run rather than once per
session. `pod up --json` is the supported way to obtain a token; the session
key selects which seeded conversation the rig scrolls (the rigs assume a
long transcript with archived history, e.g. a 1000+ message session).
"""
import json
import pathlib
import subprocess
import sys

POD = sys.argv[1]
KEY = sys.argv[2]
KC = sys.argv[3] if len(sys.argv) > 3 else "kirocrew"

out = subprocess.run(
    [KC, "pod", "up", POD, "--json"], capture_output=True, text=True, timeout=300
).stdout
d = json.loads([line for line in out.splitlines() if line.strip().startswith("{")][-1])
base = d["base_url"].replace("127.0.0.1", "localhost")
url = f"{base}/chat/{KEY}?token={d['token']}&sid={KEY}"
pathlib.Path("/tmp/kc-pod-url.txt").write_text(url)
print(url.split("token=")[0] + "token=***")

"""claude-board — tiny CLI Claude sessions invoke to sync manifests.

Pure stdlib (urllib + json + argparse). No `pip install` required for
the runtime — drop the script into the user's PATH and it works.

Config file lives at ~/.claude/board.config (TOML-ish flat key=value
so we don't pull in a TOML parser). Two keys:

    server = https://odin.heimdallsystems.ai
    token  = <the secret minted by /api/boards>

Manifests live at ~/.claude-board/<session_id>.json. A push iterates
that directory, POSTs every file, and prints a one-line summary.

The CLI is also responsible for the very first user moment — running
`claude-board init <server-url>` mints a board against the server,
writes the config file, and prints a snippet to paste into the user's
CLAUDE.md.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

CONFIG_PATH    = Path(os.path.expanduser("~/.claude/board.config"))
MANIFEST_DIR   = Path(os.path.expanduser("~/.claude-board"))
USER_AGENT     = "claude-board-cli/0.1"


# ----------------- config -----------------

def _read_config() -> dict[str, str]:
    if not CONFIG_PATH.exists():
        return {}
    out: dict[str, str] = {}
    for line in CONFIG_PATH.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        out[k.strip()] = v.strip()
    return out


def _write_config(cfg: dict[str, str]) -> None:
    CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    body = "\n".join(f"{k} = {v}" for k, v in cfg.items()) + "\n"
    CONFIG_PATH.write_text(body, encoding="utf-8")
    try:
        os.chmod(CONFIG_PATH, 0o600)
    except OSError:
        pass


# ----------------- HTTP -----------------

def _request(method: str, url: str, *, token: str | None = None, body: Any = None) -> tuple[int, dict[str, Any]]:
    data = None
    headers = {"User-Agent": USER_AGENT, "Accept": "application/json"}
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            raw = resp.read()
            return resp.status, (json.loads(raw) if raw else {})
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, json.loads(raw) if raw else {"error": str(e)}
        except json.JSONDecodeError:
            return e.code, {"error": raw.decode("utf-8", "replace")}


# ----------------- commands -----------------

def cmd_init(args: argparse.Namespace) -> int:
    """Mint a new board on the chosen server and persist the result.

    Idempotent in the spirit of `git init`: refuses to overwrite an
    existing config unless --force.
    """
    server = args.server.rstrip("/")
    existing = _read_config()
    if existing.get("token") and not args.force:
        print(f"already initialised against {existing.get('server')}", file=sys.stderr)
        print(f"  re-run with --force to mint a fresh board", file=sys.stderr)
        return 1

    status, body = _request("POST", f"{server}/api/boards", body={"note": args.note})
    if status >= 300 or "token" not in body:
        print(f"board create failed: HTTP {status} — {body}", file=sys.stderr)
        return 1

    _write_config({
        "server":   server,
        "token":    body["token"],
        "board_id": body["board_id"],
    })

    url = f"{server}/b/{body['board_id']}"
    print()
    print("  Claude Board ready.")
    print(f"  Board URL:  {url}")
    print(f"  Board ID:   {body['board_id']}")
    print()
    print("  Token saved to ~/.claude/board.config (mode 0600).")
    print("  THIS IS SHOWN ONCE — no recovery. Re-run with --force to mint a new one.")
    print()
    print("  Add the snippet at docs/claude-md-snippet.md to your ~/.claude/CLAUDE.md")
    print("  so future Claude sessions push manifests automatically.")
    print()
    return 0


def cmd_status(args: argparse.Namespace) -> int:
    cfg = _read_config()
    if not cfg.get("token"):
        print("not initialised — run `claude-board init <server>` first", file=sys.stderr)
        return 1
    print(f"server:    {cfg.get('server', '?')}")
    print(f"board_id:  {cfg.get('board_id', '?')}")
    print(f"config:    {CONFIG_PATH}")
    print(f"manifests: {MANIFEST_DIR}")
    if MANIFEST_DIR.exists():
        files = sorted(MANIFEST_DIR.glob("*.json"))
        print(f"  {len(files)} local manifest(s)")
        for f in files[-10:]:
            try:
                obj = json.loads(f.read_text(encoding="utf-8"))
                print(f"    {f.name}  status={obj.get('status', '?')}  title={obj.get('title', '?')[:60]}")
            except json.JSONDecodeError:
                print(f"    {f.name}  (unparseable)")
    return 0


def cmd_push(args: argparse.Namespace) -> int:
    cfg = _read_config()
    if not cfg.get("token") or not cfg.get("server"):
        print("not initialised — run `claude-board init <server>` first", file=sys.stderr)
        return 1
    if not MANIFEST_DIR.exists():
        if args.verbose:
            print(f"no manifest dir at {MANIFEST_DIR} — nothing to push")
        return 0

    files = sorted(MANIFEST_DIR.glob("*.json"))
    if args.session_id:
        # Only push a specific session — useful when a Claude session
        # wants to push *only its own* manifest in a hook.
        files = [MANIFEST_DIR / f"{args.session_id}.json"]
        if not files[0].exists():
            print(f"no manifest for session_id={args.session_id}", file=sys.stderr)
            return 1

    server = cfg["server"].rstrip("/")
    pushed = 0
    failed = 0
    for f in files:
        try:
            obj = json.loads(f.read_text(encoding="utf-8"))
        except json.JSONDecodeError as e:
            print(f"  skip {f.name}: invalid JSON ({e})", file=sys.stderr)
            failed += 1
            continue
        # Server-side fields the client must not set.
        obj.pop("board_id", None)
        obj.pop("received_at", None)
        # Ensure updated_at exists so the server's ORDER BY works.
        obj.setdefault("updated_at", datetime.now(timezone.utc).isoformat(timespec="seconds"))
        status, body = _request(
            "POST", f"{server}/api/manifests",
            token=cfg["token"], body=obj,
        )
        if status >= 300:
            print(f"  fail {f.name}: HTTP {status} {body.get('detail', body)}", file=sys.stderr)
            failed += 1
            continue
        pushed += 1
        if args.verbose:
            print(f"  ok   {f.name}  {obj.get('status','?')}  {obj.get('title','')[:60]}")

    print(f"pushed={pushed} failed={failed}")
    return 0 if failed == 0 else 2


def cmd_watch(args: argparse.Namespace) -> int:
    """Naïve polling watcher — every N seconds, push everything. Good
    enough for the manifest sizes we deal with; saves us a watchdog
    dependency."""
    cfg = _read_config()
    if not cfg.get("token") or not cfg.get("server"):
        print("not initialised — run `claude-board init <server>` first", file=sys.stderr)
        return 1
    interval = max(2, int(args.interval))
    print(f"watching {MANIFEST_DIR} (every {interval}s) — Ctrl-C to stop")
    last_mtimes: dict[str, float] = {}
    while True:
        changed = False
        if MANIFEST_DIR.exists():
            for f in MANIFEST_DIR.glob("*.json"):
                m = f.stat().st_mtime
                if last_mtimes.get(str(f)) != m:
                    last_mtimes[str(f)] = m
                    changed = True
        if changed:
            cmd_push(argparse.Namespace(session_id=None, verbose=args.verbose))
        time.sleep(interval)


def cmd_delete(args: argparse.Namespace) -> int:
    cfg = _read_config()
    if not cfg.get("token"):
        print("not initialised", file=sys.stderr)
        return 1
    status, body = _request(
        "DELETE", f"{cfg['server'].rstrip('/')}/api/manifests/{args.session_id}",
        token=cfg["token"],
    )
    if status >= 300:
        print(f"delete failed: HTTP {status} — {body}", file=sys.stderr)
        return 1
    # Also remove the local manifest file, if any.
    local = MANIFEST_DIR / f"{args.session_id}.json"
    if local.exists():
        local.unlink()
    print(f"deleted {args.session_id}")
    return 0


# ----------------- entry -----------------

def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="claude-board", description="Sync Claude session manifests to a Claude Board server.")
    sub = p.add_subparsers(dest="cmd", required=True)

    p_init = sub.add_parser("init", help="Mint a new board against a server.")
    p_init.add_argument("server", help="Server URL (e.g. https://odin.heimdallsystems.ai)")
    p_init.add_argument("--note", default="", help="Free-form label for the board")
    p_init.add_argument("--force", action="store_true", help="Overwrite an existing config")
    p_init.set_defaults(func=cmd_init)

    p_status = sub.add_parser("status", help="Show local config + recent manifests.")
    p_status.set_defaults(func=cmd_status)

    p_push = sub.add_parser("push", help="POST local manifests to the server.")
    p_push.add_argument("--session-id", default=None, help="Push only this session's manifest")
    p_push.add_argument("-v", "--verbose", action="store_true")
    p_push.set_defaults(func=cmd_push)

    p_watch = sub.add_parser("watch", help="Watch ~/.claude-board/ and push on changes.")
    p_watch.add_argument("--interval", default=5, type=int, help="Poll interval seconds (default 5)")
    p_watch.add_argument("-v", "--verbose", action="store_true")
    p_watch.set_defaults(func=cmd_watch)

    p_del = sub.add_parser("delete", help="Delete a session's manifest (local + server).")
    p_del.add_argument("session_id")
    p_del.set_defaults(func=cmd_delete)

    args = p.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())

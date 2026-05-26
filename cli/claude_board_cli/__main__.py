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

    # The archive subdirectory is where "done"-and-stale manifests
    # retire to. We never push from there and we never re-archive
    # something that's already moved.
    archive_dir = MANIFEST_DIR / "archive"
    files = sorted(MANIFEST_DIR.glob("*.json"))   # excludes archive/ subdir
    if args.session_id:
        files = [MANIFEST_DIR / f"{args.session_id}.json"]
        if not files[0].exists():
            print(f"no manifest for session_id={args.session_id}", file=sys.stderr)
            return 1

    server = cfg["server"].rstrip("/")
    pushed = 0
    failed = 0
    archived = 0
    now = datetime.now(timezone.utc)
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
        # Auto-fill project_dir from the CLI's CWD if the manifest
        # doesn't carry one. This is what the board uses to build
        # the `claude-cli://open?cwd=…` deep-link badge on the card.
        # The Stop hook runs `claude-board push` from wherever the
        # Claude session is running, so $PWD is the session's
        # project directory — exactly what we want. Manifests that
        # set project_dir explicitly are left alone.
        if not obj.get("project_dir"):
            try:
                obj["project_dir"] = os.path.realpath(os.getcwd())
            except OSError:
                pass

        # Auto-archive: a manifest marked "done" gets a grace period
        # on the board (so the user sees the final state), then we
        # quietly delete it from the server and move the local file
        # into archive/ so the next push doesn't resurrect it. The
        # grace period is short by default (1 h) — long enough for a
        # post-completion glance, short enough that the board stops
        # being a graveyard. Override with --prune-after-hours / 0
        # for immediate or large number to retain longer.
        if obj.get("status") == "done" and not args.no_archive:
            try:
                done_age_hours = (now - datetime.fromisoformat(obj["updated_at"])).total_seconds() / 3600
            except (ValueError, TypeError):
                done_age_hours = 0
            if done_age_hours >= args.prune_after_hours:
                # Delete from server (best-effort), then move locally.
                _request("DELETE",
                         f"{server}/api/manifests/{obj['session_id']}",
                         token=cfg["token"])
                archive_dir.mkdir(parents=True, exist_ok=True)
                try:
                    f.rename(archive_dir / f.name)
                    archived += 1
                    if args.verbose:
                        print(f"  arch {f.name}  done {done_age_hours:.1f}h ago — archived")
                except OSError as e:
                    print(f"  warn {f.name}: couldn't archive ({e})", file=sys.stderr)
                continue

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

    summary = f"pushed={pushed} failed={failed}"
    if archived:
        summary += f" archived={archived}"
    print(summary)
    return 0 if failed == 0 else 2


def _resolve_session_id(arg_session_id: str | None) -> Path | None:
    """Pick the manifest file to operate on. Explicit --session-id wins;
    otherwise we pick the *most recently modified* manifest in the dir
    that isn't archived. This is "the session you're currently in"
    from the CLI's POV — good enough for block/unblock convenience."""
    if arg_session_id:
        p = MANIFEST_DIR / f"{arg_session_id}.json"
        return p if p.exists() else None
    candidates = sorted(
        (p for p in MANIFEST_DIR.glob("*.json") if p.is_file()),
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )
    return candidates[0] if candidates else None


def _update_manifest(path: Path, patch: dict[str, Any]) -> None:
    """Read-modify-write one manifest, stamping a fresh updated_at."""
    obj = json.loads(path.read_text(encoding="utf-8"))
    obj.update(patch)
    obj["updated_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    path.write_text(json.dumps(obj, indent=2) + "\n", encoding="utf-8")


def cmd_block(args: argparse.Namespace) -> int:
    """Flip the current session's manifest to blocked-on-user. Use this
    whenever a turn ends with a question to the user — even when the
    question is plain chat rather than AskUserQuestion. The Stop hook
    pushes the updated manifest immediately so the board's 'NEEDS YOU'
    indicator goes up before the user even reads the message."""
    p = _resolve_session_id(args.session_id)
    if p is None:
        print("no manifest to block — pass --session-id or create one first", file=sys.stderr)
        return 1
    reason = (args.reason or "").strip()[:120]
    _update_manifest(p, {"blocked_on_user": True, "blocked_reason": reason})
    print(f"blocked {p.stem}  reason={reason or '(none)'}")
    return 0


def cmd_unblock(args: argparse.Namespace) -> int:
    """Clear blocked-on-user for the current session. Run this when the
    user responds and you're picking the turn back up."""
    p = _resolve_session_id(args.session_id)
    if p is None:
        print("no manifest to unblock", file=sys.stderr)
        return 1
    _update_manifest(p, {"blocked_on_user": False, "blocked_reason": ""})
    print(f"unblocked {p.stem}")
    return 0


def cmd_chapter(args: argparse.Namespace) -> int:
    """Set current_chapter on the current session. Handy when you mark
    a new chapter via the IDE skill — call this in the same breath so
    the board's headline tracks what you're actually doing now."""
    p = _resolve_session_id(args.session_id)
    if p is None:
        print("no manifest to update", file=sys.stderr)
        return 1
    _update_manifest(p, {"current_chapter": args.text[:200]})
    print(f"chapter {p.stem}  → {args.text[:80]}")
    return 0


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
    p_push.add_argument("--no-archive", action="store_true",
                        help="Don't auto-archive done manifests (default: archive after grace)")
    p_push.add_argument("--prune-after-hours", type=float, default=1.0,
                        help="Hours a 'done' manifest stays on the board before auto-archive (default: 1)")
    p_push.set_defaults(func=cmd_push)

    # block / unblock / chapter — small helpers a Claude session calls
    # mid-turn to keep the board honest without me hand-editing JSON.
    p_block = sub.add_parser("block", help="Mark the current session blocked-on-user.")
    p_block.add_argument("--session-id", default=None,
                         help="Session to update (default: most recently modified)")
    p_block.add_argument("--reason", default="",
                         help="Short reason shown on the card (≤120 chars)")
    p_block.set_defaults(func=cmd_block)

    p_unblock = sub.add_parser("unblock", help="Clear blocked-on-user for the current session.")
    p_unblock.add_argument("--session-id", default=None)
    p_unblock.set_defaults(func=cmd_unblock)

    p_chapter = sub.add_parser("chapter", help="Set current_chapter on the current session.")
    p_chapter.add_argument("text", help="The chapter title")
    p_chapter.add_argument("--session-id", default=None)
    p_chapter.set_defaults(func=cmd_chapter)

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

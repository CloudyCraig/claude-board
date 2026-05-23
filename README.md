# Claude Board

> _The board that watches the boards._

A Heimdall-themed live view of every Claude session you're running — across projects, terminals, IDEs, and phones. Each session writes a small JSON manifest; the board renders them as cards arranged in concentric rings around Odin, with dependency edges between them. The card that needs your attention pulses amber.

![Odin centred, sessions radiating out](frontend/public/odin.png)

## Why

If you run more than one Claude Code session at a time you've felt this pain: which session is waiting on a clarification? Which one is grinding away autonomously? What depends on what? The board answers those questions at a glance — without you having to alt-tab through every terminal.

## Two ways to use it

1. **Public SaaS** — <https://odin.heimdallsystems.ai>. Click *Create a board*, get a `{board_id, token}`, paste two lines into your `~/.claude/CLAUDE.md`. Your Claude sessions start pushing immediately. Treat the token like a password.
2. **Self-host** — same code, `docker compose up`. Bring your own domain.

## Architecture

- **Server** — FastAPI + SQLite, single container. Bearer-token auth per board. `POST /api/manifests` to push, `GET /api/manifests` to read, optional SSE stream.
- **CLI** — `claude-board` (Python stdlib only). `init` mints a board; `push` syncs `~/.claude-board/*.json` to the server. Idempotent.
- **Frontend** — Vite + React + TS. Polar layout: blocked-on-you → innermost ring, active → middle, idle/blocked → outer, done → outermost. SVG edges for `depends_on`. Auto-refresh every 5s.
- **Deploy** — Docker + Caddy + auto-TLS via Let's Encrypt.

## Manifest spec

See [`docs/manifest-spec.md`](docs/manifest-spec.md) for the canonical schema. The CLAUDE.md snippet your board shows after `init` is enough to teach future sessions the convention.

## Self-host

```bash
git clone https://github.com/CloudyCraig/claude-board
cd claude-board/deploy
# Edit Caddyfile — replace odin.heimdallsystems.ai with your domain
docker compose up -d
```

Point an A record at the host's IP, wait ~30s for Let's Encrypt, you're live.

## Security model

Bearer token = full read/write to that board. Lose it, mint another (no recovery — we deliberately don't store recovery emails). The hash, not the token, is in the DB; a leaked DB still can't be authed against. Manifests are not encrypted at rest — don't put secrets in `notes` or `blocked_reason`.

## Status

v0.1 — works for me, used in anger. PRs welcome. The big missing pieces:

- SSE real-time updates (currently 5s polling)
- Multi-user-per-board (one token per board today; would need real accounts to share)
- Per-session colour overrides + favourite projects
- Mobile layout improvements

## Licence

MIT.

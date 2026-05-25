# Claude Board · deploy

Production stack for **Odin · Claude Board** (web) on Hetzner.

## First-time setup

1. **Generate a session secret** (used to sign auth cookies). Persist
   it in `deploy/.env` next to the compose file so a redeploy
   doesn't log everyone out:

   ```sh
   cd deploy
   if [ ! -f .env ]; then
     echo "BOARD_SESSION_SECRET=$(openssl rand -base64 48 | tr -d '=+/' | head -c 64)" > .env
     chmod 600 .env
   fi
   ```

2. **Bring the stack up**:

   ```sh
   docker compose up -d --build
   ```

   Caddy provisions a Let's Encrypt cert for `odin.heimdallsystems.ai`
   on first start. The cert auto-renews; nothing else to do.

## Update / redeploy

```sh
cd deploy
docker compose build claude-board
docker compose up -d --no-deps claude-board
```

The SQLite DB and Caddy certs are in named volumes — they survive
container rebuilds.

## Env vars

| var                    | required? | default                              | what                                                             |
|------------------------|-----------|--------------------------------------|------------------------------------------------------------------|
| `BOARD_SESSION_SECRET` | **yes**   | —                                    | URL-safe random ≥ 32 chars; signs auth-session cookies          |
| `BOARD_COOKIE_SECURE`  | no        | `"true"` (set in compose for prod)   | Emit Secure cookies; only true when behind https                |
| `BOARD_ALLOWED_ORIGINS`| no        | `https://odin.heimdallsystems.ai`    | Comma-separated CORS origin allow-list for `/api/auth/*`         |
| `BOARD_PRUNE_DAYS`     | no        | `60`                                 | Drop manifests not updated for this many days                    |
| `BOARD_SESSION_TTL_DAYS`| no       | `30`                                 | Auth cookie lifetime                                             |
| `BOARD_DB_PATH`        | no        | `/var/lib/claude-board/board.db`     | SQLite file location                                             |

## Routes (post v2)

| path                       | auth                | what                                |
|----------------------------|---------------------|-------------------------------------|
| `POST /api/boards`         | optional cookie     | Mint a new board (auto-attached to logged-in user) |
| `POST /api/manifests`      | bearer token        | Push manifest                       |
| `GET  /api/manifests`      | bearer token        | List manifests                      |
| `GET  /api/manifests/stream`| bearer token       | SSE wake-up stream                  |
| `POST /api/auth/register`  | none                | Create user + log in                |
| `POST /api/auth/login`     | none                | Sign in                             |
| `POST /api/auth/logout`    | none (clears cookie)| Sign out                            |
| `GET  /api/auth/me`        | cookie              | Current user                        |
| `GET  /api/users/me/boards`| cookie              | Boards owned by current user        |
| `/`, `/login`, `/register`, `/me`, `/b/<id>` | — | SPA pages |

"""Claude Board server — multi-tenant manifest store + static UI host.

One central concept: the BOARD. A user visits the homepage, clicks
"create a board", the server mints {board_id, token}. The user paste-
configures their local Claude with those two values; from then on
every Claude session they run writes manifests tagged with the board_id
via `claude-board push`. The board's URL (/b/<board_id>) shows the
user their own sessions — and only theirs, because the token is
required to read.

Threat model: bearer-token like a share link. Token = full read/write
access to that board. Lost token = mint a new board (no recovery —
we don't have email).

Storage: SQLite. Two tables (boards, manifests). Plenty for the scale
this thing operates at; trivially migratable to Postgres if it grows.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import secrets
import sqlite3
import time
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import uvicorn
from fastapi import Depends, FastAPI, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)

# ----------------- config -----------------

DB_PATH        = Path(os.environ.get("BOARD_DB_PATH", "/var/lib/claude-board/board.db"))
STATIC_DIR     = Path(os.environ.get("BOARD_STATIC_DIR", "/srv/claude-board/static"))
LISTEN_HOST    = os.environ.get("BOARD_HOST", "0.0.0.0")
LISTEN_PORT    = int(os.environ.get("BOARD_PORT", "8200"))
# Sessions older than this with no updates are pruned from disk daily.
PRUNE_AFTER_DAYS = int(os.environ.get("BOARD_PRUNE_DAYS", "60"))


# ----------------- store -----------------

# We deliberately use plain sqlite3 with manual SQL — the schema is
# small enough that an ORM would be overkill, and the connection-per-
# request pattern avoids the "SQLite objects can only be used in the
# thread they were created in" trap.

_SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS boards (
    board_id    TEXT PRIMARY KEY,
    token_hash  TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    last_seen   TEXT NOT NULL,
    note        TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS manifests (
    board_id    TEXT NOT NULL,
    session_id  TEXT NOT NULL,
    payload     TEXT NOT NULL,             -- JSON blob, the manifest as-stored
    status      TEXT NOT NULL DEFAULT 'active',
    blocked_on_user INTEGER NOT NULL DEFAULT 0,
    updated_at  TEXT NOT NULL,
    received_at TEXT NOT NULL,
    PRIMARY KEY (board_id, session_id)
);

CREATE INDEX IF NOT EXISTS idx_manifests_board_updated
    ON manifests(board_id, updated_at DESC);
"""


def _open_db() -> sqlite3.Connection:
    """Per-request connection. SQLite copes fine; the only writer at any
    one moment is the request thread, and WAL mode lets readers proceed
    without blocking."""
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=10.0, isolation_level=None)  # autocommit
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.row_factory = sqlite3.Row
    return conn


def _init_db() -> None:
    with _open_db() as conn:
        conn.executescript(_SCHEMA_SQL)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


# ----------------- auth helpers -----------------

# We store sha256(token) rather than the token itself. If the DB
# leaks, an attacker still can't push or read without the original
# tokens. Tokens are 32-byte URL-safe; bcrypt-style hashing is
# overkill at this length and entropy.

def _hash_token(token: str) -> str:
    import hashlib
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _board_for_token(token: str) -> dict[str, Any] | None:
    if not token or len(token) > 256:
        return None
    h = _hash_token(token)
    with _open_db() as conn:
        row = conn.execute(
            "SELECT board_id, created_at, note FROM boards WHERE token_hash = ?",
            (h,),
        ).fetchone()
        if row is None:
            return None
        conn.execute(
            "UPDATE boards SET last_seen = ? WHERE board_id = ?",
            (_now_iso(), row["board_id"]),
        )
        return dict(row)


async def require_board(request: Request) -> dict[str, Any]:
    """Bearer-token gate for all manifest endpoints."""
    auth = request.headers.get("authorization", "")
    if not auth.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="missing Bearer token")
    token = auth.split(None, 1)[1].strip()
    board = _board_for_token(token)
    if board is None:
        raise HTTPException(status_code=401, detail="invalid token")
    return board


# ----------------- payloads -----------------

class CreateBoardPayload(BaseModel):
    # Free-form label so the user can identify their own board in the
    # UI ("craig's main", "team-eng"). Optional.
    note: str = ""


class ManifestPayload(BaseModel):
    session_id:      str
    title:           str = "(untitled)"
    status:          str = "active"          # active | blocked | idle | done
    updated_at:      str = ""
    started_at:      str = ""
    project:         str = ""
    current_chapter: str = ""
    blocked_on_user: bool = False
    blocked_reason:  str = ""
    tasks:           list[dict[str, Any]] = Field(default_factory=list)
    depends_on:      list[str] = Field(default_factory=list)
    notes:           str = ""

    # Unknown extra fields are accepted by Pydantic v2 default — see
    # model_config below.
    model_config = {"extra": "allow"}


# ----------------- SSE pubsub -----------------

# Each board has zero or more open SSE subscribers. When a manifest
# is written we push a small wake-up event to each of that board's
# subscribers and they refetch. Cheaper than streaming full
# manifests through the broker; keeps the SSE path stateless.

class _BoardPubSub:
    def __init__(self) -> None:
        self._subs: dict[str, set[asyncio.Queue[str]]] = {}

    def subscribe(self, board_id: str) -> asyncio.Queue[str]:
        q: asyncio.Queue[str] = asyncio.Queue(maxsize=64)
        self._subs.setdefault(board_id, set()).add(q)
        return q

    def unsubscribe(self, board_id: str, q: asyncio.Queue[str]) -> None:
        subs = self._subs.get(board_id)
        if subs is None:
            return
        subs.discard(q)
        if not subs:
            self._subs.pop(board_id, None)

    def publish(self, board_id: str, event: str) -> None:
        for q in list(self._subs.get(board_id, ())):
            try:
                q.put_nowait(event)
            except asyncio.QueueFull:
                # Slow consumer — drop the wake-up. The client will
                # pick up the missed state on its next manual refresh.
                logger.warning("SSE queue full for board=%s; dropping event", board_id[:8])

PUBSUB = _BoardPubSub()


# ----------------- app -----------------

@asynccontextmanager
async def lifespan(_: FastAPI):
    _init_db()
    logger.info("claude-board started; db=%s static=%s", DB_PATH, STATIC_DIR)
    # Background pruner runs once an hour. Cheap query; skip if the
    # table is small.
    prune_task = asyncio.create_task(_prune_loop())
    try:
        yield
    finally:
        prune_task.cancel()


async def _prune_loop() -> None:
    while True:
        try:
            with _open_db() as conn:
                cutoff = (datetime.now(timezone.utc).timestamp() - PRUNE_AFTER_DAYS * 86400)
                cutoff_iso = datetime.fromtimestamp(cutoff, tz=timezone.utc).isoformat(timespec="seconds")
                cur = conn.execute(
                    "DELETE FROM manifests WHERE updated_at < ?",
                    (cutoff_iso,),
                )
                if cur.rowcount:
                    logger.info("pruned %d stale manifests (older than %dd)", cur.rowcount, PRUNE_AFTER_DAYS)
        except Exception:  # noqa: BLE001
            logger.exception("prune loop failed; continuing")
        await asyncio.sleep(3600)


def _build_app() -> FastAPI:
    app = FastAPI(title="Claude Board", lifespan=lifespan)

    # CORS open for now — the API is bearer-token gated, so origin
    # doesn't add meaningful security. If we add cookies later, lock
    # this down.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
        allow_headers=["*"],
    )

    @app.get("/healthz")
    async def healthz() -> dict[str, str]:
        return {"status": "ok", "time": _now_iso()}

    @app.post("/api/boards")
    async def create_board(payload: CreateBoardPayload) -> dict[str, str]:
        """Mint a new board. Returns {board_id, token, url}. Token is
        shown ONCE — we store only the hash. Lose it and there is no
        recovery."""
        board_id = "brd_" + secrets.token_urlsafe(12)
        token = secrets.token_urlsafe(32)
        with _open_db() as conn:
            conn.execute(
                "INSERT INTO boards (board_id, token_hash, created_at, last_seen, note) VALUES (?, ?, ?, ?, ?)",
                (board_id, _hash_token(token), _now_iso(), _now_iso(), payload.note[:200]),
            )
        return {
            "board_id": board_id,
            "token":    token,
            "url":      f"/b/{board_id}",
            "note":     "Save this token now — it's shown only once.",
        }

    @app.post("/api/manifests")
    async def push_manifest(
        payload: ManifestPayload,
        board: dict[str, Any] = Depends(require_board),
    ) -> dict[str, Any]:
        """Idempotent upsert. The client (claude-board CLI) computes
        `updated_at`; we record `received_at` from our own clock so a
        clock-skewed client doesn't poison ordering for everyone."""
        if not payload.session_id or len(payload.session_id) > 64:
            raise HTTPException(status_code=400, detail="session_id required (≤64 chars)")
        # Defensive: refuse manifest payloads > 64 KB. A normal manifest
        # is well under 4 KB.
        raw = payload.model_dump_json()
        if len(raw) > 64_000:
            raise HTTPException(status_code=413, detail="manifest too large (>64 KB)")
        with _open_db() as conn:
            conn.execute(
                """
                INSERT INTO manifests (board_id, session_id, payload, status,
                                       blocked_on_user, updated_at, received_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(board_id, session_id) DO UPDATE SET
                    payload         = excluded.payload,
                    status          = excluded.status,
                    blocked_on_user = excluded.blocked_on_user,
                    updated_at      = excluded.updated_at,
                    received_at     = excluded.received_at
                """,
                (
                    board["board_id"], payload.session_id, raw,
                    payload.status, int(payload.blocked_on_user),
                    payload.updated_at or _now_iso(), _now_iso(),
                ),
            )
        PUBSUB.publish(board["board_id"], "update")
        return {"ok": True, "board_id": board["board_id"], "session_id": payload.session_id}

    @app.get("/api/manifests")
    async def list_manifests(
        board: dict[str, Any] = Depends(require_board),
    ) -> dict[str, Any]:
        with _open_db() as conn:
            rows = conn.execute(
                """
                SELECT payload, received_at FROM manifests
                WHERE board_id = ?
                ORDER BY updated_at DESC
                LIMIT 500
                """,
                (board["board_id"],),
            ).fetchall()
        items: list[dict[str, Any]] = []
        for r in rows:
            try:
                obj = json.loads(r["payload"])
            except json.JSONDecodeError:
                continue
            obj["received_at"] = r["received_at"]
            obj["board_id"]    = board["board_id"]
            items.append(obj)
        return {"items": items, "board_id": board["board_id"]}

    @app.delete("/api/manifests/{session_id}")
    async def delete_manifest(
        session_id: str,
        board: dict[str, Any] = Depends(require_board),
    ) -> dict[str, Any]:
        with _open_db() as conn:
            cur = conn.execute(
                "DELETE FROM manifests WHERE board_id = ? AND session_id = ?",
                (board["board_id"], session_id),
            )
            if cur.rowcount == 0:
                raise HTTPException(status_code=404, detail="not found")
        PUBSUB.publish(board["board_id"], "delete")
        return {"ok": True}

    @app.get("/api/manifests/stream")
    async def stream_manifests(
        request: Request,
        board: dict[str, Any] = Depends(require_board),
    ) -> StreamingResponse:
        """Server-Sent Events: a one-line wake-up event each time the
        board's manifests change. The client refetches /api/manifests
        on each event. Keeps the SSE path stateless and small."""
        q = PUBSUB.subscribe(board["board_id"])

        async def gen():
            # First event: tell the client to do an initial fetch.
            yield "data: hello\n\n"
            try:
                while True:
                    if await request.is_disconnected():
                        break
                    try:
                        event = await asyncio.wait_for(q.get(), timeout=20.0)
                        yield f"data: {event}\n\n"
                    except asyncio.TimeoutError:
                        # Keep-alive comment so proxies don't kill us.
                        yield ": keep-alive\n\n"
            finally:
                PUBSUB.unsubscribe(board["board_id"], q)

        return StreamingResponse(
            gen(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    # ---- static frontend ----
    #
    # The Vite-built bundle lives at STATIC_DIR. We serve assets via
    # StaticFiles and have a small catch-all so client-side routes
    # (/, /b/<id>) all serve index.html.

    if STATIC_DIR.exists() and (STATIC_DIR / "index.html").exists():
        app.mount("/assets", StaticFiles(directory=STATIC_DIR / "assets"), name="assets")

        @app.get("/odin.png")
        async def odin() -> Response:
            return FileResponse(STATIC_DIR / "odin.png")

        @app.get("/")
        @app.get("/b/{board_id}")
        async def spa(board_id: str = "") -> Response:
            return FileResponse(STATIC_DIR / "index.html")
    else:
        @app.get("/")
        async def index_dev() -> JSONResponse:
            return JSONResponse({
                "status": "no-static-bundle",
                "hint":   f"Build the frontend and place it at {STATIC_DIR}",
                "api":    "/api/boards, /api/manifests, /api/manifests/stream",
            })

    return app


def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format='{"time":"%(asctime)s","level":"%(levelname)s","logger":"%(name)s","msg":"%(message)s"}',
    )
    app = _build_app()
    uvicorn.run(app, host=LISTEN_HOST, port=LISTEN_PORT, log_level="info")


if __name__ == "__main__":
    main()

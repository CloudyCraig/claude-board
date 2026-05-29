"""Odin · Claude Board server — multi-tenant manifest store + user accounts + static UI host.

Two parallel concepts:

  1. **The BOARD** (original, still supported). A visitor mints a
     board, gets {board_id, bearer_token}, pastes them into their
     local CLAUDE.md. Every Claude session pushes manifests tagged
     with the board_id. /b/<board_id> shows that board's sessions.
     Auth = bearer token. No user account required. Great for the
     "I'm just trying it out" path and for the CLI.

  2. **The USER** (Odin v2, added 2026-05). Visitors (especially
     desktop-app users) register with name + email + password and
     an optional marketing-opt-in tickbox. A user can own zero or
     more boards. The desktop app pre-fills registration on first
     launch, then logs the user in with a signed session cookie.
     Auth = session cookie. Backwards compatible: the bearer-token
     flow still works untouched, so anyone with an existing
     CLAUDE.md keeps pushing without re-configuring.

Storage: SQLite. Tables: boards, manifests, users, sessions,
registrations, groups, group_members. Schema is initialised at
startup and ALTER-TABLE migrations are applied idempotently.

Threat model:
  • bearer token = full read/write access to that one board. Lose
    it, mint another. Tokens are sha256-hashed at rest.
  • user password is bcrypt-hashed. Session cookies are signed by
    itsdangerous with a server-side secret (BOARD_SESSION_SECRET).
    Without the secret the cookie can't be forged. Sessions also
    have a server-side row so we can revoke individual sessions.
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
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Optional

import bcrypt
import uvicorn
from email_validator import EmailNotValidError, validate_email
from fastapi import Cookie, Depends, FastAPI, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer
from pydantic import BaseModel, EmailStr, Field

logger = logging.getLogger(__name__)

# ----------------- config -----------------

DB_PATH        = Path(os.environ.get("BOARD_DB_PATH", "/var/lib/claude-board/board.db"))
STATIC_DIR     = Path(os.environ.get("BOARD_STATIC_DIR", "/srv/claude-board/static"))
LISTEN_HOST    = os.environ.get("BOARD_HOST", "0.0.0.0")
LISTEN_PORT    = int(os.environ.get("BOARD_PORT", "8200"))
# A live session untouched for this long is treated as dead and moved
# off the board into the archives table. Non-destructive: history is
# kept and a later push (the session resuming) resurrects the live
# card, so the threshold can be generous without risking active work.
STALE_ARCHIVE_HOURS = int(os.environ.get("BOARD_STALE_ARCHIVE_HOURS", "24"))
# How often the pruner sweeps for stale sessions.
PRUNE_INTERVAL_SECONDS = int(os.environ.get("BOARD_PRUNE_INTERVAL_SECONDS", "900"))

# Cookie session secret — used by itsdangerous to sign session-id
# cookies. MUST be set in production via env. In dev (no env var) we
# generate a fresh secret on each restart, which invalidates every
# existing session — fine for dev, catastrophic for prod, so we
# log loudly when this fallback fires.
_SESSION_SECRET_ENV = os.environ.get("BOARD_SESSION_SECRET", "").strip()
SESSION_SECRET      = _SESSION_SECRET_ENV or secrets.token_urlsafe(32)
SESSION_COOKIE_NAME = "odin_session"
SESSION_TTL_DAYS    = int(os.environ.get("BOARD_SESSION_TTL_DAYS", "30"))
# Set to "true" once we're served over HTTPS (i.e. in prod through
# Caddy). Local dev over http:// would silently drop a Secure cookie
# so the default is conservative.
COOKIE_SECURE       = os.environ.get("BOARD_COOKIE_SECURE", "false").lower() == "true"

_session_signer = URLSafeTimedSerializer(SESSION_SECRET, salt="odin-session-v1")


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

-- Append-only history of every manifest push. Lets a session be
-- "replayed" — scrubbed through frame by frame — even after the
-- live row is gone. `push_num` is a per-session sequence starting
-- at 1; we compute it transactionally on insert so concurrent pushes
-- for the same session can't collide.
--
-- We intentionally do NOT cascade-delete from this table when the
-- live `manifests` row is removed: history outlives the card. The
-- only paths that clear history are (a) an explicit DELETE on the
-- session by the owner (nuclear option) and (b) — eventually — a
-- retention policy on the board. For now history is unbounded; rows
-- are small text and growth is bounded by the human at the keyboard.
CREATE TABLE IF NOT EXISTS manifest_history (
    board_id    TEXT NOT NULL,
    session_id  TEXT NOT NULL,
    push_num    INTEGER NOT NULL,
    payload     TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    received_at TEXT NOT NULL,
    PRIMARY KEY (board_id, session_id, push_num)
);

CREATE INDEX IF NOT EXISTS idx_manifest_history_session
    ON manifest_history(board_id, session_id, push_num);

-- User-archived sessions. Distinct from auto-prune: when a user
-- clicks "archive" on a card, we move the live row here and keep
-- it indefinitely, paired with the manifest_history rows for
-- replay. The auto-prune loop only touches `manifests` (live), not
-- this table.
CREATE TABLE IF NOT EXISTS archives (
    board_id      TEXT NOT NULL,
    session_id    TEXT NOT NULL,
    final_payload TEXT NOT NULL,       -- the manifest at archive time
    archived_at   TEXT NOT NULL,
    push_count    INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (board_id, session_id)
);

CREATE INDEX IF NOT EXISTS idx_archives_board_time
    ON archives(board_id, archived_at DESC);

-- Odin v2: user accounts, sessions, registration audit log.
CREATE TABLE IF NOT EXISTS users (
    user_id          TEXT PRIMARY KEY,
    email            TEXT NOT NULL UNIQUE,   -- stored lower-cased
    name             TEXT NOT NULL DEFAULT '',
    password_hash    TEXT NOT NULL,           -- bcrypt
    marketing_opt_in INTEGER NOT NULL DEFAULT 0,
    created_at       TEXT NOT NULL,
    last_seen        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
    sid           TEXT PRIMARY KEY,           -- opaque token, stored as-is
    user_id       TEXT NOT NULL,
    created_at    TEXT NOT NULL,
    expires_at    TEXT NOT NULL,
    user_agent    TEXT DEFAULT '',
    FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- One row per registration event. We keep this even though the
-- users table already has marketing_opt_in, because the question
-- "how many people registered via the desktop app last week" needs
-- an event log, not a snapshot.
CREATE TABLE IF NOT EXISTS registrations (
    registration_id  TEXT PRIMARY KEY,
    user_id          TEXT NOT NULL,
    source           TEXT NOT NULL DEFAULT 'web',  -- 'web' | 'desktop' | 'cli'
    marketing_opt_in INTEGER NOT NULL DEFAULT 0,
    created_at       TEXT NOT NULL,
    user_agent       TEXT DEFAULT '',
    FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_registrations_user ON registrations(user_id);
CREATE INDEX IF NOT EXISTS idx_registrations_source ON registrations(source, created_at);

-- Groups: a user owns one or more groups, can invite other users
-- into them. Group ownership of boards comes later — for now a
-- group is just a named collection of user_ids.
CREATE TABLE IF NOT EXISTS groups (
    group_id      TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    owner_user_id TEXT NOT NULL,
    created_at    TEXT NOT NULL,
    FOREIGN KEY (owner_user_id) REFERENCES users(user_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS group_members (
    group_id    TEXT NOT NULL,
    user_id     TEXT NOT NULL,
    role        TEXT NOT NULL DEFAULT 'member',   -- 'owner' | 'admin' | 'member'
    added_at    TEXT NOT NULL,
    PRIMARY KEY (group_id, user_id)
);
"""


# Idempotent ALTER-TABLE migrations. SQLite's `ADD COLUMN IF NOT
# EXISTS` is only available on 3.35+; rather than depend on it we
# try the ADD and catch the "duplicate column" error. Each entry is
# (sql, friendly_name) so the log message tells us what ran.
_MIGRATIONS: list[tuple[str, str]] = [
    (
        "ALTER TABLE boards ADD COLUMN owner_user_id TEXT DEFAULT NULL",
        "boards.owner_user_id",
    ),
    (
        # Flips when the owner hides a board from their default list.
        # Sessions inside an archived board still exist on the server;
        # the flag is purely a UI/discovery concern. Set/cleared via
        # POST /api/boards/{id}/archive and /unarchive.
        "ALTER TABLE boards ADD COLUMN archived INTEGER NOT NULL DEFAULT 0",
        "boards.archived",
    ),
]


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
        for sql, name in _MIGRATIONS:
            try:
                conn.execute(sql)
                logger.info("migration applied: %s", name)
            except sqlite3.OperationalError as exc:
                if "duplicate column" in str(exc).lower():
                    continue
                raise
    if not _SESSION_SECRET_ENV:
        logger.warning(
            "BOARD_SESSION_SECRET not set — sessions will invalidate on every "
            "restart. Set this env var in production."
        )


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


# ----------------- user / session auth -----------------
#
# Passwords are bcrypt-hashed. Sessions are random 32-byte tokens
# stored server-side in `sessions` and handed to the client inside an
# itsdangerous-signed cookie. The signature prevents a tampered
# cookie from passing the DB lookup; the server-side row lets us
# revoke individual sessions (logout, password-change).

def _hash_password(plain: str) -> str:
    return bcrypt.hashpw(plain.encode("utf-8"), bcrypt.gensalt(rounds=12)).decode("utf-8")


def _verify_password(plain: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(plain.encode("utf-8"), hashed.encode("utf-8"))
    except (ValueError, TypeError):
        return False


def _normalise_email(email: str) -> str:
    """Validate + lower-case + strip. Raises HTTPException on bad input."""
    try:
        info = validate_email(email, check_deliverability=False)
    except EmailNotValidError as exc:
        raise HTTPException(status_code=400, detail=f"invalid email: {exc}") from exc
    return info.normalized.lower()


def _mint_session(user_id: str, user_agent: str = "") -> tuple[str, str, datetime]:
    """Create a session row + return (raw_sid, signed_cookie, expires_at)."""
    sid = secrets.token_urlsafe(32)
    now = datetime.now(timezone.utc)
    expires = now + timedelta(days=SESSION_TTL_DAYS)
    with _open_db() as conn:
        conn.execute(
            "INSERT INTO sessions (sid, user_id, created_at, expires_at, user_agent) "
            "VALUES (?, ?, ?, ?, ?)",
            (sid, user_id, now.isoformat(timespec="seconds"),
             expires.isoformat(timespec="seconds"), user_agent[:200]),
        )
    signed = _session_signer.dumps(sid)
    return sid, signed, expires


def _user_for_cookie(signed_cookie: str | None) -> Optional[dict[str, Any]]:
    """Verify the signed cookie, look up the session, return the user
    row. None for any failure mode (missing/bad/expired/revoked)."""
    if not signed_cookie:
        return None
    try:
        sid = _session_signer.loads(signed_cookie, max_age=SESSION_TTL_DAYS * 86400)
    except (BadSignature, SignatureExpired):
        return None
    with _open_db() as conn:
        row = conn.execute(
            """
            SELECT u.user_id, u.email, u.name, u.marketing_opt_in,
                   u.created_at, u.last_seen, s.expires_at
            FROM sessions s
            JOIN users u ON u.user_id = s.user_id
            WHERE s.sid = ?
            """,
            (sid,),
        ).fetchone()
        if row is None:
            return None
        # Reject expired rows defensively even though the signer
        # already enforced max_age — cheap insurance.
        try:
            expires = datetime.fromisoformat(row["expires_at"])
        except ValueError:
            return None
        if expires < datetime.now(timezone.utc):
            conn.execute("DELETE FROM sessions WHERE sid = ?", (sid,))
            return None
        # Refresh last_seen so we can tell who's been around lately.
        conn.execute("UPDATE users SET last_seen = ? WHERE user_id = ?",
                     (_now_iso(), row["user_id"]))
    return {
        "user_id":          row["user_id"],
        "email":            row["email"],
        "name":             row["name"],
        "marketing_opt_in": bool(row["marketing_opt_in"]),
        "created_at":       row["created_at"],
        "last_seen":        row["last_seen"],
    }


def _delete_session(signed_cookie: str | None) -> None:
    if not signed_cookie:
        return
    try:
        sid = _session_signer.loads(signed_cookie, max_age=SESSION_TTL_DAYS * 86400)
    except (BadSignature, SignatureExpired):
        return
    with _open_db() as conn:
        conn.execute("DELETE FROM sessions WHERE sid = ?", (sid,))


async def current_user(
    odin_session: str | None = Cookie(default=None, alias=SESSION_COOKIE_NAME),
) -> Optional[dict[str, Any]]:
    """Optional-user dependency. Returns the user dict if a valid
    session cookie is present, else None. Use this on endpoints
    that behave differently when logged-in vs anonymous (e.g.
    POST /api/boards stamps owner_user_id when present)."""
    return _user_for_cookie(odin_session)


async def require_user(
    odin_session: str | None = Cookie(default=None, alias=SESSION_COOKIE_NAME),
) -> dict[str, Any]:
    """Required-user dependency. 401 if no valid session."""
    user = _user_for_cookie(odin_session)
    if user is None:
        raise HTTPException(status_code=401, detail="not logged in")
    return user


def _set_session_cookie(response: Response, signed: str, expires: datetime) -> None:
    response.set_cookie(
        key=SESSION_COOKIE_NAME,
        value=signed,
        expires=expires,
        httponly=True,
        secure=COOKIE_SECURE,
        samesite="lax",
        path="/",
    )


def _clear_session_cookie(response: Response) -> None:
    response.delete_cookie(SESSION_COOKIE_NAME, path="/")


# ----------------- payloads -----------------

class CreateBoardPayload(BaseModel):
    # Free-form label so the user can identify their own board in the
    # UI ("craig's main", "team-eng"). Optional.
    note: str = ""


class RegisterPayload(BaseModel):
    name:             str
    email:            EmailStr
    password:         str
    marketing_opt_in: bool = False
    source:           str = "web"          # web | desktop | cli


class LoginPayload(BaseModel):
    email:    EmailStr
    password: str


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


def _archive_stale_manifests(conn: sqlite3.Connection, cutoff_iso: str) -> list[str]:
    """Move every live manifest untouched since `cutoff_iso` into the
    archives table. Non-destructive: manifest_history is left in place
    and a later push of the same session re-creates the live row, so an
    actually-resuming session reappears on its own. Returns the distinct
    board_ids that lost at least one card (so the caller can wake their
    SSE subscribers).

    Mirrors `_archive_session_now` (which is a per-session closure in
    _build_app); this is the batch, prune-loop variant. One IMMEDIATE
    transaction so a crash can't half-archive."""
    archived_at = _now_iso()
    conn.execute("BEGIN IMMEDIATE")
    try:
        rows = conn.execute(
            "SELECT board_id, session_id, payload FROM manifests WHERE updated_at < ?",
            (cutoff_iso,),
        ).fetchall()
        for r in rows:
            count = conn.execute(
                "SELECT COUNT(*) AS n FROM manifest_history WHERE board_id = ? AND session_id = ?",
                (r["board_id"], r["session_id"]),
            ).fetchone()["n"]
            conn.execute(
                """
                INSERT INTO archives (board_id, session_id, final_payload, archived_at, push_count)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(board_id, session_id) DO UPDATE SET
                    final_payload = excluded.final_payload,
                    archived_at   = excluded.archived_at,
                    push_count    = excluded.push_count
                """,
                (r["board_id"], r["session_id"], r["payload"], archived_at, count),
            )
        conn.execute(
            "DELETE FROM manifests WHERE updated_at < ?",
            (cutoff_iso,),
        )
        conn.execute("COMMIT")
    except Exception:
        conn.execute("ROLLBACK")
        raise
    return sorted({r["board_id"] for r in rows})


async def _prune_loop() -> None:
    while True:
        try:
            with _open_db() as conn:
                cutoff = datetime.now(timezone.utc).timestamp() - STALE_ARCHIVE_HOURS * 3600
                cutoff_iso = datetime.fromtimestamp(cutoff, tz=timezone.utc).isoformat(timespec="seconds")
                affected = _archive_stale_manifests(conn, cutoff_iso)
            if affected:
                logger.info("auto-archived stale manifests on %d board(s) (untouched >%dh)",
                            len(affected), STALE_ARCHIVE_HOURS)
                for board_id in affected:
                    PUBSUB.publish(board_id, "archive")
        except Exception:  # noqa: BLE001
            logger.exception("prune loop failed; continuing")
        await asyncio.sleep(PRUNE_INTERVAL_SECONDS)


def _build_app() -> FastAPI:
    app = FastAPI(title="Odin · Claude Board", lifespan=lifespan)

    # CORS: the manifest endpoints are bearer-token gated so origin
    # doesn't matter for them, but the auth endpoints set a cookie
    # and the desktop Electron app talks to us from a file:// or
    # custom-scheme origin. We allow_credentials=True with an
    # explicit origin allow-list rather than "*" (you can't combine
    # allow_credentials with wildcard origins).
    allowed_origins = [
        o.strip()
        for o in os.environ.get(
            "BOARD_ALLOWED_ORIGINS",
            "https://odin.heimdallsystems.ai,http://localhost:5173,http://localhost:8200",
        ).split(",")
        if o.strip()
    ]
    app.add_middleware(
        CORSMiddleware,
        allow_origins=allowed_origins,
        allow_credentials=True,
        allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
        allow_headers=["*"],
    )

    @app.get("/healthz")
    async def healthz() -> dict[str, str]:
        return {"status": "ok", "time": _now_iso()}

    @app.post("/api/boards")
    async def create_board(
        payload: CreateBoardPayload,
        user: dict[str, Any] | None = Depends(current_user),
    ) -> dict[str, str]:
        """Mint a new board. Returns {board_id, token, url}. Token is
        shown ONCE — we store only the hash. Lose it and there is no
        recovery. If the caller is logged in, the new board is
        owned by them (shows up in GET /api/users/me/boards)."""
        board_id = "brd_" + secrets.token_urlsafe(12)
        token = secrets.token_urlsafe(32)
        owner = user["user_id"] if user else None
        with _open_db() as conn:
            conn.execute(
                "INSERT INTO boards (board_id, token_hash, created_at, last_seen, note, owner_user_id) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (board_id, _hash_token(token), _now_iso(), _now_iso(),
                 payload.note[:200], owner),
            )
        return {
            "board_id": board_id,
            "token":    token,
            "url":      f"/b/{board_id}",
            "note":     "Save this token now — it's shown only once.",
        }

    # ----------------- auth endpoints -----------------

    @app.post("/api/auth/register")
    async def register(
        payload: RegisterPayload,
        request: Request,
        response: Response,
    ) -> dict[str, Any]:
        """Create a user, log them in (set session cookie), and write
        a row to the registrations audit log. Idempotent only by
        accident — a second register with the same email returns 409."""
        email = _normalise_email(payload.email)
        if len(payload.password) < 8:
            raise HTTPException(status_code=400,
                                detail="password must be at least 8 characters")
        if len(payload.name.strip()) == 0:
            raise HTTPException(status_code=400, detail="name is required")
        source = payload.source.strip().lower() or "web"
        if source not in {"web", "desktop", "cli"}:
            source = "web"
        user_id = "usr_" + secrets.token_urlsafe(12)
        ua = request.headers.get("user-agent", "")[:200]
        try:
            with _open_db() as conn:
                conn.execute(
                    "INSERT INTO users (user_id, email, name, password_hash, "
                    "marketing_opt_in, created_at, last_seen) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?)",
                    (user_id, email, payload.name.strip()[:120],
                     _hash_password(payload.password),
                     int(payload.marketing_opt_in),
                     _now_iso(), _now_iso()),
                )
                conn.execute(
                    "INSERT INTO registrations (registration_id, user_id, source, "
                    "marketing_opt_in, created_at, user_agent) VALUES (?, ?, ?, ?, ?, ?)",
                    ("reg_" + secrets.token_urlsafe(10), user_id, source,
                     int(payload.marketing_opt_in), _now_iso(), ua),
                )
        except sqlite3.IntegrityError as exc:
            if "users.email" in str(exc).lower() or "unique" in str(exc).lower():
                raise HTTPException(status_code=409, detail="email already registered") from exc
            raise
        _, signed, expires = _mint_session(user_id, user_agent=ua)
        _set_session_cookie(response, signed, expires)
        logger.info("user registered: %s (source=%s, marketing=%s)",
                    email, source, payload.marketing_opt_in)
        return {
            "user_id": user_id,
            "email":   email,
            "name":    payload.name.strip(),
            "marketing_opt_in": payload.marketing_opt_in,
        }

    @app.post("/api/auth/login")
    async def login(
        payload: LoginPayload,
        request: Request,
        response: Response,
    ) -> dict[str, Any]:
        email = _normalise_email(payload.email)
        with _open_db() as conn:
            row = conn.execute(
                "SELECT user_id, name, password_hash, marketing_opt_in "
                "FROM users WHERE email = ?",
                (email,),
            ).fetchone()
        # Constant-ish-time response: always run verify even on
        # missing user (with a known-bad hash) to avoid leaking
        # account existence via timing. bcrypt is slow enough that
        # the side channel is real.
        good_hash = row["password_hash"] if row else \
            "$2b$12$0000000000000000000000.0000000000000000000000000000000"
        ok = _verify_password(payload.password, good_hash) and row is not None
        if not ok:
            raise HTTPException(status_code=401, detail="invalid credentials")
        ua = request.headers.get("user-agent", "")[:200]
        _, signed, expires = _mint_session(row["user_id"], user_agent=ua)
        _set_session_cookie(response, signed, expires)
        return {
            "user_id": row["user_id"],
            "email":   email,
            "name":    row["name"],
            "marketing_opt_in": bool(row["marketing_opt_in"]),
        }

    @app.post("/api/auth/logout")
    async def logout(
        response: Response,
        odin_session: str | None = Cookie(default=None, alias=SESSION_COOKIE_NAME),
    ) -> dict[str, bool]:
        _delete_session(odin_session)
        _clear_session_cookie(response)
        return {"ok": True}

    @app.get("/api/auth/me")
    async def me(user: dict[str, Any] = Depends(require_user)) -> dict[str, Any]:
        return user

    @app.get("/api/users/me/boards")
    async def my_boards(
        user: dict[str, Any] = Depends(require_user),
        include_archived: bool = False,
    ) -> dict[str, Any]:
        # We compute session_count + archived_session_count + last_activity
        # in a single LEFT JOIN'd query so the management page can show
        # "what's in this board" without N+1 round-trips. last_activity
        # is the most recent push across live or archived rows — gives
        # the user a real "last touched" signal even after a board's
        # live cards have all aged out.
        sql = """
            SELECT b.board_id, b.created_at, b.last_seen, b.note, b.archived,
                   COALESCE(live.n, 0)    AS live_count,
                   COALESCE(arch.n, 0)    AS archived_count,
                   COALESCE(live.last, arch.last) AS last_activity
            FROM boards b
            LEFT JOIN (
                SELECT board_id, COUNT(*) AS n, MAX(updated_at) AS last
                FROM manifests GROUP BY board_id
            ) live ON live.board_id = b.board_id
            LEFT JOIN (
                SELECT board_id, COUNT(*) AS n, MAX(archived_at) AS last
                FROM archives GROUP BY board_id
            ) arch ON arch.board_id = b.board_id
            WHERE b.owner_user_id = ?
        """
        params: list[Any] = [user["user_id"]]
        if not include_archived:
            sql += " AND COALESCE(b.archived, 0) = 0"
        sql += " ORDER BY b.created_at DESC"

        with _open_db() as conn:
            rows = conn.execute(sql, params).fetchall()
        return {
            "items": [
                {
                    "board_id":              r["board_id"],
                    "created_at":            r["created_at"],
                    "last_seen":             r["last_seen"],
                    "note":                  r["note"],
                    "archived":              bool(r["archived"]),
                    "live_session_count":    int(r["live_count"]),
                    "archived_session_count": int(r["archived_count"]),
                    "last_activity":         r["last_activity"],
                    "url":                   f"/b/{r['board_id']}",
                }
                for r in rows
            ],
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
        received = _now_iso()
        updated  = payload.updated_at or received
        with _open_db() as conn:
            # Wrap the upsert + history append in one transaction so a
            # concurrent push for the same session can't observe a
            # half-applied state (and can't race on push_num).
            conn.execute("BEGIN IMMEDIATE")
            try:
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
                        updated, received,
                    ),
                )
                conn.execute(
                    """
                    INSERT INTO manifest_history
                        (board_id, session_id, push_num, payload, updated_at, received_at)
                    VALUES (
                        ?, ?,
                        COALESCE((SELECT MAX(push_num) + 1 FROM manifest_history
                                  WHERE board_id = ? AND session_id = ?), 1),
                        ?, ?, ?
                    )
                    """,
                    (
                        board["board_id"], payload.session_id,
                        board["board_id"], payload.session_id,
                        raw, updated, received,
                    ),
                )
                conn.execute("COMMIT")
            except Exception:
                conn.execute("ROLLBACK")
                raise
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

    # ---- archive / history helpers (shared by both auth flavours) ----

    def _archive_session_now(board_id: str, session_id: str) -> bool:
        """Move the live manifest into the archives table. Returns
        True on success, False if there was nothing to archive. History
        rows in manifest_history are left in place — they're keyed by
        (board_id, session_id) so the archive view can reconstruct the
        timeline by JOIN.

        Wrapped in BEGIN IMMEDIATE so we can't half-archive."""
        archived_at = _now_iso()
        with _open_db() as conn:
            conn.execute("BEGIN IMMEDIATE")
            try:
                row = conn.execute(
                    "SELECT payload FROM manifests WHERE board_id = ? AND session_id = ?",
                    (board_id, session_id),
                ).fetchone()
                if row is None:
                    conn.execute("ROLLBACK")
                    return False
                count = conn.execute(
                    "SELECT COUNT(*) AS n FROM manifest_history "
                    "WHERE board_id = ? AND session_id = ?",
                    (board_id, session_id),
                ).fetchone()["n"]
                conn.execute(
                    """
                    INSERT INTO archives (board_id, session_id, final_payload,
                                          archived_at, push_count)
                    VALUES (?, ?, ?, ?, ?)
                    ON CONFLICT(board_id, session_id) DO UPDATE SET
                        final_payload = excluded.final_payload,
                        archived_at   = excluded.archived_at,
                        push_count    = excluded.push_count
                    """,
                    (board_id, session_id, row["payload"], archived_at, count),
                )
                conn.execute(
                    "DELETE FROM manifests WHERE board_id = ? AND session_id = ?",
                    (board_id, session_id),
                )
                conn.execute("COMMIT")
            except Exception:
                conn.execute("ROLLBACK")
                raise
        return True

    def _nuke_session(board_id: str, session_id: str) -> bool:
        """The destructive option: delete the live row, all history,
        and any archive entry for this session. Used by DELETE."""
        with _open_db() as conn:
            conn.execute("BEGIN IMMEDIATE")
            try:
                cur = conn.execute(
                    "DELETE FROM manifests WHERE board_id = ? AND session_id = ?",
                    (board_id, session_id),
                )
                manifests_removed = cur.rowcount
                arch = conn.execute(
                    "DELETE FROM archives WHERE board_id = ? AND session_id = ?",
                    (board_id, session_id),
                ).rowcount
                conn.execute(
                    "DELETE FROM manifest_history WHERE board_id = ? AND session_id = ?",
                    (board_id, session_id),
                )
                conn.execute("COMMIT")
            except Exception:
                conn.execute("ROLLBACK")
                raise
        return (manifests_removed + arch) > 0

    def _list_archives_for_board(board_id: str) -> list[dict[str, Any]]:
        with _open_db() as conn:
            rows = conn.execute(
                """
                SELECT session_id, final_payload, archived_at, push_count
                FROM archives WHERE board_id = ?
                ORDER BY archived_at DESC
                LIMIT 500
                """,
                (board_id,),
            ).fetchall()
        items: list[dict[str, Any]] = []
        for r in rows:
            try:
                obj = json.loads(r["final_payload"])
            except json.JSONDecodeError:
                continue
            obj["archived_at"] = r["archived_at"]
            obj["push_count"]  = r["push_count"]
            obj["board_id"]    = board_id
            items.append(obj)
        return items

    def _fetch_history(board_id: str, session_id: str) -> list[dict[str, Any]]:
        """All pushes for one session, oldest first. Each entry is the
        decoded payload at that point in time, plus push_num and
        timestamps. The frontend uses this to re-render the card frame
        by frame during replay."""
        with _open_db() as conn:
            rows = conn.execute(
                """
                SELECT push_num, payload, updated_at, received_at
                FROM manifest_history
                WHERE board_id = ? AND session_id = ?
                ORDER BY push_num ASC
                LIMIT 5000
                """,
                (board_id, session_id),
            ).fetchall()
        out: list[dict[str, Any]] = []
        for r in rows:
            try:
                obj = json.loads(r["payload"])
            except json.JSONDecodeError:
                continue
            out.append({
                "push_num":    r["push_num"],
                "manifest":    obj,
                "updated_at":  r["updated_at"],
                "received_at": r["received_at"],
            })
        return out

    @app.delete("/api/manifests/{session_id}")
    async def delete_manifest(
        session_id: str,
        board: dict[str, Any] = Depends(require_board),
    ) -> dict[str, Any]:
        if not _nuke_session(board["board_id"], session_id):
            raise HTTPException(status_code=404, detail="not found")
        PUBSUB.publish(board["board_id"], "delete")
        return {"ok": True}

    @app.post("/api/manifests/{session_id}/archive")
    async def archive_manifest(
        session_id: str,
        board: dict[str, Any] = Depends(require_board),
    ) -> dict[str, Any]:
        if not _archive_session_now(board["board_id"], session_id):
            raise HTTPException(status_code=404, detail="not found")
        PUBSUB.publish(board["board_id"], "archive")
        return {"ok": True}

    @app.get("/api/archives")
    async def list_archives(
        board: dict[str, Any] = Depends(require_board),
    ) -> dict[str, Any]:
        return {"items": _list_archives_for_board(board["board_id"]),
                "board_id": board["board_id"]}

    @app.get("/api/manifests/{session_id}/history")
    async def manifest_history(
        session_id: str,
        board: dict[str, Any] = Depends(require_board),
    ) -> dict[str, Any]:
        items = _fetch_history(board["board_id"], session_id)
        if not items:
            raise HTTPException(status_code=404, detail="no history for this session")
        return {"items": items, "board_id": board["board_id"],
                "session_id": session_id}

    # ----------------- cookie-auth board access -----------------
    #
    # When a user is signed in AND owns the board, they can read it
    # without a bearer token — the session cookie is enough. This
    # exists alongside the bearer-token /api/manifests routes (which
    # the CLI uses) so a logged-in human never has to paste a token
    # to view their own boards. Tokens are still required for *push*
    # because the CLI uses them programmatically.

    def _require_owned_board(board_id: str, user: dict[str, Any]) -> dict[str, Any]:
        with _open_db() as conn:
            row = conn.execute(
                "SELECT board_id, created_at, note, owner_user_id "
                "FROM boards WHERE board_id = ?",
                (board_id,),
            ).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="board not found")
        if row["owner_user_id"] != user["user_id"]:
            # We deliberately return 404 (not 403) so a brute-force
            # board_id scan can't tell "this board exists but you
            # don't own it" from "this board doesn't exist".
            raise HTTPException(status_code=404, detail="board not found")
        return dict(row)

    @app.post("/api/boards/{board_id}/archive")
    async def archive_board(
        board_id: str,
        user: dict[str, Any] = Depends(require_user),
    ) -> dict[str, Any]:
        """Hide a board from the owner's default list. Idempotent. All
        sessions / history / archives inside the board are untouched —
        unarchiving restores the board with everything intact."""
        _require_owned_board(board_id, user)
        with _open_db() as conn:
            conn.execute(
                "UPDATE boards SET archived = 1 WHERE board_id = ?",
                (board_id,),
            )
        return {"ok": True}

    @app.post("/api/boards/{board_id}/unarchive")
    async def unarchive_board(
        board_id: str,
        user: dict[str, Any] = Depends(require_user),
    ) -> dict[str, Any]:
        _require_owned_board(board_id, user)
        with _open_db() as conn:
            conn.execute(
                "UPDATE boards SET archived = 0 WHERE board_id = ?",
                (board_id,),
            )
        return {"ok": True}

    @app.post("/api/boards/{board_id}/regenerate-token")
    async def regenerate_board_token(
        board_id: str,
        user: dict[str, Any] = Depends(require_user),
    ) -> dict[str, Any]:
        """Owner-only. Mint a fresh bearer token for an existing board.
        Old token is invalidated immediately (only token_hash is stored,
        so the previous plaintext is unrecoverable anyway — but we
        overwrite the hash with the new one's so any pasted-elsewhere
        copies of the old token instantly stop working).

        Returns the new token plaintext exactly once, same one-time
        reveal pattern as initial mint. The caller is responsible for
        showing it to the user with the standard "save this now" copy.
        Boards keep their board_id, owner, and all sessions/history."""
        _require_owned_board(board_id, user)
        new_token = secrets.token_urlsafe(32)
        with _open_db() as conn:
            cur = conn.execute(
                "UPDATE boards SET token_hash = ?, last_seen = ? WHERE board_id = ?",
                (_hash_token(new_token), _now_iso(), board_id),
            )
            if cur.rowcount == 0:
                # Lost a race with delete? Treat as 404 — the board is
                # gone, regenerate makes no sense.
                raise HTTPException(status_code=404, detail="board not found")
        return {
            "ok":       True,
            "board_id": board_id,
            "token":    new_token,
        }

    @app.delete("/api/boards/{board_id}")
    async def delete_board(
        board_id: str,
        user: dict[str, Any] = Depends(require_user),
    ) -> dict[str, Any]:
        """Cascade-delete EVERYTHING that references this board_id, then
        the board itself. Irreversible — there's no soft-delete here.
        Use POST /archive instead if the owner might want to come back.

        All four DELETE statements are wrapped in one BEGIN IMMEDIATE so
        a concurrent push for the same board can't slip a manifest row
        in between the cascade and the board removal (which would leave
        an orphan row that the next listing query would silently hide
        but the storage would still hold)."""
        _require_owned_board(board_id, user)
        with _open_db() as conn:
            conn.execute("BEGIN IMMEDIATE")
            try:
                conn.execute("DELETE FROM manifest_history WHERE board_id = ?", (board_id,))
                conn.execute("DELETE FROM archives        WHERE board_id = ?", (board_id,))
                conn.execute("DELETE FROM manifests       WHERE board_id = ?", (board_id,))
                conn.execute("DELETE FROM boards          WHERE board_id = ?", (board_id,))
                conn.execute("COMMIT")
            except Exception:
                conn.execute("ROLLBACK")
                raise
        PUBSUB.publish(board_id, "board-deleted")
        return {"ok": True}

    @app.get("/api/boards/{board_id}/manifests")
    async def list_manifests_for_owned(
        board_id: str,
        user: dict[str, Any] = Depends(require_user),
    ) -> dict[str, Any]:
        _require_owned_board(board_id, user)
        with _open_db() as conn:
            rows = conn.execute(
                """
                SELECT payload, received_at FROM manifests
                WHERE board_id = ?
                ORDER BY updated_at DESC
                LIMIT 500
                """,
                (board_id,),
            ).fetchall()
        items: list[dict[str, Any]] = []
        for r in rows:
            try:
                obj = json.loads(r["payload"])
            except json.JSONDecodeError:
                continue
            obj["received_at"] = r["received_at"]
            obj["board_id"]    = board_id
            items.append(obj)
        return {"items": items, "board_id": board_id}

    @app.delete("/api/boards/{board_id}/manifests/{session_id}")
    async def delete_manifest_for_owned(
        board_id: str,
        session_id: str,
        user: dict[str, Any] = Depends(require_user),
    ) -> dict[str, Any]:
        _require_owned_board(board_id, user)
        if not _nuke_session(board_id, session_id):
            raise HTTPException(status_code=404, detail="not found")
        PUBSUB.publish(board_id, "delete")
        return {"ok": True}

    @app.post("/api/boards/{board_id}/manifests/{session_id}/archive")
    async def archive_for_owned(
        board_id: str,
        session_id: str,
        user: dict[str, Any] = Depends(require_user),
    ) -> dict[str, Any]:
        _require_owned_board(board_id, user)
        if not _archive_session_now(board_id, session_id):
            raise HTTPException(status_code=404, detail="not found")
        PUBSUB.publish(board_id, "archive")
        return {"ok": True}

    @app.get("/api/boards/{board_id}/archives")
    async def list_archives_for_owned(
        board_id: str,
        user: dict[str, Any] = Depends(require_user),
    ) -> dict[str, Any]:
        _require_owned_board(board_id, user)
        return {"items": _list_archives_for_board(board_id), "board_id": board_id}

    @app.get("/api/boards/{board_id}/sessions/{session_id}/history")
    async def history_for_owned(
        board_id: str,
        session_id: str,
        user: dict[str, Any] = Depends(require_user),
    ) -> dict[str, Any]:
        _require_owned_board(board_id, user)
        items = _fetch_history(board_id, session_id)
        if not items:
            raise HTTPException(status_code=404, detail="no history for this session")
        return {"items": items, "board_id": board_id, "session_id": session_id}

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

        # SPA catch-all — every non-API path lands on index.html so the
        # client-side router can decide what to render. Anything under
        # /api/, /assets/, or /odin.png is handled by the explicit
        # routes above and never reaches this fallback.
        @app.get("/")
        @app.get("/login")
        @app.get("/register")
        @app.get("/me")
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

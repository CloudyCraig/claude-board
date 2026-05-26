import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LoginPage, MyAccountPage, RegisterPage } from "./Auth";
import {
  createBoard, fetchMe, fetchMyBoards, listManifests, listOwnedManifests,
  logoutUser, subscribePolling,
} from "./api";
import { layout, ringFor, type LaidOutCard } from "./Layout";
import {
  boardIdFromPath, clearLayout, forgetToken, loadLayout, loadToken,
  saveLayout, saveToken, type LayoutOverrides,
} from "./storage";
import type { Manifest, StoredBoard, User, UserBoard } from "./types";

/**
 * Top-level shell. URL drives mode:
 *
 *   /                    landing page (create-a-board)
 *   /login               sign-in form (Odin v2)
 *   /register            registration form (Odin v2)
 *   /me                  signed-in user's boards (Odin v2)
 *   /b/<board_id>        board view (needs token in localStorage; if
 *                        missing, prompts the visitor to paste it)
 *
 * No router — we read window.location directly and use plain links.
 * The app is small enough that pulling in react-router would be
 * caricature.
 */
export function App(): JSX.Element {
  const route = useMemo(() => detectRoute(), []);
  return (
    <div className="app">
      <Banner />
      <RouteBody route={route} />
    </div>
  );
}

type Route =
  | { kind: "landing" }
  | { kind: "login" }
  | { kind: "register" }
  | { kind: "me" }
  | { kind: "board"; boardId: string };

function detectRoute(): Route {
  const boardId = boardIdFromPath();
  if (boardId) return { kind: "board", boardId };
  const p = window.location.pathname.replace(/\/+$/, "");
  if (p === "/login")    return { kind: "login" };
  if (p === "/register") return { kind: "register" };
  if (p === "/me")       return { kind: "me" };
  return { kind: "landing" };
}

function RouteBody({ route }: { route: Route }): JSX.Element {
  switch (route.kind) {
    case "login":    return <LoginPage />;
    case "register": return <RegisterPage />;
    case "me":       return <MyAccountPage />;
    case "board":    return <BoardView boardId={route.boardId} />;
    case "landing":  return <Landing />;
  }
}

function Banner(): JSX.Element {
  // Run a one-shot fetchMe + fetchMyBoards so the banner can offer
  // a board picker without forcing every page to re-implement it.
  // 'undefined' means 'still loading' — we render nothing rather
  // than flicker login/logout affordances.
  const [me, setMe] = useState<User | null | undefined>(undefined);
  const [boards, setBoards] = useState<UserBoard[]>([]);

  useEffect(() => {
    let stopped = false;
    (async (): Promise<void> => {
      try {
        const u = await fetchMe();
        if (stopped) return;
        setMe(u);
        if (u) {
          const bs = await fetchMyBoards();
          if (!stopped) setBoards(bs);
        }
      } catch { /* ignore — banner is optional chrome */ }
    })();
    return () => { stopped = true; };
  }, []);

  const onLogout = async (): Promise<void> => {
    await logoutUser();
    window.location.assign("/");
  };

  return (
    <header className="banner">
      <a className="brand" href="/">
        <img src="/odin.png" alt="Odin's silhouette" />
        <span>Odin</span>
        <span className="tagline">· Claude Board</span>
      </a>
      {me && boards.length > 0 ? <BoardPicker boards={boards} /> : null}
      <div className="grow" />
      {me === undefined ? null : me ? (
        <>
          <a className="meta" href="/me">{me.name || me.email}</a>
          <button onClick={onLogout} style={{ marginLeft: 8 }}>sign out</button>
        </>
      ) : (
        <>
          <a className="meta" href="/login">sign in</a>
          <a className="meta" href="/register" style={{ marginLeft: 12 }}>register</a>
        </>
      )}
      <a className="meta" href="https://github.com/CloudyCraig/claude-board"
         target="_blank" rel="noreferrer" style={{ marginLeft: 16 }}>
        self-host on GitHub
      </a>
    </header>
  );
}

/** Native <select> board picker. Keeps it accessible and zero-dep —
 *  no custom dropdown widget. Defaults to "(switch board)" so an
 *  accidental click doesn't navigate. */
function BoardPicker({ boards }: { boards: UserBoard[] }): JSX.Element {
  const currentBoardId = boardIdFromPath();
  return (
    <select
      className="board-picker"
      value={currentBoardId ?? ""}
      onChange={(e) => {
        const id = e.target.value;
        if (id) window.location.assign(`/b/${id}`);
      }}
      title="Switch to one of your boards"
    >
      {!currentBoardId
        ? <option value="">(switch board…)</option>
        : null}
      {boards.map((b) => (
        <option key={b.board_id} value={b.board_id}>
          {b.note || b.board_id}
        </option>
      ))}
    </select>
  );
}

// ----------------- landing -----------------

function Landing(): JSX.Element {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ board_id: string; token: string } | null>(null);
  const [err, setErr] = useState<string>("");

  const onCreate = async (): Promise<void> => {
    setBusy(true); setErr("");
    try {
      const r = await createBoard(note);
      saveToken({ board_id: r.board_id, token: r.token, server: window.location.origin });
      setResult({ board_id: r.board_id, token: r.token });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const boardUrl = result ? `${window.location.origin}/b/${result.board_id}` : "";

  // The CLAUDE.md snippet uses backticks for shell + a heredoc to make
  // copy-pasting forgiving. The snippet itself does three things:
  //   1. Write the local config file with the user's server+token.
  //   2. Teach future Claude sessions to update ~/.claude-board/<id>.json
  //      on every TaskCreate / TaskUpdate / mark_chapter / AskUserQuestion.
  //   3. Push after each write via `claude-board push --session-id <id>`.
  const snippet = result ? buildClaudeMdSnippet(window.location.origin, result.token, result.board_id) : "";

  return (
    <main className="landing">
      <section className="hero">
        <div className="portrait"><img src="/odin.png" alt="Odin" /></div>
        <div>
          <h1>The board that watches the boards.</h1>
          <p>
            Live view of every Claude session you're running — across projects, terminals,
            phones, IDEs. See what's active, what's idle, and the one thing waiting on you.
            Heimdall stands the watch; you stay in flow.
          </p>
        </div>
      </section>

      <section className="create">
        <h2>Create your board</h2>
        <p style={{ color: "var(--text-mute)", marginTop: 0 }}>
          One click mints a board ID and a bearer token. Treat the token like a password —
          it's the only credential. Lose it, mint another.
        </p>
        <p style={{ color: "var(--text-mute)", marginTop: 0, fontSize: 13 }}>
          Prefer to keep all your boards in one place? <a href="/register">Create an Odin
          account</a> — boards minted while signed in are remembered in your dashboard.
        </p>
        <label htmlFor="note">Label (optional)</label>
        <input
          id="note" type="text" placeholder="e.g. craig's main"
          value={note} onChange={(e) => setNote(e.target.value)}
          style={{ width: "100%" }}
        />
        {err ? <div className="error-banner">{err}</div> : null}
        {!result ? (
          <div style={{ marginTop: 16 }}>
            <button className="primary" disabled={busy} onClick={onCreate}>
              {busy ? "minting…" : "create board"}
            </button>
          </div>
        ) : (
          <>
            <div className="token-reveal">
              <div className="label">Bearer token (shown once)</div>
              <div>{result.token}</div>
              <div className="warn">⚠ copy this now — there is no recovery.</div>
            </div>
            <label>Your board URL</label>
            <div className="copy-row">
              <input type="text" readOnly value={boardUrl} style={{ flex: 1 }} onFocus={(e) => e.currentTarget.select()} />
              <button onClick={() => navigator.clipboard?.writeText(boardUrl)}>copy</button>
              <a href={boardUrl}><button className="primary">open →</button></a>
            </div>
            <label>Paste into your <code>~/.claude/CLAUDE.md</code></label>
            <pre className="snippet">{snippet}</pre>
            <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
              <button onClick={() => navigator.clipboard?.writeText(snippet)}>copy snippet</button>
            </div>
          </>
        )}
      </section>
    </main>
  );
}

function buildClaudeMdSnippet(server: string, token: string, boardId: string): string {
  // The snippet is deliberately verbose because future Claude sessions
  // will read it cold — better an extra paragraph than an ambiguous
  // one-liner that leads to "why doesn't my board update?"
  return `## Claude Board (orchestration view)

You report status to my Claude Board so I can see every session at a glance.

**Config** — already saved at ~/.claude/board.config (mode 0600):

    server   = ${server}
    token    = ${token}
    board_id = ${boardId}

**Manifest convention** — every session owns one JSON file at
\`~/.claude-board/<session_id>.json\` (use a ULID for session_id).
The manifest shape lives at ${server}/docs/manifest-spec or in the
repo's docs/manifest-spec.md. Required fields: session_id, title,
status, updated_at. Strongly recommended: project, current_chapter,
blocked_on_user, blocked_reason, tasks[], depends_on[].

**When to update** — refresh the manifest on each of these moments:
  • TaskCreate / TaskUpdate (refresh tasks[])
  • mark_chapter           (set current_chapter)
  • AskUserQuestion        (set blocked_on_user=true + blocked_reason="<the question>")
  • end of session         (status="done")

**After each update**, run: \`claude-board push --session-id <id>\`.
The push is idempotent. If the CLI isn't installed, install with:
\`pipx install git+https://github.com/CloudyCraig/claude-board#subdirectory=cli\`.
`;
}

// ----------------- board view -----------------

function BoardView({ boardId }: { boardId: string }): JSX.Element {
  // Three possible auth modes for this view, decided once at mount:
  //   1. cookie — logged-in user owns this board (preferred — no
  //      token prompt, ever)
  //   2. token  — anonymous OR not-owner; use the bearer token from
  //      localStorage; prompt if missing
  //   3. probing — still figuring it out; render nothing to avoid
  //      flicker
  type Mode = "cookie" | "token" | "probing";
  const [mode, setMode] = useState<Mode>("probing");
  const [board, setBoard] = useState<StoredBoard | null>(() => loadToken(boardId));
  const [manifests, setManifests] = useState<Manifest[]>([]);
  const [err, setErr] = useState<string>("");
  const [lastRefreshed, setLastRefreshed] = useState<number>(0);
  const [refreshing, setRefreshing] = useState<boolean>(false);
  const refreshRef = useRef<() => Promise<void>>(async () => {});

  // Probe: try cookie auth first. If 401/404 we fall back to token.
  useEffect(() => {
    let stopped = false;
    (async (): Promise<void> => {
      try {
        const data = await listOwnedManifests(boardId);
        if (stopped) return;
        setManifests(data.items);
        setLastRefreshed(Date.now());
        setErr("");
        setMode("cookie");
      } catch (e) {
        if (stopped) return;
        // Either not signed in, or signed in but not the owner.
        // Fall back to the token flow.
        setMode("token");
      }
    })();
    return () => { stopped = true; };
  }, [boardId]);

  // Cookie-auth refresh loop.
  useEffect(() => {
    if (mode !== "cookie") return;
    let stopped = false;
    const refresh = async (): Promise<void> => {
      try {
        setRefreshing(true);
        const data = await listOwnedManifests(boardId);
        if (!stopped) {
          setManifests(data.items);
          setLastRefreshed(Date.now());
          setErr("");
        }
      } catch (e) {
        if (!stopped) setErr((e as Error).message);
      } finally {
        if (!stopped) setRefreshing(false);
      }
    };
    refreshRef.current = refresh;
    // We pass an empty string for the token since subscribePolling
    // doesn't actually use it (only the callback matters).
    const unsub = subscribePolling("", refresh, 5000);
    return () => { stopped = true; unsub(); };
  }, [mode, boardId]);

  // Token-auth refresh loop.
  useEffect(() => {
    if (mode !== "token" || !board) return;
    let stopped = false;
    const refresh = async (): Promise<void> => {
      try {
        setRefreshing(true);
        const data = await listManifests(board.token);
        if (!stopped) {
          setManifests(data.items);
          setLastRefreshed(Date.now());
          setErr("");
        }
      } catch (e) {
        if (!stopped) setErr((e as Error).message);
      } finally {
        if (!stopped) setRefreshing(false);
      }
    };
    refreshRef.current = refresh;
    const unsub = subscribePolling(board.token, refresh, 5000);
    return () => { stopped = true; unsub(); };
  }, [mode, board]);

  if (mode === "probing") {
    return <main className="board"><div className="stage" /></main>;
  }

  if (mode === "token" && !board) {
    return <TokenPrompt boardId={boardId} onSaved={(b) => { setBoard(b); }} />;
  }

  if (err === "unauthorized") {
    return (
      <main className="empty">
        <h2>Token rejected.</h2>
        <p className="hint">
          The token in this browser doesn't match this board. The owner may have rotated it,
          or you opened the wrong board URL.
        </p>
        <button onClick={() => { forgetToken(boardId); setBoard(null); }}>
          forget + re-enter token
        </button>
      </main>
    );
  }

  return (
    <Board
      boardId={boardId}
      manifests={manifests}
      onRefresh={() => refreshRef.current()}
      refreshing={refreshing}
      lastRefreshed={lastRefreshed}
      authMode={mode}
    />
  );
}

function TokenPrompt({
  boardId, onSaved,
}: {
  boardId: string;
  onSaved: (b: StoredBoard) => void;
}): JSX.Element {
  const [token, setToken] = useState("");
  return (
    <main className="landing">
      <section className="create" style={{ maxWidth: 540 }}>
        <h2>Open board <code>{boardId}</code></h2>
        <p style={{ color: "var(--text-mute)" }}>
          This browser doesn't have a token cached for this board. Paste the bearer token
          you saved when you minted it.
        </p>
        <label>Bearer token</label>
        <input
          type="text" autoFocus value={token}
          onChange={(e) => setToken(e.target.value.trim())}
          placeholder="brd-token..."
          style={{ width: "100%" }}
        />
        <div style={{ marginTop: 16 }}>
          <button
            className="primary"
            disabled={!token}
            onClick={() => {
              const b = { board_id: boardId, token, server: window.location.origin };
              saveToken(b);
              onSaved(b);
            }}
          >
            open board
          </button>
        </div>
      </section>
    </main>
  );
}

// ----------------- the stage -----------------

function Board({
  boardId, manifests, onRefresh, refreshing, lastRefreshed, authMode,
}: {
  boardId: string;
  manifests: Manifest[];
  onRefresh: () => void;
  refreshing: boolean;
  lastRefreshed: number;
  authMode: "cookie" | "token";
}): JSX.Element {
  const stageRef = useRef<HTMLDivElement>(null);
  const [dims, setDims] = useState<{ w: number; h: number }>({ w: 1200, h: 700 });

  // Per-board persistent drag overrides. Override map is session_id
  // → {x, y} in absolute stage-pixel coordinates of the card centre.
  const [overrides, setOverrides] = useState<LayoutOverrides>(
    () => loadLayout(boardId),
  );

  // The stage resize tracks the container so the polar layout
  // expands and contracts gracefully. ResizeObserver fires once on
  // mount + on every parent resize.
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setDims({ w: el.clientWidth, h: el.clientHeight });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Stable auto-layout. Drag overrides apply on top.
  const placed = useMemo(() => layout(manifests, dims.w, dims.h), [manifests, dims]);

  // Merge auto-layout with overrides. We don't mutate `placed` — we
  // produce a fresh array because rendering cares about identity.
  const positioned = useMemo<LaidOutCard[]>(
    () => placed.map((c) => {
      const o = overrides[c.manifest.session_id];
      return o ? { ...c, x: o.x, y: o.y } : c;
    }),
    [placed, overrides],
  );

  // Build an index from session_id → position so we can draw edges
  // that follow dragged cards.
  const positionsBySession = useMemo(() => {
    const m = new Map<string, LaidOutCard>();
    for (const p of positioned) m.set(p.manifest.session_id, p);
    return m;
  }, [positioned]);

  // Persisted callback so SessionCard doesn't re-mount drag handlers
  // every render.
  const commitDrag = useCallback((sessionId: string, x: number, y: number) => {
    setOverrides((prev) => {
      const next = { ...prev, [sessionId]: { x, y } };
      saveLayout(boardId, next);
      return next;
    });
  }, [boardId]);

  const resetLayout = useCallback(() => {
    clearLayout(boardId);
    setOverrides({});
  }, [boardId]);

  const hasOverrides = Object.keys(overrides).length > 0;

  if (manifests.length === 0) {
    return (
      <main className="board">
        <div className="stage" ref={stageRef}>
          <StageToolbar
            onRefresh={onRefresh} refreshing={refreshing} lastRefreshed={lastRefreshed}
            onResetLayout={resetLayout} hasOverrides={hasOverrides}
            authMode={authMode}
          />
          <div className="odin-centre">
            <img src="/odin.png" alt="Odin" />
            <div className="label">no sessions yet · push a manifest to begin</div>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="board">
      <div className="stage" ref={stageRef}>
        <StageToolbar
          onRefresh={onRefresh} refreshing={refreshing} lastRefreshed={lastRefreshed}
          onResetLayout={resetLayout} hasOverrides={hasOverrides}
          authMode={authMode}
        />
        <div className="odin-centre">
          <img src="/odin.png" alt="Odin" />
          <div className="label">heimdall stands the watch</div>
        </div>

        {/* Dependency edges live on an SVG behind the cards. */}
        <svg className="edges" width={dims.w} height={dims.h}>
          {positioned.flatMap((p) =>
            (p.manifest.depends_on ?? []).map((dep, i) => {
              const other = positionsBySession.get(dep);
              if (!other) return null;
              // Curve through the centre area so edges feel like
              // they radiate from Odin rather than crossing him.
              const mx = (p.x + other.x) / 2;
              const my = (p.y + other.y) / 2;
              const ctrlX = mx + (mx - dims.w / 2) * -0.3;
              const ctrlY = my + (my - dims.h / 2) * -0.3;
              const d = `M ${p.x} ${p.y} Q ${ctrlX} ${ctrlY} ${other.x} ${other.y}`;
              const isBlocked = p.manifest.status === "blocked";
              return <path key={`${p.manifest.session_id}-${dep}-${i}`} d={d} className={isBlocked ? "blocked" : ""} />;
            }),
          )}
        </svg>

        {positioned.map((p) => (
          <SessionCard
            key={p.manifest.session_id}
            card={p}
            stageRef={stageRef}
            overridden={!!overrides[p.manifest.session_id]}
            onDragEnd={(x, y) => commitDrag(p.manifest.session_id, x, y)}
          />
        ))}
      </div>
    </main>
  );
}

// ----------------- toolbar (refresh + reset layout) -----------------

function StageToolbar({
  onRefresh, refreshing, lastRefreshed, onResetLayout, hasOverrides, authMode,
}: {
  onRefresh: () => void;
  refreshing: boolean;
  lastRefreshed: number;
  onResetLayout: () => void;
  hasOverrides: boolean;
  authMode: "cookie" | "token";
}): JSX.Element {
  // Force a re-render every 5 seconds so the "Xs ago" stamp stays
  // honest. (Anything coarser and the user can't tell whether the
  // polling is actually live.)
  const [, force] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => force((n) => n + 1), 5_000);
    return () => window.clearInterval(id);
  }, []);

  const ago = lastRefreshed
    ? `updated ${relativeTime(new Date(lastRefreshed).toISOString())}`
    : "—";

  return (
    <div className="stage-toolbar">
      <span
        className={"auto-indicator " + (refreshing ? "pulse" : "")}
        title="The board polls the server every 5 seconds. The dot pulses on each fetch."
      >
        <span className="dot" />
        <span>auto · 5s</span>
      </span>
      <span className="meta" title={authMode === "cookie"
        ? "Signed in — no token needed for this board"
        : "Anonymous — using a bearer token from this browser"}>
        {ago}
      </span>
      <button
        className="ghost"
        onClick={onRefresh}
        disabled={refreshing}
        title="Refresh now (the 5-second poll is still running in the background)"
      >
        {refreshing ? "refreshing…" : "↻ refresh now"}
      </button>
      {hasOverrides ? (
        <button
          className="ghost"
          onClick={onResetLayout}
          title="Snap every card back to its auto-layout position"
        >
          reset layout
        </button>
      ) : null}
    </div>
  );
}

// ----------------- card (with drag) -----------------

function SessionCard({
  card, stageRef, overridden, onDragEnd,
}: {
  card: LaidOutCard;
  stageRef: React.RefObject<HTMLDivElement>;
  overridden: boolean;
  onDragEnd: (x: number, y: number) => void;
}): JSX.Element {
  const m = card.manifest;
  const cardRef = useRef<HTMLDivElement>(null);

  // Drag state. We use pointer events so this works on touch + mouse
  // out of the box, including the trackpad on the Heimdall Claude
  // Control desktop window.
  //
  // Position-during-drag is kept in component state (so motion is
  // smooth) and only committed to the parent on pointerup (so we
  // don't thrash localStorage on every pixel).
  const [dragPos, setDragPos] = useState<{ x: number; y: number } | null>(null);
  const dragOffset = useRef<{ dx: number; dy: number } | null>(null);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    // Only respond to primary button; ignore right-click etc.
    if (e.button !== 0) return;
    const el = cardRef.current;
    const stage = stageRef.current;
    if (!el || !stage) return;
    const stageBox = stage.getBoundingClientRect();
    // Centre of the card relative to the stage.
    const cx = e.clientX - stageBox.left;
    const cy = e.clientY - stageBox.top;
    dragOffset.current = { dx: cx - card.x, dy: cy - card.y };
    el.setPointerCapture(e.pointerId);
    setDragPos({ x: card.x, y: card.y });
    e.preventDefault();
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!dragOffset.current) return;
    const stage = stageRef.current;
    if (!stage) return;
    const stageBox = stage.getBoundingClientRect();
    const cx = e.clientX - stageBox.left;
    const cy = e.clientY - stageBox.top;
    // Half-card padding so a card can't drift fully off the stage.
    const padX = 140 + 6;
    const padY = 85 + 6;
    const x = Math.max(padX, Math.min(stage.clientWidth  - padX, cx - dragOffset.current.dx));
    const y = Math.max(padY, Math.min(stage.clientHeight - padY, cy - dragOffset.current.dy));
    setDragPos({ x, y });
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!dragOffset.current || !dragPos) return;
    const el = cardRef.current;
    if (el && el.hasPointerCapture(e.pointerId)) {
      el.releasePointerCapture(e.pointerId);
    }
    dragOffset.current = null;
    onDragEnd(dragPos.x, dragPos.y);
    setDragPos(null);
  };

  const onDoubleClick = (): void => {
    // Convenience: double-click resets just this card (only if it
    // has been dragged). Plain click stays free for future select-
    // a-card affordances.
    if (overridden) onDragEnd(card.x, card.y);   // parent will replace, but…
  };

  const chipClass =
    m.blocked_on_user ? "blocked" :
    m.status === "blocked" || m.status === "idle" ? m.status :
    m.status === "done" ? "done" :
    "active";
  const chipLabel = m.blocked_on_user ? "needs you" : m.status;

  const taskPips = (m.tasks ?? []).map((t) => {
    const cls =
      t.status === "completed" ? "done" :
      t.status === "in_progress" ? "active" :
      "pending";
    return <span key={t.id} className={`pip ${cls}`} title={`${t.status}: ${t.title}`} />;
  });

  // Position: drag-in-progress overrides everything else.
  const x = dragPos ? dragPos.x : card.x;
  const y = dragPos ? dragPos.y : card.y;
  const dragging = dragPos !== null;

  const cls = [
    "card",
    m.blocked_on_user ? "blocked-on-user" : "",
    dragging         ? "dragging"         : "",
    overridden       ? "overridden"       : "",
  ].filter(Boolean).join(" ");

  return (
    <div
      ref={cardRef}
      className={cls}
      style={{ left: x, top: y }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={onDoubleClick}
      title={overridden ? "Drag to move · double-click to snap back" : "Drag to move"}
    >
      <div className="head">
        <div className="title" title={m.title}>{m.title || "(untitled)"}</div>
        <span className={`chip ${chipClass}`}>{chipLabel}</span>
      </div>
      {m.project ? <div className="head"><span className="project">{m.project}</span></div> : null}
      {m.current_chapter ? <div className="chapter">↳ {m.current_chapter}</div> : null}
      {taskPips.length > 0 ? <div className="tasks">{taskPips}</div> : null}
      {m.blocked_on_user && m.blocked_reason ? (
        <div className="blocked-banner">{m.blocked_reason}</div>
      ) : null}
      <DeepLinks manifest={m} />
      <div className="footer">
        <span>ring {ringFor(m)}</span>
        <span>{relativeTime(m.updated_at)}</span>
      </div>
    </div>
  );
}

/**
 * Per-card deep-link badges. Three possible affordances, all optional:
 *
 *   • An explicit ↗ link to whatever URL the user set via `claude_url`
 *     in the manifest. Typically a Remote Control session URL pasted
 *     after running `/rc` — opens the running session directly on iOS
 *     via the Claude app, or in claude.ai web. Wins when present.
 *
 *   • An "Open in Claude Code" badge that fires the macOS deep-link
 *     scheme `claude-cli://open?cwd=…&q=Resume <chapter>`. Opens the
 *     Claude Code app in the right project with a one-line resume
 *     prompt. Not a true session-resume — Claude Code doesn't expose
 *     that yet (Anthropic issues #47018 / #25642) — but the closest
 *     approximation given current platform constraints.
 *
 *   • An "Open on claude.ai" badge linking to the global
 *     https://claude.ai/code list. Works in any browser including
 *     iOS / iPad Safari; the user finds the session by name from the
 *     Remote-Control list. The catch-all.
 *
 * Click handlers stopPropagation so the drag handler on the card
 * body doesn't fire when the user is trying to follow a link.
 */
function DeepLinks({ manifest: m }: { manifest: Manifest }): JSX.Element | null {
  const stop = (e: React.MouseEvent | React.PointerEvent) => e.stopPropagation();

  // If the user set an explicit claude_url, that's authoritative.
  // Render only it — extra badges would just compete.
  if (m.claude_url) {
    return (
      <div className="card-links">
        <a className="card-link primary" href={m.claude_url}
           onClick={stop} onPointerDown={stop}
           target="_blank" rel="noreferrer"
           title="Open the explicit Claude URL set on this manifest">
          ↗ open in claude
        </a>
      </div>
    );
  }

  const dir = m.project_dir;
  const chapter = m.current_chapter || "session";
  // claude-cli://open takes either `cwd=` (absolute path) or
  // `repo=owner/name`. We have the path; the chapter becomes the
  // resume prompt the new Claude Code session opens with.
  const desktopUrl = dir
    ? `claude-cli://open?cwd=${encodeURIComponent(dir)}&q=${encodeURIComponent(`Resume — ${chapter}`)}`
    : null;
  const webUrl = "https://claude.ai/code";

  if (!desktopUrl) {
    // No project dir → only the catch-all browser link makes sense.
    return (
      <div className="card-links">
        <a className="card-link" href={webUrl}
           onClick={stop} onPointerDown={stop}
           target="_blank" rel="noreferrer"
           title="Open the claude.ai sessions list (any device)">
          🌐 claude.ai/code
        </a>
      </div>
    );
  }

  return (
    <div className="card-links">
      <a className="card-link" href={desktopUrl}
         onClick={stop} onPointerDown={stop}
         title={`Open Claude Code in ${dir}`}>
        ↗ claude code
      </a>
      <a className="card-link" href={webUrl}
         onClick={stop} onPointerDown={stop}
         target="_blank" rel="noreferrer"
         title="Open the claude.ai sessions list (works on iOS / iPad / any browser)">
        🌐 claude.ai
      </a>
    </div>
  );
}

function relativeTime(iso: string): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  const secs = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.round(secs / 3600)}h ago`;
  return `${Math.round(secs / 86400)}d ago`;
}

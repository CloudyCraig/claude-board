import { useEffect, useMemo, useRef, useState } from "react";
import { LoginPage, MyAccountPage, RegisterPage } from "./Auth";
import { createBoard, fetchMe, listManifests, logoutUser, subscribePolling } from "./api";
import { layout, ringFor, type LaidOutCard } from "./Layout";
import { boardIdFromPath, forgetToken, loadToken, saveToken } from "./storage";
import type { Manifest, StoredBoard, User } from "./types";

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
  // The banner runs a one-shot fetchMe so it can show the "Signed
  // in as …" affordance without forcing every page to re-implement
  // it. We treat 'undefined' as 'still loading' and don't render
  // either affordance to avoid flicker.
  const [me, setMe] = useState<User | null | undefined>(undefined);
  useEffect(() => {
    let stopped = false;
    fetchMe().then((u) => { if (!stopped) setMe(u); }).catch(() => { /* ignore */ });
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
  const [board, setBoard] = useState<StoredBoard | null>(() => loadToken(boardId));
  const [manifests, setManifests] = useState<Manifest[]>([]);
  const [err, setErr] = useState<string>("");

  useEffect(() => {
    if (!board) return;
    let stopped = false;

    const refresh = async (): Promise<void> => {
      try {
        const data = await listManifests(board.token);
        if (!stopped) {
          setManifests(data.items);
          setErr("");
        }
      } catch (e) {
        if (!stopped) setErr((e as Error).message);
      }
    };

    const unsub = subscribePolling(board.token, refresh, 5000);
    return () => { stopped = true; unsub(); };
  }, [board]);

  if (!board) {
    return <TokenPrompt boardId={boardId} onSaved={setBoard} />;
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

  return <Board manifests={manifests} />;
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

function Board({ manifests }: { manifests: Manifest[] }): JSX.Element {
  const stageRef = useRef<HTMLDivElement>(null);
  const [dims, setDims] = useState<{ w: number; h: number }>({ w: 1200, h: 700 });

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

  // Stable ordering before layout so the per-ring index doesn't jump
  // around when a card moves rings. Sort by session_id alphabetically.
  const sorted = useMemo(
    () => [...manifests].sort((a, b) => a.session_id.localeCompare(b.session_id)),
    [manifests],
  );
  const placed = useMemo(() => layout(sorted, dims.w, dims.h), [sorted, dims]);

  // Build an index from session_id → position so we can draw edges.
  const positionsBySession = useMemo(() => {
    const m = new Map<string, LaidOutCard>();
    for (const p of placed) m.set(p.manifest.session_id, p);
    return m;
  }, [placed]);

  if (manifests.length === 0) {
    return (
      <main className="board">
        <div className="stage" ref={stageRef}>
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
        <div className="odin-centre">
          <img src="/odin.png" alt="Odin" />
          <div className="label">heimdall stands the watch</div>
        </div>

        {/* Dependency edges live on an SVG behind the cards. */}
        <svg className="edges" width={dims.w} height={dims.h}>
          {placed.flatMap((p) =>
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

        {placed.map((p) => (
          <SessionCard key={p.manifest.session_id} card={p} />
        ))}
      </div>
    </main>
  );
}

function SessionCard({ card }: { card: LaidOutCard }): JSX.Element {
  const m = card.manifest;
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

  return (
    <div
      className={"card " + (m.blocked_on_user ? "blocked-on-user" : "")}
      style={{ left: card.x, top: card.y }}
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
      <div className="footer">
        <span>ring {ringFor(m)}</span>
        <span>{relativeTime(m.updated_at)}</span>
      </div>
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

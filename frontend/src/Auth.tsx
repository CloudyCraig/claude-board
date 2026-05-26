/**
 * Odin v2 auth pages: Login, Register, and the My Account view that
 * lists the user's boards. Self-contained — App.tsx just routes to
 * the right one based on path.
 *
 * Design choices:
 *  • A single shared <AuthCard> wrapper so register/login look like
 *    the same surface; reduces visual whiplash mid-flow.
 *  • Errors are surfaced in-card, not as toasts — the user is doing
 *    one thing at a time, so the error belongs next to the form.
 *  • Registration auto-logs the user in (server sets cookie), so we
 *    redirect straight to /me on success rather than bouncing through
 *    a "now log in" page.
 *  • Marketing-opt-in tickbox text is explicit about what it's for,
 *    per Craig's wording.
 */

import { useCallback, useEffect, useState } from "react";
import {
  archiveBoard, deleteBoard, fetchMe, fetchMyBoards, loginUser,
  logoutUser, registerUser, unarchiveBoard,
} from "./api";
import type { User, UserBoard } from "./types";

export function AuthCard({
  title, subtitle, children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <main className="landing">
      <section className="create" style={{ maxWidth: 480 }}>
        <h2 style={{ marginTop: 0 }}>{title}</h2>
        {subtitle ? (
          <p style={{ color: "var(--text-mute)", marginTop: 0 }}>{subtitle}</p>
        ) : null}
        {children}
      </section>
    </main>
  );
}

// ----------------- Register -----------------

export function RegisterPage(): JSX.Element {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [marketing, setMarketing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  // Honor ?source=desktop so the registrations table can tell us
  // whether someone signed up through the Heimdall Claude Control
  // app or via the public web. Whitelist the values rather than
  // letting any string through.
  const source: "web" | "desktop" | "cli" = (() => {
    const raw = new URLSearchParams(window.location.search).get("source") ?? "";
    return raw === "desktop" || raw === "cli" ? raw : "web";
  })();

  const onSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setBusy(true); setErr("");
    try {
      await registerUser({
        name: name.trim(), email: email.trim(),
        password, marketing_opt_in: marketing, source,
      });
      window.location.assign("/me");
    } catch (ex) {
      setErr((ex as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const subtitle = source === "desktop"
    ? "Welcome to Heimdall Claude Control. One quick registration and the desktop app stays signed in — no token wrangling."
    : "An account groups your boards and remembers them across devices. You can still use Odin anonymously with a per-board token if you prefer.";

  return (
    <AuthCard
      title="Create your Odin account"
      subtitle={subtitle}
    >
      <form onSubmit={onSubmit}>
        <label htmlFor="reg-name">Name</label>
        <input id="reg-name" type="text" required value={name}
               autoComplete="name"
               onChange={(e) => setName(e.target.value)}
               style={{ width: "100%" }} />
        <label htmlFor="reg-email" style={{ marginTop: 12 }}>Email</label>
        <input id="reg-email" type="email" required value={email}
               autoComplete="email"
               onChange={(e) => setEmail(e.target.value)}
               style={{ width: "100%" }} />
        <label htmlFor="reg-pw" style={{ marginTop: 12 }}>
          Password <span style={{ color: "var(--text-mute)" }}>(8+ characters)</span>
        </label>
        <input id="reg-pw" type="password" required minLength={8}
               autoComplete="new-password"
               value={password}
               onChange={(e) => setPassword(e.target.value)}
               style={{ width: "100%" }} />
        <label style={{ display: "flex", gap: 8, marginTop: 16, alignItems: "flex-start" }}>
          <input type="checkbox" checked={marketing}
                 onChange={(e) => setMarketing(e.target.checked)}
                 style={{ marginTop: 4 }} />
          <span>
            I'm open to hearing about new and existing Heimdall products
            (Huginn, Muninn, Vor, Skald, Lumiq). No more than a few emails a year.
          </span>
        </label>
        {err ? <div className="error-banner">{err}</div> : null}
        <div style={{ marginTop: 16, display: "flex", gap: 12, alignItems: "center" }}>
          <button className="primary" type="submit" disabled={busy}>
            {busy ? "creating…" : "create account"}
          </button>
          <a href="/login" style={{ color: "var(--text-mute)" }}>
            already have one? sign in
          </a>
        </div>
      </form>
    </AuthCard>
  );
}

// ----------------- Login -----------------

export function LoginPage(): JSX.Element {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const onSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setBusy(true); setErr("");
    try {
      await loginUser(email.trim(), password);
      window.location.assign("/me");
    } catch (ex) {
      setErr((ex as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthCard title="Sign in to Odin">
      <form onSubmit={onSubmit}>
        <label htmlFor="login-email">Email</label>
        <input id="login-email" type="email" required value={email}
               autoComplete="email"
               onChange={(e) => setEmail(e.target.value)}
               style={{ width: "100%" }} />
        <label htmlFor="login-pw" style={{ marginTop: 12 }}>Password</label>
        <input id="login-pw" type="password" required value={password}
               autoComplete="current-password"
               onChange={(e) => setPassword(e.target.value)}
               style={{ width: "100%" }} />
        {err ? <div className="error-banner">{err}</div> : null}
        <div style={{ marginTop: 16, display: "flex", gap: 12, alignItems: "center" }}>
          <button className="primary" type="submit" disabled={busy}>
            {busy ? "signing in…" : "sign in"}
          </button>
          <a href="/register" style={{ color: "var(--text-mute)" }}>
            no account yet? register
          </a>
        </div>
      </form>
    </AuthCard>
  );
}

// ----------------- My Account -----------------

export function MyAccountPage(): JSX.Element {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const [boards, setBoards] = useState<UserBoard[]>([]);
  const [err, setErr] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  // Per-row pending state for visual feedback. Keyed by board_id so a
  // slow delete doesn't block other rows from being acted on. We
  // intentionally don't reuse a single global flag — boards are
  // independent and the user might want to fire off multiple actions.
  const [pending, setPending] = useState<Record<string, "archiving" | "unarchiving" | "deleting" | undefined>>({});

  const refresh = useCallback(async (includeArchived: boolean) => {
    try {
      const bs = await fetchMyBoards(includeArchived);
      setBoards(bs);
      setErr("");
    } catch (ex) {
      setErr((ex as Error).message);
    }
  }, []);

  useEffect(() => {
    let stopped = false;
    (async (): Promise<void> => {
      try {
        const me = await fetchMe();
        if (stopped) return;
        if (!me) {
          // Not logged in — bounce to login. The desktop app's
          // first-launch flow guarantees we're logged in by the time
          // we land here, but the web flow can hit /me cold.
          window.location.assign("/login");
          return;
        }
        setUser(me);
        await refresh(showArchived);
      } catch (ex) {
        if (!stopped) setErr((ex as Error).message);
      }
    })();
    return () => { stopped = true; };
    // We deliberately don't depend on showArchived here; the toggle
    // handler below calls refresh() explicitly so we can mark pending
    // state without racing this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (user === undefined) {
    return <AuthCard title="loading…"><div /></AuthCard>;
  }
  if (user === null) return <LoginPage />;

  const onLogout = async (): Promise<void> => {
    await logoutUser();
    window.location.assign("/");
  };

  const onToggleArchived = async (): Promise<void> => {
    const next = !showArchived;
    setShowArchived(next);
    await refresh(next);
  };

  const setBusy = (id: string, kind: "archiving" | "unarchiving" | "deleting" | undefined) =>
    setPending((p) => ({ ...p, [id]: kind }));

  const onArchive = async (b: UserBoard): Promise<void> => {
    setBusy(b.board_id, "archiving");
    try {
      await archiveBoard(b.board_id);
      await refresh(showArchived);
    } catch (ex) {
      window.alert(`Couldn't archive: ${(ex as Error).message}`);
    } finally {
      setBusy(b.board_id, undefined);
    }
  };

  const onUnarchive = async (b: UserBoard): Promise<void> => {
    setBusy(b.board_id, "unarchiving");
    try {
      await unarchiveBoard(b.board_id);
      await refresh(showArchived);
    } catch (ex) {
      window.alert(`Couldn't unarchive: ${(ex as Error).message}`);
    } finally {
      setBusy(b.board_id, undefined);
    }
  };

  const onDelete = async (b: UserBoard): Promise<void> => {
    const label = b.note || b.board_id;
    const live = b.live_session_count ?? 0;
    const arch = b.archived_session_count ?? 0;
    const inventory = (live || arch)
      ? `\n\nThis will also permanently delete ${live} live session${live === 1 ? "" : "s"} and ${arch} archived session${arch === 1 ? "" : "s"} (including their replay history).`
      : "";
    if (!window.confirm(`Delete board "${label}" forever?${inventory}\n\nThis cannot be undone. If you just want to hide it, archive it instead.`)) {
      return;
    }
    setBusy(b.board_id, "deleting");
    try {
      await deleteBoard(b.board_id);
      await refresh(showArchived);
    } catch (ex) {
      window.alert(`Couldn't delete: ${(ex as Error).message}`);
    } finally {
      setBusy(b.board_id, undefined);
    }
  };

  return (
    <main className="landing">
      <section className="create boards-manage">
        <h2 style={{ marginTop: 0 }}>
          Welcome back, {user.name || user.email}
        </h2>
        <p style={{ color: "var(--text-mute)" }}>
          Signed in as <code>{user.email}</code>
          {user.marketing_opt_in ? " · subscribed to product news" : ""}
        </p>

        <div className="boards-manage-head">
          <h3 style={{ margin: 0 }}>Your boards</h3>
          <label className="meta archived-toggle">
            <input
              type="checkbox"
              checked={showArchived}
              onChange={onToggleArchived}
            />
            show archived
          </label>
        </div>

        {err ? <div className="error-banner">{err}</div> : null}
        {boards.length === 0 ? (
          <p style={{ color: "var(--text-mute)" }}>
            {showArchived
              ? "No boards at all yet."
              : <>No active boards. <a href="/">Mint one</a> — when signed in, it's attached to your account automatically.</>}
          </p>
        ) : (
          <table className="boards-table">
            <thead>
              <tr>
                <th>Board</th>
                <th className="num" title="Live sessions / Archived sessions">Sessions</th>
                <th>Last activity</th>
                <th>Created</th>
                <th className="actions">Actions</th>
              </tr>
            </thead>
            <tbody>
              {boards.map((b) => {
                const live = b.live_session_count ?? 0;
                const archived = b.archived_session_count ?? 0;
                const busy = pending[b.board_id];
                return (
                  <tr key={b.board_id} className={b.archived ? "archived" : ""}>
                    <td>
                      <a href={b.url} className="board-link">
                        <span className="board-note">{b.note || "(no note)"}</span>
                        <code className="board-id">{b.board_id}</code>
                      </a>
                      {b.archived ? <span className="badge archived">archived</span> : null}
                    </td>
                    <td className="num">
                      <span title="Live sessions on the board">{live}</span>
                      <span className="meta"> · </span>
                      <span className="meta" title="Archived sessions (replay history retained)">{archived}</span>
                    </td>
                    <td className="meta">{b.last_activity ? b.last_activity.slice(0, 16).replace("T", " ") : "—"}</td>
                    <td className="meta">{b.created_at.slice(0, 10)}</td>
                    <td className="actions">
                      {b.archived ? (
                        <button
                          className="ghost"
                          disabled={!!busy}
                          onClick={() => onUnarchive(b)}
                          title="Restore this board to your active list"
                        >
                          {busy === "unarchiving" ? "…" : "unarchive"}
                        </button>
                      ) : (
                        <button
                          className="ghost"
                          disabled={!!busy}
                          onClick={() => onArchive(b)}
                          title="Hide this board from your active list (sessions stay intact, you can unarchive later)"
                        >
                          {busy === "archiving" ? "…" : "archive"}
                        </button>
                      )}
                      <button
                        className="ghost danger"
                        disabled={!!busy}
                        onClick={() => onDelete(b)}
                        title="Permanently delete this board and every session, history row, and archive inside it"
                      >
                        {busy === "deleting" ? "…" : "delete"}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        <div style={{ marginTop: 24, display: "flex", gap: 12 }}>
          <a href="/"><button>create another board</button></a>
          <button onClick={onLogout}>sign out</button>
        </div>
      </section>
    </main>
  );
}

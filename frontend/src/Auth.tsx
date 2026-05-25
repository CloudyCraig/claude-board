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

import { useEffect, useState } from "react";
import {
  fetchMe, fetchMyBoards, loginUser, logoutUser, registerUser,
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
        const bs = await fetchMyBoards();
        if (!stopped) setBoards(bs);
      } catch (ex) {
        if (!stopped) setErr((ex as Error).message);
      }
    })();
    return () => { stopped = true; };
  }, []);

  if (user === undefined) {
    return <AuthCard title="loading…"><div /></AuthCard>;
  }
  if (user === null) return <LoginPage />;

  const onLogout = async (): Promise<void> => {
    await logoutUser();
    window.location.assign("/");
  };

  return (
    <main className="landing">
      <section className="create" style={{ maxWidth: 680 }}>
        <h2 style={{ marginTop: 0 }}>
          Welcome back, {user.name || user.email}
        </h2>
        <p style={{ color: "var(--text-mute)" }}>
          Signed in as <code>{user.email}</code>
          {user.marketing_opt_in ? " · subscribed to product news" : ""}
        </p>

        <h3 style={{ marginTop: 24 }}>Your boards</h3>
        {err ? <div className="error-banner">{err}</div> : null}
        {boards.length === 0 ? (
          <p style={{ color: "var(--text-mute)" }}>
            No boards yet. <a href="/">Mint your first one</a> — when you're
            signed in, the new board is attached to your account
            automatically.
          </p>
        ) : (
          <ul style={{ paddingLeft: 18, lineHeight: 1.9 }}>
            {boards.map((b) => (
              <li key={b.board_id}>
                <a href={b.url}><code>{b.board_id}</code></a>
                {b.note ? <> — {b.note}</> : null}
                <span style={{ color: "var(--text-mute)", marginLeft: 8, fontSize: 12 }}>
                  created {b.created_at.slice(0, 10)}
                </span>
              </li>
            ))}
          </ul>
        )}
        <div style={{ marginTop: 24, display: "flex", gap: 12 }}>
          <a href="/"><button>create another board</button></a>
          <button onClick={onLogout}>sign out</button>
        </div>
      </section>
    </main>
  );
}

import { BoardCreate, Manifest, RegisterPayload, User, UserBoard } from "./types";

// The frontend either runs on the same origin as the API (the
// production case — FastAPI serves the bundle) OR proxies to it via
// Vite (the dev case). Either way, relative URLs work.
//
// For Odin v2 endpoints (everything under /api/auth and /api/users)
// we send credentials so the signed session cookie travels with the
// request. The bearer-token endpoints don't need it but it's harmless.

async function jsonOrThrow<T>(r: Response, label: string): Promise<T> {
  if (r.ok) return r.json();
  let detail = "";
  try { detail = (await r.json()).detail ?? ""; } catch { /* */ }
  throw new Error(`${label}: ${r.status}${detail ? ` — ${detail}` : ""}`);
}

export async function createBoard(note: string): Promise<BoardCreate> {
  const r = await fetch("/api/boards", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ note }),
  });
  return jsonOrThrow<BoardCreate>(r, "create board");
}

// ----- Odin v2: user-auth API -----

export async function registerUser(p: RegisterPayload): Promise<User> {
  const r = await fetch("/api/auth/register", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(p),
  });
  return jsonOrThrow<User>(r, "register");
}

export async function loginUser(email: string, password: string): Promise<User> {
  const r = await fetch("/api/auth/login", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  return jsonOrThrow<User>(r, "login");
}

export async function logoutUser(): Promise<void> {
  await fetch("/api/auth/logout", {
    method: "POST",
    credentials: "include",
  });
}

export async function fetchMe(): Promise<User | null> {
  // Used on page load to discover whether we're logged in. 401 = not
  // logged in; we swallow it. Other errors bubble.
  const r = await fetch("/api/auth/me", { credentials: "include" });
  if (r.status === 401) return null;
  return jsonOrThrow<User>(r, "fetch me");
}

export async function fetchMyBoards(): Promise<UserBoard[]> {
  const r = await fetch("/api/users/me/boards", { credentials: "include" });
  const data = await jsonOrThrow<{ items: UserBoard[] }>(r, "list my boards");
  return data.items;
}

export async function listManifests(token: string): Promise<{ items: Manifest[]; board_id: string }> {
  const r = await fetch("/api/manifests", {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (r.status === 401) throw new Error("unauthorized");
  if (!r.ok) throw new Error(`list manifests: ${r.status}`);
  return r.json();
}

/**
 * Subscribe to the SSE wake-up stream. Each event from the server is
 * a hint to refetch — we don't trust the event payload itself. The
 * caller passes onWake; we handle EventSource lifecycle and
 * reconnect with backoff.
 *
 * EventSource doesn't support custom headers (notably Authorization),
 * so we pass the token as a query param. The server reads either
 * `?token=...` or the Authorization header.
 *
 * UPDATE: server currently only reads the header — so for SSE we fall
 * back to polling. (The trade-off is acceptable for v1; we can
 * rework with a cookie-based session if real-time becomes critical.)
 */
export function subscribePolling(_token: string, onWake: () => void, intervalMs = 5000): () => void {
  let stopped = false;
  let timer: number | null = null;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    onWake();
    timer = window.setTimeout(tick, intervalMs);
  };

  tick();

  return () => {
    stopped = true;
    if (timer !== null) window.clearTimeout(timer);
  };
}

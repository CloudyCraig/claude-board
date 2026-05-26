import { Archive, BoardCreate, HistoryEntry, Manifest, RegisterPayload, User, UserBoard } from "./types";

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

export async function fetchMyBoards(includeArchived = false): Promise<UserBoard[]> {
  const qs = includeArchived ? "?include_archived=true" : "";
  const r = await fetch(`/api/users/me/boards${qs}`, { credentials: "include" });
  const data = await jsonOrThrow<{ items: UserBoard[] }>(r, "list my boards");
  return data.items;
}

// ----- Board-level archive / unarchive / delete (cookie-auth, owner-only) -----

export async function archiveBoard(boardId: string): Promise<void> {
  const r = await fetch(`/api/boards/${encodeURIComponent(boardId)}/archive`, {
    method: "POST", credentials: "include",
  });
  if (!r.ok) throw new Error(`archive board: ${r.status}`);
}

export async function unarchiveBoard(boardId: string): Promise<void> {
  const r = await fetch(`/api/boards/${encodeURIComponent(boardId)}/unarchive`, {
    method: "POST", credentials: "include",
  });
  if (!r.ok) throw new Error(`unarchive board: ${r.status}`);
}

/** Cascade-delete a board AND every manifest, history row, and session
 *  archive inside it. Irreversible — caller is responsible for
 *  confirming with the user first. */
export async function deleteBoard(boardId: string): Promise<void> {
  const r = await fetch(`/api/boards/${encodeURIComponent(boardId)}`, {
    method: "DELETE", credentials: "include",
  });
  if (!r.ok) throw new Error(`delete board: ${r.status}`);
}

export async function listManifests(token: string): Promise<{ items: Manifest[]; board_id: string }> {
  const r = await fetch("/api/manifests", {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (r.status === 401) throw new Error("unauthorized");
  if (!r.ok) throw new Error(`list manifests: ${r.status}`);
  return r.json();
}

/** Read a board you own without needing a bearer token — cookie auth
 *  via the /api/boards/{board_id}/manifests route. Used by the web
 *  UI when the user is signed in; the CLI still uses bearer tokens. */
export async function listOwnedManifests(boardId: string): Promise<{ items: Manifest[]; board_id: string }> {
  const r = await fetch(`/api/boards/${encodeURIComponent(boardId)}/manifests`, {
    credentials: "include",
  });
  if (r.status === 401) throw new Error("unauthorized");
  if (r.status === 404) throw new Error("not-owned");
  if (!r.ok) throw new Error(`list manifests: ${r.status}`);
  return r.json();
}

/** Delete a session via the bearer-token endpoint (token mode). The
 *  server returns 204 on success and 404 if the row's already gone —
 *  we treat 404 as success because the caller's intent was "make
 *  this not exist", and the postcondition is satisfied either way. */
export async function deleteManifestByToken(token: string, sessionId: string): Promise<void> {
  const r = await fetch(`/api/manifests/${encodeURIComponent(sessionId)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok && r.status !== 404) throw new Error(`delete manifest: ${r.status}`);
}

/** Delete via cookie auth — used when the signed-in owner is viewing
 *  their own board (no token needed). Same 404-is-fine semantics. */
export async function deleteManifestByCookie(boardId: string, sessionId: string): Promise<void> {
  const r = await fetch(
    `/api/boards/${encodeURIComponent(boardId)}/manifests/${encodeURIComponent(sessionId)}`,
    { method: "DELETE", credentials: "include" },
  );
  if (!r.ok && r.status !== 404) throw new Error(`delete manifest: ${r.status}`);
}

// ----- Archive + replay -----

export async function archiveByToken(token: string, sessionId: string): Promise<void> {
  const r = await fetch(`/api/manifests/${encodeURIComponent(sessionId)}/archive`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok && r.status !== 404) throw new Error(`archive: ${r.status}`);
}

export async function archiveByCookie(boardId: string, sessionId: string): Promise<void> {
  const r = await fetch(
    `/api/boards/${encodeURIComponent(boardId)}/manifests/${encodeURIComponent(sessionId)}/archive`,
    { method: "POST", credentials: "include" },
  );
  if (!r.ok && r.status !== 404) throw new Error(`archive: ${r.status}`);
}

export async function listArchivesByToken(token: string): Promise<{ items: Archive[]; board_id: string }> {
  const r = await fetch("/api/archives", {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new Error(`list archives: ${r.status}`);
  return r.json();
}

export async function listArchivesByCookie(boardId: string): Promise<{ items: Archive[]; board_id: string }> {
  const r = await fetch(`/api/boards/${encodeURIComponent(boardId)}/archives`, {
    credentials: "include",
  });
  if (!r.ok) throw new Error(`list archives: ${r.status}`);
  return r.json();
}

export async function fetchHistoryByToken(
  token: string, sessionId: string,
): Promise<{ items: HistoryEntry[] }> {
  const r = await fetch(`/api/manifests/${encodeURIComponent(sessionId)}/history`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new Error(`history: ${r.status}`);
  return r.json();
}

export async function fetchHistoryByCookie(
  boardId: string, sessionId: string,
): Promise<{ items: HistoryEntry[] }> {
  const r = await fetch(
    `/api/boards/${encodeURIComponent(boardId)}/sessions/${encodeURIComponent(sessionId)}/history`,
    { credentials: "include" },
  );
  if (!r.ok) throw new Error(`history: ${r.status}`);
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

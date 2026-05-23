import { BoardCreate, Manifest } from "./types";

// The frontend either runs on the same origin as the API (the
// production case — FastAPI serves the bundle) OR proxies to it via
// Vite (the dev case). Either way, relative URLs work.

export async function createBoard(note: string): Promise<BoardCreate> {
  const r = await fetch("/api/boards", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ note }),
  });
  if (!r.ok) throw new Error(`create board: ${r.status}`);
  return r.json();
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

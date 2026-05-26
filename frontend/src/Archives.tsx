/**
 * Archives view + replay modal.
 *
 * The live board (App.tsx) holds whatever sessions are currently
 * pushing. When a session ends (status=done, or the user clicks the
 * archive button on its card) the row moves into the `archives`
 * server table — gone from the live view, but preserved with its
 * full push-by-push history so it can be replayed.
 *
 * This file contains:
 *   • ArchivesView — the list/grid you see when you click the
 *     "archives" toggle in the stage toolbar.
 *   • ReplayModal — opened from any archive entry. Loads the
 *     session's history into a slider and re-renders a frozen card
 *     at each push_num so you can scrub the timeline.
 *
 * Auth: every fetch picks the cookie OR token flavour based on the
 * authMode prop the parent computed during its mode probe. The two
 * call-sites are isomorphic — same JSON shape, different URL +
 * credential handling.
 */
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  fetchHistoryByCookie, fetchHistoryByToken,
  listArchivesByCookie, listArchivesByToken,
} from "./api";
import { Archive, HistoryEntry, Manifest, StoredBoard } from "./types";

// ----------------- helpers shared with App.tsx -----------------
//
// Kept inline rather than imported because they're tiny and the
// equivalent in App.tsx has its own JSX coupling. If we end up with a
// third caller we can extract.

function chipClassFor(m: Manifest): string {
  return m.blocked_on_user
    ? "blocked"
    : m.status === "blocked" || m.status === "idle"
    ? m.status
    : m.status === "done"
    ? "done"
    : "active";
}

function chipLabelFor(m: Manifest): string {
  return m.blocked_on_user ? "needs you" : m.status;
}

function relTime(iso: string): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  const secs = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return `${days}d ago`;
}

// ----------------- ArchivesView -----------------

export function ArchivesView({
  boardId, authMode, board, onClose,
}: {
  boardId: string;
  authMode: "cookie" | "token";
  board: StoredBoard | null;
  onClose: () => void;
}): JSX.Element {
  const [items, setItems] = useState<Archive[]>([]);
  const [err, setErr] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(true);
  const [replaying, setReplaying] = useState<Archive | null>(null);

  // Single shot load; archives don't churn the way live cards do, so
  // 5s polling is overkill. The user re-enters the view to refresh.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setLoading(true);
        const data = authMode === "cookie"
          ? await listArchivesByCookie(boardId)
          : board ? await listArchivesByToken(board.token)
                  : { items: [], board_id: boardId };
        if (!cancelled) setItems(data.items);
      } catch (e) {
        if (!cancelled) setErr((e as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [boardId, authMode, board]);

  return (
    <main className="board archives-view">
      <div className="archives-toolbar">
        <button className="ghost" onClick={onClose} title="Back to the live board">
          ← back to live
        </button>
        <span className="archives-title">archives</span>
        <span className="meta">{items.length} session{items.length === 1 ? "" : "s"}</span>
      </div>

      {loading ? (
        <div className="archives-empty">loading…</div>
      ) : err ? (
        <div className="archives-empty">couldn't load archives: {err}</div>
      ) : items.length === 0 ? (
        <div className="archives-empty">
          no archives yet · click 📦 on a card, or let a "done" session age out, to fill this view
        </div>
      ) : (
        <ul className="archives-list">
          {items.map((a) => (
            <li
              key={a.session_id}
              className="archive-row"
              onClick={() => setReplaying(a)}
              title="Click to replay — scrub through every push for this session"
            >
              <div className="archive-row-main">
                <div className="archive-row-title">{a.title || "(untitled)"}</div>
                <div className="archive-row-meta">
                  <span className={`chip ${chipClassFor(a)}`}>{chipLabelFor(a)}</span>
                  {a.project ? <span className="project">{a.project}</span> : null}
                  <span className="meta">{a.push_count} push{a.push_count === 1 ? "" : "es"}</span>
                  <span className="meta">archived {relTime(a.archived_at)}</span>
                </div>
                {a.current_chapter ? (
                  <div className="archive-row-chapter">↳ {a.current_chapter}</div>
                ) : null}
              </div>
              <button className="ghost" onClick={(e) => { e.stopPropagation(); setReplaying(a); }}>
                ▶ replay
              </button>
            </li>
          ))}
        </ul>
      )}

      {replaying ? (
        <ReplayModal
          archive={replaying}
          boardId={boardId}
          authMode={authMode}
          board={board}
          onClose={() => setReplaying(null)}
        />
      ) : null}
    </main>
  );
}

// ----------------- ReplayModal -----------------
//
// One mostly-self-contained component. Loads the session's history
// once on open, then renders a slider + a frozen card view that
// re-renders as the slider moves.

function ReplayModal({
  archive, boardId, authMode, board, onClose,
}: {
  archive: Archive;
  boardId: string;
  authMode: "cookie" | "token";
  board: StoredBoard | null;
  onClose: () => void;
}): JSX.Element {
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [err, setErr] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(true);
  // 1-based index into `history`. Default to the final frame so the
  // user lands on "how the session ended" — they scrub backwards to
  // see how it got there.
  const [idx, setIdx] = useState<number>(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setLoading(true);
        const data = authMode === "cookie"
          ? await fetchHistoryByCookie(boardId, archive.session_id)
          : board ? await fetchHistoryByToken(board.token, archive.session_id)
                  : { items: [] };
        if (!cancelled) {
          setHistory(data.items);
          setIdx(Math.max(0, data.items.length - 1));
        }
      } catch (e) {
        if (!cancelled) setErr((e as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [archive.session_id, boardId, authMode, board]);

  // ESC + click-outside both close. Mimics the platform convention
  // for modal overlays.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Indices where the chapter changed vs the previous frame — drawn
  // as ticks on the slider so the user has structural waypoints, not
  // just a featureless line.
  const chapterTicks = useMemo<number[]>(() => {
    const out: number[] = [];
    let last = "";
    for (let i = 0; i < history.length; i++) {
      const ch = history[i].manifest.current_chapter || "";
      if (ch !== last) { out.push(i); last = ch; }
    }
    return out;
  }, [history]);

  // Status-change indices, separately tracked — useful as a secondary
  // visual cue (different tick colour in CSS).
  const statusTicks = useMemo<number[]>(() => {
    const out: number[] = [];
    let last = "";
    for (let i = 0; i < history.length; i++) {
      const s = history[i].manifest.status;
      if (s !== last) { out.push(i); last = s; }
    }
    return out;
  }, [history]);

  const current = history[idx]?.manifest ?? archive;
  const currentEntry = history[idx];

  const onSlider = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setIdx(Number(e.target.value));
  }, []);

  const onBackdrop = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose();
  };

  return (
    <div className="replay-backdrop" onClick={onBackdrop}>
      <div className="replay-modal" role="dialog" aria-label={`Replay of ${archive.title}`}>
        <div className="replay-head">
          <div className="replay-title">
            <span className="meta">replay</span>{" "}
            <strong>{archive.title || archive.session_id}</strong>
          </div>
          <button className="ghost" onClick={onClose} title="Close (Esc)">✕</button>
        </div>

        {loading ? (
          <div className="replay-empty">loading history…</div>
        ) : err ? (
          <div className="replay-empty">couldn't load history: {err}</div>
        ) : history.length === 0 ? (
          <div className="replay-empty">no history for this session (archived before history was tracked)</div>
        ) : (
          <>
            <div className="replay-frame">
              <FrozenCard manifest={current} />
            </div>

            <div className="replay-scrub">
              <div className="replay-scrub-meta">
                <span className="meta">
                  frame {idx + 1} of {history.length}
                </span>
                <span className="meta">
                  {currentEntry ? relTime(currentEntry.updated_at) : ""}
                </span>
              </div>
              <div className="replay-slider-wrap">
                <input
                  type="range"
                  min={0}
                  max={Math.max(0, history.length - 1)}
                  step={1}
                  value={idx}
                  onChange={onSlider}
                  className="replay-slider"
                  aria-label="Scrub through session history"
                />
                <svg
                  className="replay-ticks"
                  viewBox={`0 0 ${Math.max(1, history.length - 1)} 10`}
                  preserveAspectRatio="none"
                >
                  {chapterTicks.map((i) => (
                    <line key={`c${i}`} x1={i} x2={i} y1={0} y2={10} className="tick-chapter" />
                  ))}
                  {statusTicks.map((i) => (
                    <line key={`s${i}`} x1={i} x2={i} y1={6} y2={10} className="tick-status" />
                  ))}
                </svg>
              </div>
              <div className="replay-legend">
                <span><span className="legend-swatch chapter" /> chapter change</span>
                <span><span className="legend-swatch status" /> status change</span>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ----------------- FrozenCard -----------------
//
// A read-only render of one manifest. Looks like a SessionCard but
// no drag, no delete, no archive. Used inside the replay modal.

function FrozenCard({ manifest: m }: { manifest: Manifest }): JSX.Element {
  const taskPips = (m.tasks ?? []).map((t) => {
    const cls =
      t.status === "completed" ? "done" :
      t.status === "in_progress" ? "active" :
      "pending";
    return <span key={t.id} className={`pip ${cls}`} title={`${t.status}: ${t.title}`} />;
  });
  return (
    <div className={`card frozen ${m.blocked_on_user ? "blocked-on-user" : ""}`}>
      <div className="head">
        <div className="title" title={m.title}>{m.title || "(untitled)"}</div>
        <span className={`chip ${chipClassFor(m)}`}>{chipLabelFor(m)}</span>
      </div>
      {m.project ? <div className="head"><span className="project">{m.project}</span></div> : null}
      {m.current_chapter ? <div className="chapter">↳ {m.current_chapter}</div> : null}
      {taskPips.length > 0 ? <div className="tasks">{taskPips}</div> : null}
      {m.blocked_on_user && m.blocked_reason ? (
        <div className="blocked-banner">{m.blocked_reason}</div>
      ) : null}
      <div className="footer">
        <span>updated {relTime(m.updated_at)}</span>
      </div>
    </div>
  );
}

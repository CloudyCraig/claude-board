import { StoredBoard } from "./types";

/**
 * Token storage — localStorage scoped per board_id so multiple users
 * on the same browser keep their tokens isolated. Lost token = no
 * recovery, exactly like the share-link model.
 */

const KEY_PREFIX = "claude-board.token.";

export function saveToken(b: StoredBoard): void {
  try {
    localStorage.setItem(KEY_PREFIX + b.board_id, JSON.stringify(b));
  } catch {
    /* private mode, full quota — silent fall-through; the user just
       has to keep the token themselves */
  }
}

export function loadToken(boardId: string): StoredBoard | null {
  try {
    const raw = localStorage.getItem(KEY_PREFIX + boardId);
    if (!raw) return null;
    return JSON.parse(raw) as StoredBoard;
  } catch {
    return null;
  }
}

export function forgetToken(boardId: string): void {
  try { localStorage.removeItem(KEY_PREFIX + boardId); } catch { /**/ }
}

/** Pull board_id out of a URL path like /b/brd_abc — used by App
 *  to decide whether to render the landing or the board view. */
export function boardIdFromPath(): string | null {
  const m = window.location.pathname.match(/^\/b\/([A-Za-z0-9_-]+)\/?$/);
  return m ? m[1] : null;
}

// ----- layout overrides (drag-to-rearrange persistence) -----
//
// When the user drags a card on the stage we remember its position
// in localStorage so a refresh / page reload keeps it where they put
// it. Stored per-board so dragging cards on one board doesn't move
// equally-named cards on another. Keys are session_id; values are
// {x, y} in stage-pixel coordinates of the card's CENTRE.

const LAYOUT_PREFIX = "claude-board.layout.";

export type LayoutOverrides = Record<string, { x: number; y: number }>;

export function loadLayout(boardId: string): LayoutOverrides {
  try {
    const raw = localStorage.getItem(LAYOUT_PREFIX + boardId);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === "object") ? parsed as LayoutOverrides : {};
  } catch {
    return {};
  }
}

export function saveLayout(boardId: string, overrides: LayoutOverrides): void {
  try {
    localStorage.setItem(LAYOUT_PREFIX + boardId, JSON.stringify(overrides));
  } catch { /* private mode / quota — silent */ }
}

export function clearLayout(boardId: string): void {
  try { localStorage.removeItem(LAYOUT_PREFIX + boardId); } catch { /**/ }
}

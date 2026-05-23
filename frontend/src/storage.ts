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

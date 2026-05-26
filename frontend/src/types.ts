// Mirrors docs/manifest-spec.md. Server accepts unknown extras, so
// we keep this interface forward-compatible by leaving room for them.

export type SessionStatus = "active" | "blocked" | "idle" | "done";

export interface ManifestTask {
  id: string;
  title: string;
  status: "pending" | "in_progress" | "completed" | string;
}

export interface Manifest {
  session_id:        string;
  title:             string;
  status:            SessionStatus;
  updated_at:        string;
  started_at?:       string;
  project?:          string;
  current_chapter?:  string;
  blocked_on_user?:  boolean;
  blocked_reason?:   string;
  tasks?:            ManifestTask[];
  depends_on?:       string[];
  notes?:            string;

  // Deep-link affordances (Odin v2.1). Both optional — cards
  // without either still render fine, just without the linking
  // badges. `project_dir` is auto-populated by the CLI from $PWD
  // on push; `claude_url` is whatever explicit URL the user pastes
  // into the manifest (typically a `/rc` Remote Control URL).
  project_dir?:      string;
  claude_url?:       string;

  // Server-populated
  board_id?:         string;
  received_at?:      string;
}

/** Archive entry — the final state of a session at the moment it was
 *  moved out of the live board. The `manifest` it holds is whatever
 *  Claude last pushed; `push_count` lets the replay UI show "n frames"
 *  without fetching the full history. */
export interface Archive extends Manifest {
  archived_at: string;
  push_count:  number;
}

/** One entry in a session's history feed. `push_num` is the 1-based
 *  sequence within (board_id, session_id); the scrubber maps slider
 *  position → push_num. `manifest` is the manifest as-of that push. */
export interface HistoryEntry {
  push_num:    number;
  manifest:    Manifest;
  updated_at:  string;
  received_at: string;
}

export interface BoardCreate {
  board_id: string;
  token:    string;
  url:      string;
}

export interface StoredBoard {
  board_id: string;
  token:    string;
  server:   string;          // origin, e.g. https://odin.heimdallsystems.ai
}

// ----- Odin v2: user accounts -----

export interface User {
  user_id:          string;
  email:            string;
  name:             string;
  marketing_opt_in: boolean;
  created_at?:      string;
  last_seen?:       string;
}

export interface UserBoard {
  board_id:   string;
  url:        string;
  note:       string;
  created_at: string;
  last_seen:  string;
  /** Server-set since the board-management work. Older endpoint
   *  responses won't carry these — frontend treats undefined as
   *  "unknown, hide the column" rather than zero. */
  archived?:                boolean;
  live_session_count?:      number;
  archived_session_count?:  number;
  last_activity?:           string | null;
}

export interface RegisterPayload {
  name:             string;
  email:            string;
  password:         string;
  marketing_opt_in: boolean;
  source?:          "web" | "desktop" | "cli";
}

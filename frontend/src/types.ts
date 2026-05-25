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

  // Server-populated
  board_id?:         string;
  received_at?:      string;
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
}

export interface RegisterPayload {
  name:             string;
  email:            string;
  password:         string;
  marketing_opt_in: boolean;
  source?:          "web" | "desktop" | "cli";
}

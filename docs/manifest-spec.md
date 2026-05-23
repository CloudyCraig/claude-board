# Claude Board — Manifest Spec

A *manifest* is a small JSON document describing the live state of one Claude session. Each session owns exactly one manifest, identified by `session_id`. Sessions write their manifest on every meaningful state change (task added/updated, chapter marked, blocked on user, completion) and call `claude-board push` to sync it to the server.

The server stores manifests indexed by `(board_id, session_id)` so the UI can show the human's view of *everything happening for them right now*.

## File location

```
~/.claude-board/<session_id>.json
```

Sessions are encouraged to use a ULID or UUIDv7 for `session_id` so chronological sort works out of the box.

## Schema

```jsonc
{
  // Required
  "session_id":  "01HZQK7K3M4Q8C5VYK0YQ8M1WX",   // ULID, per-session
  "title":       "Wave 3 dashboards across huginn/muninn/vor",
  "status":      "active",                       // active | blocked | idle | done
  "updated_at":  "2026-05-23T10:45:00Z",

  // Strongly recommended
  "project":            "huginn",                // free-form grouping tag
  "started_at":         "2026-05-23T10:00:00Z",
  "current_chapter":    "Wave 3.3: Share link",  // last chapter title
  "blocked_on_user":    false,                   // true = needs human action
  "blocked_reason":     "",                      // shown verbatim when blocked

  // Optional
  "tasks": [
    { "id": "1", "title": "Date-range picker", "status": "completed" },
    { "id": "2", "title": "Drag-to-reorder",   "status": "completed" },
    { "id": "3", "title": "Share link",        "status": "in_progress" }
  ],
  "depends_on": [                                // other session_ids
    "01HZ9R8...",
    "01HZ9SK..."
  ],
  "notes": "All 3 features pushed to huginn/muninn/vor; lumiq deferred",

  // Server-populated (clients leave these blank)
  "board_id":    "brd_...",                      // set from local config on push
  "received_at": "2026-05-23T10:45:01Z"          // server clock on POST
}
```

## Status semantics

| status   | meaning                                                            | UI colour |
|----------|--------------------------------------------------------------------|-----------|
| `active` | actively making progress, not blocked                              | green     |
| `blocked`| stuck on an external dependency (CI, deploy, another session)      | amber     |
| `idle`   | session is paused / no recent activity                             | grey      |
| `done`   | work is complete; session may be archived                          | dim       |

`blocked_on_user: true` is **separate** from `status`. A session can be `status: active, blocked_on_user: true` — actively waiting on the human to answer an AskUserQuestion. The UI surfaces `blocked_on_user` more aggressively than `status` because that's where the human's attention is required.

## When sessions update

Claude sessions update their manifest on:

1. **TaskCreate / TaskUpdate** — refresh `tasks[]`.
2. **mark_chapter** — set `current_chapter`.
3. **AskUserQuestion** — set `blocked_on_user: true`, `blocked_reason: "<question>"`. Clear after user answers.
4. **End of session** — `status: done`.

After each write, call `claude-board push`. The CLI is idempotent — pushing an unchanged manifest is a no-op.

## Dependencies

`depends_on` is an array of other `session_id`s the current session is waiting on. The UI draws SVG edges between them. Common patterns:

- Mirror task waiting on the canonical implementation to land.
- Verification session waiting on a deploy session.
- Multi-phase project where each phase is its own session.

Cyclical dependencies are allowed at the data layer but flagged in the UI.

## Privacy

Manifest content is mildly sensitive — project names, file paths, blocker reasons can reveal what you're working on. The server requires a bearer token on read AND write. Don't put secrets in `notes` or `blocked_reason`; assume manifest content is the same risk class as a private GitHub issue title.

## Versioning

Server accepts unknown fields and stores them. Breaking changes to required fields will bump a top-level `schema_version` (default `1`).

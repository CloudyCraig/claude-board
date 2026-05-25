# Heimdall Claude Control · desktop app

A small Electron client for the [Odin · Claude Board](https://odin.heimdallsystems.ai)
web app, with a one-click **Launch Claude in folder…** menu item for the
Claude CLI.

The Odin web app is the same one you see at `odin.heimdallsystems.ai` — the
desktop just wraps it, gives it its own cookie jar (so you stay signed in
without the rest of your browsing using the same session), and adds the
Claude launcher.

## Why a desktop app?

The Odin web app works fine in any browser. The desktop wrapper exists to:

1. **Make sign-in stick** — a dedicated cookie jar means you don't get
   logged out when you clear cookies in Safari/Chrome.
2. **One-click Claude CLI** — `⌘⇧O` (or *File → Launch Claude in
   folder…*) pops a folder picker (defaults to `~/Claude`), then opens
   Terminal in that folder running `claude`. Saves three steps every
   time you want to start a session.
3. **First-launch registration** — the very first time you open the
   app, it sends you to `/register?source=desktop` so the registration
   is attributed to the desktop install (visible to the Odin
   maintainer for product-analytics purposes).

## Run from source

```sh
cd desktop
npm install
npm start
```

To point at a local Odin server instead of production:

```sh
ODIN_URL=http://localhost:8200 npm start
```

## Build a .dmg

```sh
npm run dist:dmg
```

Output lands in `desktop/dist-app/`. The DMG is a universal binary
(Intel + Apple Silicon). It is **not signed or notarised** — first-time
users will need to right-click → Open the first time, or run
`xattr -dr com.apple.quarantine /Applications/Heimdall\ Claude\ Control.app`.

(Notarisation requires an Apple Developer ID. We'll add it when
distribution scale justifies the $99/year.)

## File layout

| file              | what                                           |
|-------------------|------------------------------------------------|
| `main.js`         | Electron main process — window, menu, IPC      |
| `preload.js`      | Safe `window.heimdallClaudeControl` surface    |
| `package.json`    | electron-builder config + scripts              |
| `build/icon.icns` | App + DMG icon (multi-res Heimdall mark)       |
| `build/dmg-bg.png`| DMG background                                 |

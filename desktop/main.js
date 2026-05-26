/**
 * Heimdall Claude Control — Electron main process.
 *
 * This is the *desktop* app. The web service it talks to is still
 * called Odin · Claude Board (live at odin.heimdallsystems.ai). One
 * backend, two faces — the web is for sharing/teams, the desktop app
 * is for personal use with a one-click Claude CLI launcher.
 *
 * Two jobs:
 *
 *   1. Host the Odin web app in a BrowserWindow. The cookie jar is
 *      per-app so a user can stay signed in here without polluting
 *      Safari/Chrome. On first launch we route to
 *      /register?source=desktop so the registration is recorded
 *      against the desktop install. After that we just open / and
 *      let the web app's session cookie do its thing.
 *
 *   2. Provide a one-click "Launch Claude in folder…" menu item.
 *      Pops a folder picker (defaulting to ~/Claude if it exists),
 *      then asks macOS Terminal.app to cd + run `claude`.
 *
 * State lives at  Application Support/Heimdall Claude Control/state.json
 * with one key:  { firstLaunchDone: true }.
 * That's all we need to decide whether to send the user to /register
 * versus /. Anything else (session, last viewed board, etc.) lives
 * server-side on Odin.
 */

const { app, BrowserWindow, Menu, Notification, dialog, shell, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { spawn, execFile } = require("child_process");

// --- config -----------------------------------------------------

const ODIN_URL = process.env.ODIN_URL || "https://odin.heimdallsystems.ai";
const APP_NAME = "Heimdall Claude Control";

// --- first-run state -------------------------------------------

function statePath() {
  return path.join(app.getPath("userData"), "state.json");
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(statePath(), "utf8"));
  } catch {
    return {};
  }
}

function writeState(patch) {
  const cur = readState();
  const next = { ...cur, ...patch };
  fs.mkdirSync(path.dirname(statePath()), { recursive: true });
  fs.writeFileSync(statePath(), JSON.stringify(next, null, 2), "utf8");
  return next;
}

// --- claude launcher -------------------------------------------

// AppleScript escaping: we wrap the folder path in single quotes
// inside a `do script` AppleScript, so any single-quotes in the path
// become '\'' which closes-escape-reopens the string.
function shellQuoteForApplescript(s) {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

function launchClaudeIn(folder) {
  // macOS-only for v0.1. The .dmg target is mac, so this is fine.
  // We use osascript -e rather than writing a temp .scpt file
  // because the command is short and a single string is easier to
  // reason about than IPC with an external file.
  const quoted = shellQuoteForApplescript(folder);
  const cmd = `cd ${quoted} && claude`;
  // Escape backslashes + double-quotes for AppleScript string.
  const ascCmd = cmd.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const script = [
    `tell application "Terminal"`,
    `  activate`,
    `  do script "${ascCmd}"`,
    `end tell`,
  ].join("\n");
  execFile("osascript", ["-e", script], (err, stdout, stderr) => {
    if (err) {
      dialog.showErrorBox(
        "Couldn't launch Claude",
        `Tried to open Terminal in ${folder}.\n\n${stderr || err.message}\n\n` +
          `Make sure the \`claude\` CLI is on your PATH.`,
      );
    }
  });
}

async function pickFolderAndLaunchClaude(parentWin) {
  const claudeDefault = path.join(os.homedir(), "Claude");
  const defaultPath = fs.existsSync(claudeDefault) ? claudeDefault : os.homedir();
  const result = await dialog.showOpenDialog(parentWin || null, {
    title: "Open Claude in a folder",
    defaultPath,
    properties: ["openDirectory", "createDirectory"],
    buttonLabel: "Launch Claude here",
  });
  if (result.canceled || result.filePaths.length === 0) return;
  launchClaudeIn(result.filePaths[0]);
}

// --- main window -----------------------------------------------

let mainWindow = null;

function targetUrlForLaunch() {
  const state = readState();
  if (!state.firstLaunchDone) {
    // Mark the flag NOW (not on successful registration) so a user
    // who closes the window mid-register isn't pestered with the
    // register page forever. They can always reach it from /register.
    writeState({ firstLaunchDone: true });
    return `${ODIN_URL}/register?source=desktop`;
  }
  return `${ODIN_URL}/`;
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 720,
    minHeight: 480,
    title: APP_NAME,
    backgroundColor: "#0e1024",
    show: false,                  // wait for ready-to-show to avoid flash
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.loadURL(targetUrlForLaunch());

  // External links — open in the user's real browser, not in our
  // BrowserWindow. (Odin links are same-origin and stay in-app.)
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const u = new URL(url);
      const odinHost = new URL(ODIN_URL).host;
      if (u.host === odinHost) return { action: "allow" };
    } catch { /* fall through */ }
    shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.on("closed", () => { mainWindow = null; });
}

// --- application menu ------------------------------------------

function buildMenu() {
  const template = [
    {
      label: APP_NAME,
      submenu: [
        { role: "about" },
        { type: "separator" },
        { label: "Open Odin in browser", click: () => shell.openExternal(ODIN_URL) },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" }, { role: "hideOthers" }, { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "File",
      submenu: [
        {
          label: "Launch Claude in folder…",
          accelerator: "CmdOrCtrl+Shift+O",
          click: () => pickFolderAndLaunchClaude(mainWindow),
        },
        { type: "separator" },
        { role: "close" },
      ],
    },
    { label: "Edit", submenu: [
      { role: "undo" }, { role: "redo" }, { type: "separator" },
      { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" },
    ]},
    { label: "View", submenu: [
      { role: "reload" }, { role: "forceReload" }, { type: "separator" },
      { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" },
      { type: "separator" },
      { role: "togglefullscreen" },
      {
        label: "Toggle DevTools",
        accelerator: "Alt+CmdOrCtrl+I",
        click: () => mainWindow && mainWindow.webContents.toggleDevTools(),
      },
    ]},
    { role: "windowMenu" },
    {
      role: "help",
      submenu: [
        { label: "Heimdall on GitHub", click: () => shell.openExternal("https://github.com/CloudyCraig") },
        { label: "Odin docs", click: () => shell.openExternal(`${ODIN_URL}/docs/manifest-spec`) },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// --- IPC: renderer can request a Claude launch -----------------
//
// Useful if/when we ship a custom welcome screen with a button.
// For v0.1 the menu item is enough but the IPC handler costs
// nothing and means the web app can fire `window.postMessage` etc.
// later without a code change here.

ipcMain.handle("odin:launch-claude", async () => {
  await pickFolderAndLaunchClaude(mainWindow);
  return true;
});

// --- claude-board:// URL scheme handler ------------------------
//
// Lets the web UI (mint dialog + regen-token modal) fire a single
// click that attaches a board to this laptop, instead of asking the
// user to copy a CLI command into a terminal. The web UI just
// navigates to claude-board://attach?b=<board_id>&t=<token>;
// macOS dispatches that URL to this app via the registered URL
// scheme (Info.plist CFBundleURLTypes set by electron-builder from
// build.protocols in package.json).
//
// Security stance: we ALWAYS prompt the user to confirm before
// running the attach. Without that confirmation, anyone who could
// trick the user into clicking a link could re-point their CLI at
// a board they control (and start receiving manifests — which may
// carry titles like "Drafting customer X email"). One extra OK
// click is cheap; silent attach is unacceptable.

/** Resolve a working `claude-board` executable. The Electron app's
 *  PATH is set by macOS Launch Services, not the user's shell — so
 *  ~/.local/bin (pipx default), /usr/local/bin (Homebrew), and
 *  /opt/homebrew/bin (Apple-silicon Homebrew) are commonly missing.
 *  We probe them explicitly. Returns the absolute path of the first
 *  match, or null if not found. */
function findClaudeBoardCli() {
  const candidates = [
    path.join(os.homedir(), ".local/bin/claude-board"),
    "/usr/local/bin/claude-board",
    "/opt/homebrew/bin/claude-board",
  ];
  for (const p of candidates) {
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch { /* try next */ }
  }
  return null;
}

/** Parse claude-board://attach?b=…&t=… and run claude-board attach.
 *  Surfaces success/failure via Notification + (on failure) dialog.
 *  Never throws; misbehaving URLs become quiet no-ops. */
async function handleClaudeBoardUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return;     // not a URL we recognise
  }
  if (parsed.protocol !== "claude-board:") return;
  // We only handle /attach today. URL.pathname for a custom scheme
  // is the part after the host; Node's URL parser treats the host
  // as "attach" here, hence the .hostname check.
  if (parsed.hostname !== "attach" && parsed.pathname !== "/attach") return;
  const boardId = parsed.searchParams.get("b") || "";
  const token   = parsed.searchParams.get("t") || "";
  if (!boardId || !token) {
    dialog.showErrorBox(APP_NAME, "Attach link is missing board_id or token.");
    return;
  }
  if (!/^brd_[A-Za-z0-9_-]+$/.test(boardId)) {
    dialog.showErrorBox(APP_NAME, `Refusing to attach: board_id "${boardId}" doesn't look right.`);
    return;
  }

  const confirm = await dialog.showMessageBox(mainWindow || null, {
    type: "question",
    buttons: ["Attach", "Cancel"],
    defaultId: 0,
    cancelId: 1,
    title: "Attach to board?",
    message: `Attach this laptop to ${boardId}?`,
    detail: "This rewrites ~/.claude/board.config. Future `claude-board push` calls from this machine will go to this board.\n\nOnly continue if you started this from a board you trust.",
  });
  if (confirm.response !== 0) return;

  const cli = findClaudeBoardCli();
  if (!cli) {
    dialog.showErrorBox(APP_NAME,
      `Couldn't find the claude-board CLI.\n\n` +
      `Tried ~/.local/bin, /usr/local/bin, /opt/homebrew/bin.\n\n` +
      `Install it with:\n  brew install pipx\n  pipx install git+https://github.com/CloudyCraig/claude-board#subdirectory=cli`,
    );
    return;
  }

  execFile(cli, ["attach", boardId, token], { timeout: 15000 }, (err, stdout, stderr) => {
    if (err) {
      dialog.showErrorBox(APP_NAME,
        `Attach failed.\n\n${(stderr || err.message).trim()}`);
      return;
    }
    new Notification({
      title: "Heimdall · attached",
      body: `Connected to ${boardId}. Next push lands there.`,
      silent: false,
    }).show();
  });
}

// macOS fires this when the app is already running and a URL is
// opened (e.g. user clicks the web UI button while the app is up).
// On cold start the URL comes through process.argv instead; we
// handle that further down in whenReady.
app.on("open-url", (event, url) => {
  event.preventDefault();
  handleClaudeBoardUrl(url);
});

// Register at runtime for dev/unsigned builds. The production
// .app's Info.plist (set via electron-builder build.protocols)
// covers cold-start dispatch; this catches the case where the
// user's running an unbundled `npm start` build.
if (!app.isDefaultProtocolClient("claude-board")) {
  app.setAsDefaultProtocolClient("claude-board");
}

// --- single instance, app lifecycle ----------------------------

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
    // Linux/Windows deliver the URL via argv on second-instance.
    // macOS uses the open-url event instead, but we check argv here
    // for parity (cheap, and protects against future platform tweaks).
    const url = argv.find((a) => typeof a === "string" && a.startsWith("claude-board://"));
    if (url) handleClaudeBoardUrl(url);
  });

  app.whenReady().then(() => {
    buildMenu();
    createMainWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
    });

    // Cold-start dispatch: when macOS launches the app with a URL
    // (because it's not running), the URL lands here. We defer to
    // after createMainWindow so the confirm dialog has a parent.
    const coldUrl = process.argv.find(
      (a) => typeof a === "string" && a.startsWith("claude-board://"),
    );
    if (coldUrl) handleClaudeBoardUrl(coldUrl);
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}

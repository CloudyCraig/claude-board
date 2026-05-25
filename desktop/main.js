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

const { app, BrowserWindow, Menu, dialog, shell, ipcMain } = require("electron");
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

// --- single instance, app lifecycle ----------------------------

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    buildMenu();
    createMainWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}

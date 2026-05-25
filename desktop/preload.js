/**
 * Preload — minimal surface area. We expose just one method to the
 * renderer so the Odin web app (or any local welcome screen we add
 * later) can trigger the Claude launcher without us having to grant
 * the renderer full Node access.
 *
 * Renderer code calls window.heimdallClaudeControl.launchClaude()
 * — main.js handles the IPC and pops the folder picker.
 */

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("heimdallClaudeControl", {
  /** Returns true once the user has picked a folder and Terminal has
   *  been asked to open it; false if they cancelled. */
  launchClaude: () => ipcRenderer.invoke("odin:launch-claude"),

  /** Lets the web app tell whether it's running inside the desktop
   *  shell vs in Safari/Chrome — useful for showing/hiding the
   *  "Launch Claude…" button. */
  isDesktop: true,
  version:  "0.1.0",
});

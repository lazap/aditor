import ReactDOM from "react-dom/client";
import "@xterm/xterm/css/xterm.css";
import "./theme.css";
import { getCurrentWindow } from "@tauri-apps/api/window";
import App from "./App";
import { Settings } from "./components/Settings";
import { TemplatesWindow } from "./components/TemplatePicker";
import { DiffWindow } from "./components/DiffWindow";
import { flush, hydrate, syncWithPeers } from "./settings/store";
import { adopt } from "./shortcuts/store";
import { watchTheme } from "./theme";

/**
 * Every window loads this same page; `?view=` says which one it is. Only the
 * main window mounts App, so only it reaps orphans, spawns agents or installs
 * the menu.
 */
function root() {
  const view = new URLSearchParams(location.search).get("view");
  const close = () => void getCurrentWindow().close();
  // An edit made just before closing is still inside the write debounce, and
  // `beforeunload` cannot wait for an async write. Close-requested can: Tauri
  // holds the window open until this resolves, whichever way it was closed.
  if (view) void getCurrentWindow().onCloseRequested(() => flush());
  if (view === "settings") return <Settings onClose={close} />;
  if (view === "templates") return <TemplatesWindow onClose={close} />;
  if (view === "diff") return <DiffWindow onClose={close} />;
  return <App />;
}

// Deliberately not wrapped in <StrictMode>. Its dev-only double-invoke of
// effects is harmless for pure state, but TerminalPane's effect spawns a real
// agent CLI on a real PTY -- so every launch would start (and bill) two Claude
// Code sessions and immediately kill one. The cleanup path is still correct,
// and is exercised by switching agents; this just avoids paying for it twice
// on every reload.
// Settings come off disk, but everything that reads them does so synchronously
// -- App in lazy state initialisers, `projects.ts` from plain functions. So the
// document is loaded to completion first, and only then does React mount.
// `hydrate` never rejects: a settings file we cannot read is a reason to start
// from defaults, not a reason the app fails to open.
void hydrate().then(() => {
  // The keymap is the one reader that cannot wait for a render: imports are
  // evaluated before the disk read, so it is handed the document explicitly.
  adopt();
  // A rebinding made in the Settings window reaches the keymap -- and through
  // it the menu's accelerators -- here.
  syncWithPeers(adopt);
  // After hydrate, so the first paint is already in the saved theme.
  watchTheme();
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    root(),
  );
});

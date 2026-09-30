import ReactDOM from "react-dom/client";
import "@xterm/xterm/css/xterm.css";
import "./theme.css";
import App from "./App";
import { hydrate } from "./settings/store";
import { adopt } from "./shortcuts/store";

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
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <App />,
  );
});

import ReactDOM from "react-dom/client";
import "@xterm/xterm/css/xterm.css";
import "./theme.css";
import App from "./App";

// Deliberately not wrapped in <StrictMode>. Its dev-only double-invoke of
// effects is harmless for pure state, but TerminalPane's effect spawns a real
// agent CLI on a real PTY -- so every launch would start (and bill) two Claude
// Code sessions and immediately kill one. The cleanup path is still correct,
// and is exercised by switching agents; this just avoids paying for it twice
// on every reload.
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <App />,
);

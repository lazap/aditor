## What this changes

<!-- One or two sentences. Link the issue it closes, if there is one. -->

## How I verified it

<!--
There is no test suite yet, so this section is the review. Say what you ran
and what you clicked through — which pane, which shortcut, which project.
-->

## Checklist

- [ ] `npm run build` passes (this is the typecheck)
- [ ] `cargo clippy` adds no new warnings, from `src-tauri/` (two already exist)
- [ ] I did not run `cargo fmt` — the Rust here is hand-formatted
- [ ] I ran the app and exercised the part I changed
- [ ] A new shortcut, if any, is a single row in `src/shortcuts/registry.ts`
- [ ] A new Tauri command, if any, has its permission in `src-tauri/capabilities/default.json`

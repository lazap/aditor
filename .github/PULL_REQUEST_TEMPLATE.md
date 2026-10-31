## What this changes

<!-- One or two sentences. Link the issue it closes, if there is one. -->

## How I verified it

<!--
The UI has no tests, so for UI changes this section is the review. Say what
you ran and what you clicked through — which pane, which shortcut, which
project.
-->

## Checklist

- [ ] `npm run build` passes (this is the typecheck)
- [ ] `npm test` and `cargo test` (from `src-tauri/`) pass
- [ ] `cargo clippy` adds no new warnings, from `src-tauri/` (two already exist)
- [ ] I did not run `cargo fmt` — the Rust here is hand-formatted
- [ ] I ran the app and exercised the part I changed
- [ ] A new shortcut, if any, is a single row in `src/shortcuts/registry.ts`
- [ ] A new Tauri command, if any, has its permission in `src-tauri/capabilities/default.json`
- [ ] I have read and agree to the [Contributor License Agreement](https://github.com/lazap/aditor/blob/master/CONTRIBUTING.md#contributor-license-agreement)

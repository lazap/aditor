/**
 * The app's commands in the native menu bar.
 *
 * Built on top of `Menu.default()` rather than from scratch: that default is
 * what carries Quit, Hide and the Edit submenu whose Copy and Paste the terminal
 * and the editor rely on. Replacing it wholesale would take those away.
 *
 * Key equivalents come from the shortcuts registry, the same source the in-app
 * dispatch reads, and are updated in place when the user rebinds -- a menu that
 * advertises a chord the app no longer answers to is worse than one that
 * advertises none.
 */
import { Menu, MenuItem, PredefinedMenuItem, Submenu } from "@tauri-apps/api/menu";
import { commandById, type CommandId } from "./shortcuts/registry";
import { chordFor, subscribe } from "./shortcuts/store";

/** The commands that earn a place in the application submenu. */
const IN_MENU: readonly CommandId[] = [
  "app.checkUpdates",
  "app.settings",
  "prompt.templates",
  "app.keepAwake",
];

/** The Find submenu, in order. */
const FIND_MENU: readonly CommandId[] = ["find.files", "find.content"];

/** The Git submenu, in order; null is a separator. */
const GIT_MENU: readonly (CommandId | null)[] = [
  "git.commit",
  "git.push",
  "git.pull",
  "git.pullRebase",
  null,
  "git.rollback",
  "git.showDiff",
  "git.annotate",
  null,
  "git.log",
  null,
  "git.branches",
  "git.newBranch",
  "git.newTag",
  "git.fetch",
  null,
  "git.stageAll",
];

/** The Run submenu, in order; null is a separator. */
const RUN_MENU: readonly (CommandId | null)[] = ["run.run", "run.stop", null, "run.choose", "run.edit"];

/**
 * Chord key tokens -> the names Tauri's accelerator parser accepts.
 *
 * The left-hand side is what `shortcuts/keys.ts` stores, which is `e.code`
 * flavoured; the right-hand side is `keyboard-types`' spelling.
 */
const KEY_NAMES: Record<string, string> = {
  ",": "Comma",
  ".": "Period",
  "/": "Slash",
  "\\": "Backslash",
  "-": "Minus",
  "=": "Equal",
  ";": "Semicolon",
  "'": "Quote",
  "`": "Backquote",
  "[": "BracketLeft",
  "]": "BracketRight",
  space: "Space",
  enter: "Enter",
  escape: "Escape",
  tab: "Tab",
  backspace: "Backspace",
  delete: "Delete",
  home: "Home",
  end: "End",
  pageup: "PageUp",
  pagedown: "PageDown",
  arrowup: "ArrowUp",
  arrowdown: "ArrowDown",
  arrowleft: "ArrowLeft",
  arrowright: "ArrowRight",
};

/**
 * A stored chord as a Tauri accelerator, or null when it cannot be expressed.
 *
 * `mod` means Cmd or Ctrl depending on platform, which is exactly what
 * `CmdOrCtrl` means. Anything this cannot name is dropped rather than guessed:
 * an item with no key equivalent is honest, one with the wrong equivalent is a
 * trap, and a malformed accelerator makes the whole menu call throw.
 */
export function accelerator(chord: string | null): string | null {
  if (!chord) return null;
  const parts = chord.split("+");
  const key = parts.pop();
  if (key === undefined || key === "") return null;

  const mods: string[] = [];
  for (const p of parts) {
    if (p === "mod") mods.push("CmdOrCtrl");
    else if (p === "alt") mods.push("Alt");
    else if (p === "shift") mods.push("Shift");
    else return null;
  }

  const named =
    KEY_NAMES[key] ??
    (/^[a-z0-9]$/.test(key) || /^f([1-9]|1[0-9]|2[0-4])$/.test(key)
      ? key.toUpperCase()
      : null);
  if (named === null) return null;

  return [...mods, named].join("+");
}

/**
 * Where a menu click lands. Set by `installAppMenu`, read at click time, so the
 * menu is built once and still runs App's current handlers -- which are guarded
 * against firing while a modal is up, exactly as the keyboard path is.
 */
let dispatch: ((id: CommandId) => void) | null = null;

/** The menu is built once per page, however many times this is called. */
let installing: Promise<void> | null = null;
/** This page's menu, once built. */
let built: Menu | null = null;

export function installAppMenu(run: (id: CommandId) => void): Promise<void> {
  dispatch = run;
  installing ??= build().catch((e) => {
    // A missing menu bar is a degraded window, not a broken app: every command
    // here is still reachable from its button and its chord.
    console.error("could not install the application menu", e);
  });
  return installing;
}

/**
 * Make this page's menu the app's again. macOS has one menu bar for every
 * window, and a menu's actions run in the page that built it -- so each
 * editor window takes the bar back when it gains focus, or a click there would
 * run the commands of whichever window built the menu last.
 */
export function claimAppMenu(): void {
  void installing?.then(() => built?.setAsAppMenu()).catch(() => {});
}

/**
 * The stock Select All takes ⌘A before the page sees it and has WebKit select
 * what is in the DOM -- for CodeMirror, only the lines drawn around the
 * viewport. This one offers the chord to the focused element first, as a
 * keydown its own keymap can answer, and falls back to the native command only
 * when nothing claimed it.
 */
async function replaceSelectAll(menu: Menu): Promise<void> {
  for (const entry of await menu.items()) {
    if (!(entry instanceof Submenu)) continue;
    const items = await entry.items();
    for (const [at, stock] of items.entries()) {
      if (!(stock instanceof PredefinedMenuItem) || (await stock.text()) !== "Select All") {
        continue;
      }
      await entry.remove(stock);
      await entry.insert(
        await MenuItem.new({
          text: "Select All",
          accelerator: "CmdOrCtrl+A",
          action: selectAllInPage,
        }),
        at,
      );
      return;
    }
  }
}

function selectAllInPage(): void {
  const target = document.activeElement ?? document.body;
  const mac = navigator.platform.startsWith("Mac");
  const claimed = !target.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "a",
      code: "KeyA",
      metaKey: mac,
      ctrlKey: !mac,
      bubbles: true,
      cancelable: true,
    }),
  );
  if (!claimed) document.execCommand("selectAll");
}

async function build(): Promise<void> {
  const menu = await Menu.default();

  const items = new Map<CommandId, MenuItem>();
  const item = async (id: CommandId) => {
    const made = await MenuItem.new({
      id,
      text: commandById(id).label,
      accelerator: accelerator(chordFor(id)) ?? undefined,
      action: () => dispatch?.(id),
    });
    items.set(id, made);
    return made;
  };

  const own: MenuItem[] = [];
  for (const id of IN_MENU) own.push(await item(id));

  const find: MenuItem[] = [];
  for (const id of FIND_MENU) find.push(await item(id));

  const section = async (ids: readonly (CommandId | null)[]) => {
    const out: (MenuItem | PredefinedMenuItem)[] = [];
    for (const id of ids) {
      out.push(
        id === null
          ? await PredefinedMenuItem.new({ item: "Separator" })
          : await item(id),
      );
    }
    return out;
  };
  const git = await section(GIT_MENU);
  const run = await section(RUN_MENU);

  // macOS keeps preferences in the application submenu, which `Menu.default()`
  // builds first. Inserting after the About row assumes only that much; if the
  // default ever stops leading with a submenu, a top-level entry is still better
  // than silently dropping the commands.
  const [first] = await menu.items();
  if (first instanceof Submenu) {
    await first.insert(
      [await PredefinedMenuItem.new({ item: "Separator" }), ...own],
      1,
    );
  } else {
    await menu.append(await Submenu.new({ text: "Commands", items: own }));
  }

  // Before Window and Help, as macOS apps do; at the end if the default has
  // no Window submenu to anchor on.
  const top = await menu.items();
  const titles = await Promise.all(
    top.map((m) => (m instanceof Submenu ? m.text() : Promise.resolve(""))),
  );
  const windowAt = titles.indexOf("Window");
  const subs = [
    await Submenu.new({ text: "Find", items: find }),
    await Submenu.new({ text: "Git", items: git }),
    await Submenu.new({ text: "Run", items: run }),
  ];
  for (const [i, sub] of subs.entries()) {
    if (windowAt >= 0) await menu.insert(sub, windowAt + i);
    else await menu.append(sub);
  }

  await replaceSelectAll(menu);

  await menu.setAsAppMenu();
  built = menu;

  // Rebinding is rare, so resetting the accelerators in place costs nothing
  // and avoids tearing the menu down and building it again.
  subscribe(() => {
    for (const [id, item] of items) {
      void item.setAccelerator(accelerator(chordFor(id)));
    }
  });
}

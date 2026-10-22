import { useCallback, useEffect, useRef, useState } from "react";
import { gitBranches, type BranchInfo, type BranchList } from "../git/api";

/** What a branch's submenu can ask App to do with it. */
export type BranchAction =
  | "checkout"
  | "newFrom"
  | "compare"
  | "showLog"
  | "merge"
  | "rebase"
  | "pull"
  | "push"
  | "rename"
  | "delete";

interface Props {
  root: string;
  /** What the topbar shows: the branch, or a short SHA on a detached HEAD. */
  branch: string;
  /** True while any git write runs; switching then would only be refused. */
  busy: boolean;
  /** The current branch against its upstream, shown on the trigger. */
  ahead: number;
  behind: number;
  /** Bumped by the Branches… command: the menu opens. */
  openRequest: number;
  onCheckout(branch: BranchInfo): void;
  onFetch(): Promise<unknown>;
  onNewBranch(): void;
  onAction(action: BranchAction, branch: BranchInfo): void;
}

interface Sub {
  branch: BranchInfo;
  /** The row's offset in the menu, so the submenu opens beside it. */
  top: number;
}

/**
 * The branch name in the topbar, and IntelliJ's branch popup behind it: a
 * filter, New Branch…, every local and remote branch, and per branch a
 * submenu -- checkout, branch from, compare, merge, rebase, rename, delete.
 *
 * A dropdown on the agent-menu styles, with a filter field on top: a repo can
 * have hundreds of branches, and scrolling for one is slower than typing it.
 * The list is read when the menu opens rather than kept in app state -- it is
 * only ever needed here, and a stale one would offer branches that are gone.
 */
export function BranchPicker({
  root,
  branch,
  busy,
  ahead,
  behind,
  openRequest,
  onCheckout,
  onFetch,
  onNewBranch,
  onAction,
}: Props) {
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<BranchList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [fetching, setFetching] = useState(false);
  const [sub, setSub] = useState<Sub | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const subRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  /** The row a submenu came from, for focus to return to. */
  const subRowRef = useRef<HTMLElement | null>(null);

  const load = useCallback(() => {
    setError(null);
    return gitBranches(root)
      .then(setList)
      .catch((e) => setError(String(e).replace(/^Error:\s*/, "")));
  }, [root]);

  const close = useCallback(() => {
    setOpen(false);
    setSub(null);
    triggerRef.current?.focus();
  }, []);

  // Fresh list and an empty filter on every open.
  useEffect(() => {
    if (!open) return;
    setFilter("");
    setSub(null);
    void load();
    filterRef.current?.focus();
  }, [open, load]);

  const lastRequest = useRef(openRequest);
  useEffect(() => {
    if (openRequest === lastRequest.current) return;
    lastRequest.current = openRequest;
    setOpen(true);
  }, [openRequest]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) {
        setOpen(false);
        setSub(null);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // Into the submenu as soon as it is up, as a keyboard user expects.
  useEffect(() => {
    if (sub) subRef.current?.querySelector<HTMLElement>("button:not(:disabled)")?.focus();
  }, [sub]);

  const needle = filter.trim().toLowerCase();
  const matches = (b: BranchInfo) => b.name.toLowerCase().includes(needle);
  const local = (list?.local ?? []).filter(matches);
  const remote = (list?.remote ?? []).filter(matches);
  const isCurrent = (b: BranchInfo) => !b.remote && b.name === list?.current;

  const openSub = (b: BranchInfo, row: HTMLElement) => {
    const menu = menuRef.current;
    if (!menu) return;
    subRowRef.current = row;
    const top = row.getBoundingClientRect().top - menu.getBoundingClientRect().top;
    setSub((s) => (s?.branch === b ? null : { branch: b, top }));
  };

  const closeSub = () => {
    setSub(null);
    subRowRef.current?.focus();
  };

  const act = (action: BranchAction, b: BranchInfo) => {
    close();
    if (action === "checkout") onCheckout(b);
    else onAction(action, b);
  };

  const fetchRemotes = async () => {
    setFetching(true);
    try {
      await onFetch();
    } finally {
      setFetching(false);
      void load();
    }
  };

  /** The filter field and then every enabled row, in visual order. */
  const items = () =>
    Array.from(
      menuRef.current?.querySelectorAll<HTMLElement>(
        ".branch-main input, .branch-main button:not(:disabled)",
      ) ?? [],
    );

  const onMenuKeyDown = (e: React.KeyboardEvent) => {
    if (sub && subRef.current?.contains(e.target as Node)) return;
    if (e.key === "Escape") {
      e.preventDefault();
      close();
      return;
    }
    const inFilter = document.activeElement === filterRef.current;
    // Enter in the filter checks out the first match, the fast path for
    // "switch to the branch I just typed".
    if (inFilter && e.key === "Enter") {
      e.preventDefault();
      const first = [...local, ...remote].find((b) => !isCurrent(b));
      if (first && !busy) act("checkout", first);
      return;
    }
    const row = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>(
      "[data-branch]",
    );
    if (row && e.key === "ArrowRight") {
      e.preventDefault();
      const b = [...local, ...remote].find(
        (x) => (x.remote ? "r:" : "l:") + x.name === row.dataset.branch,
      );
      if (b) openSub(b, row);
      return;
    }
    // Home/End belong to the text cursor while typing.
    if (inFilter && (e.key === "Home" || e.key === "End")) return;
    const all = items();
    if (all.length === 0) return;
    const i = all.indexOf(document.activeElement as HTMLElement);
    let next: HTMLElement | undefined;
    if (e.key === "ArrowDown") next = all[(i + 1) % all.length];
    else if (e.key === "ArrowUp") next = all[(i - 1 + all.length) % all.length];
    else if (e.key === "Home") next = all[0];
    else if (e.key === "End") next = all[all.length - 1];
    if (next) {
      e.preventDefault();
      setSub(null);
      next.focus();
    }
  };

  const onSubKeyDown = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === "Escape" || e.key === "ArrowLeft") {
      e.preventDefault();
      closeSub();
      return;
    }
    const all = Array.from(
      subRef.current?.querySelectorAll<HTMLElement>("button:not(:disabled)") ?? [],
    );
    const i = all.indexOf(document.activeElement as HTMLElement);
    let next: HTMLElement | undefined;
    if (e.key === "ArrowDown") next = all[(i + 1) % all.length];
    else if (e.key === "ArrowUp") next = all[(i - 1 + all.length) % all.length];
    if (next) {
      e.preventDefault();
      next.focus();
    }
  };

  const row = (b: BranchInfo) => {
    const current = isCurrent(b);
    const key = (b.remote ? "r:" : "l:") + b.name;
    return (
      <button
        key={key}
        data-branch={key}
        className="agent-option branch-option"
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={sub?.branch === b}
        data-active={sub?.branch === b}
        onClick={(e) => openSub(b, e.currentTarget)}
        title={b.upstream ? `Tracks ${b.upstream}` : undefined}
      >
        <span className="agent-check" aria-hidden="true">
          {current ? "✓" : ""}
        </span>
        <span className="agent-option-label branch-option-name">{b.name}</span>
        <Tally ahead={b.ahead} behind={b.behind} />
        <span className="branch-chevron" aria-hidden="true">
          ›
        </span>
      </button>
    );
  };

  const subItems = (b: BranchInfo) => {
    const current = isCurrent(b);
    const here = list?.current ?? "HEAD";
    type Item = { action: BranchAction; label: string; danger?: boolean } | null;
    const all: Item[] = current
      ? [
          { action: "newFrom", label: `New Branch from '${b.name}'…` },
          { action: "showLog", label: "Show Log" },
          null,
          { action: "pull", label: "Update (Pull)" },
          { action: "push", label: "Push…" },
          null,
          { action: "rename", label: "Rename…" },
        ]
      : [
          { action: "checkout", label: "Checkout" },
          { action: "newFrom", label: `New Branch from '${b.name}'…` },
          null,
          { action: "compare", label: `Compare with '${here}'` },
          { action: "showLog", label: "Show Log" },
          null,
          { action: "rebase", label: `Rebase '${here}' onto '${b.name}'` },
          { action: "merge", label: `Merge '${b.name}' into '${here}'` },
          null,
          ...(b.remote ? [] : [{ action: "rename", label: "Rename…" } as Item]),
          { action: "delete", label: "Delete", danger: true },
        ];
    return all.map((it, i) =>
      it === null ? (
        <div key={i} className="agent-menu-sep" role="separator" />
      ) : (
        <button
          key={it.action}
          className="agent-option"
          role="menuitem"
          data-danger={it.danger}
          // Reading actions still work mid-write; anything that writes waits.
          disabled={busy && it.action !== "compare" && it.action !== "showLog"}
          onClick={() => act(it.action, b)}
        >
          <span className="agent-option-label">{it.label}</span>
        </button>
      ),
    );
  };

  return (
    <div className="agent-picker" ref={rootRef}>
      <button
        ref={triggerRef}
        className="branch"
        data-open={open}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
            e.preventDefault();
            setOpen(true);
          }
        }}
        title="Current branch — click for branch actions"
      >
        {branch}
        <Tally ahead={ahead} behind={behind} />
        <span className="agent-caret" aria-hidden="true">
          ▾
        </span>
      </button>

      {open && (
        <div
          className="agent-menu branch-menu"
          role="menu"
          ref={menuRef}
          onKeyDown={onMenuKeyDown}
        >
          <div className="branch-main">
            <input
              ref={filterRef}
              className="branch-filter"
              placeholder="Filter branches…"
              value={filter}
              onChange={(e) => {
                setFilter(e.target.value);
                setSub(null);
              }}
              spellCheck={false}
              aria-label="Filter branches"
            />
            <button
              className="agent-option"
              role="menuitem"
              disabled={busy}
              onClick={() => {
                close();
                onNewBranch();
              }}
            >
              <span className="agent-check" aria-hidden="true">
                +
              </span>
              <span className="agent-option-label">New Branch…</span>
            </button>
            <div className="agent-menu-sep" role="separator" />
            <div className="branch-list" onScroll={() => setSub(null)}>
              {error ? (
                <div className="branch-note">{error}</div>
              ) : list === null ? (
                <div className="branch-note">Loading…</div>
              ) : (
                <>
                  {local.length > 0 && (
                    <div className="branch-section" role="presentation">
                      Local
                    </div>
                  )}
                  {local.map(row)}
                  {remote.length > 0 && (
                    <div className="branch-section" role="presentation">
                      Remote
                    </div>
                  )}
                  {remote.map(row)}
                  {local.length === 0 && remote.length === 0 && (
                    <div className="branch-note">No matching branch.</div>
                  )}
                </>
              )}
            </div>
            <div className="agent-menu-sep" role="separator" />
            <button
              className="agent-option"
              role="menuitem"
              disabled={busy || fetching}
              onClick={() => void fetchRemotes()}
            >
              <span className="agent-check" aria-hidden="true" />
              <span className="agent-option-label">
                {fetching ? "Fetching…" : "Fetch remotes"}
              </span>
            </button>
          </div>

          {sub && (
            <div
              className="agent-menu branch-submenu"
              role="menu"
              ref={subRef}
              style={{ top: sub.top }}
              onKeyDown={onSubKeyDown}
            >
              {subItems(sub.branch)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** ↑2 ↓1, IntelliJ's incoming/outgoing marks; nothing when in step. */
function Tally({ ahead, behind }: { ahead: number; behind: number }) {
  if (!ahead && !behind) return null;
  return (
    <span className="branch-tally" title={`${ahead} to push, ${behind} to pull`}>
      {ahead > 0 && <span>↑{ahead}</span>}
      {behind > 0 && <span>↓{behind}</span>}
    </span>
  );
}

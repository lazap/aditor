import { useCallback, useEffect, useRef, useState } from "react";
import { gitBranches, type BranchInfo, type BranchList } from "../git/api";

interface Props {
  /** What the topbar shows: the branch, or a short SHA on a detached HEAD. */
  branch: string;
  /** True while any git write runs; switching then would only be refused. */
  busy: boolean;
  onCheckout(branch: BranchInfo): void;
  onFetch(): Promise<unknown>;
}

/**
 * The branch name in the topbar, and the menu behind it for switching to
 * another local branch or checking out a remote one.
 *
 * Same menu mechanics as AgentPicker, plus a filter field on top: a repo can
 * have hundreds of branches, and scrolling for one is slower than typing it.
 * The list is read when the menu opens rather than kept in app state -- it is
 * only ever needed here, and a stale one would offer branches that are gone.
 */
export function BranchPicker({ branch, busy, onCheckout, onFetch }: Props) {
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<BranchList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [fetching, setFetching] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);

  const load = useCallback(() => {
    setError(null);
    return gitBranches()
      .then(setList)
      .catch((e) => setError(String(e).replace(/^Error:\s*/, "")));
  }, []);

  const close = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);

  // Fresh list and an empty filter on every open.
  useEffect(() => {
    if (!open) return;
    setFilter("");
    void load();
    filterRef.current?.focus();
  }, [open, load]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const needle = filter.trim().toLowerCase();
  const matches = (b: BranchInfo) => b.name.toLowerCase().includes(needle);
  const local = (list?.local ?? []).filter(matches);
  const remote = (list?.remote ?? []).filter(matches);

  // Picking the branch you are on is a no-op rather than a pointless switch.
  const pick = (b: BranchInfo) => {
    close();
    if (!(!b.remote && b.name === list?.current)) onCheckout(b);
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
        "input, button:not(:disabled)",
      ) ?? [],
    );

  const onMenuKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
      return;
    }
    const inFilter = document.activeElement === filterRef.current;
    if (inFilter && e.key === "Enter") {
      e.preventDefault();
      const first = [...local, ...remote].find(
        (b) => b.remote || b.name !== list?.current,
      );
      if (first && !busy) pick(first);
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
      next.focus();
    }
  };

  const row = (b: BranchInfo) => {
    const current = !b.remote && b.name === list?.current;
    return (
      <button
        key={(b.remote ? "r:" : "l:") + b.name}
        className="agent-option branch-option"
        role="menuitemradio"
        aria-checked={current}
        disabled={busy}
        onClick={() => pick(b)}
        title={b.upstream ? `Tracks ${b.upstream}` : undefined}
      >
        <span className="agent-check" aria-hidden="true">
          {current ? "✓" : ""}
        </span>
        <span className="agent-option-label branch-option-name">{b.name}</span>
      </button>
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
        title="Current branch — click to switch"
      >
        {branch}
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
          <input
            ref={filterRef}
            className="branch-filter"
            placeholder="Filter branches…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            spellCheck={false}
            aria-label="Filter branches"
          />
          <div className="branch-list">
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
      )}
    </div>
  );
}

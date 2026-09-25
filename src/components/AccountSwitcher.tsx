import { useCallback, useEffect, useRef, useState } from "react";
import {
  claudeAccounts,
  forgetAccount,
  renameAccount,
  saveCurrentAccount,
  switchAccount,
  type Account,
  type Accounts,
} from "../accounts/api";

interface Props {
  /** Bumped by the workspace watcher and by `agents://changed`. */
  refreshToken: number;
  /** Re-read the session and limit data, which belong to the old account. */
  onChanged(): void;
}

/**
 * Which Claude Code account the agent is logged in as, and the ones saved to
 * switch to.
 *
 * A switch swaps the credential and the identity underneath the running agent:
 * the PTY, the session and the conversation are untouched, which is the whole
 * point of doing this here rather than in a terminal.
 */
export function AccountSwitcher({ refreshToken, onChanged }: Props) {
  const [data, setData] = useState<Accounts | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  // When the switch lands. Null once the agent has certainly picked it up.
  const [settlesAt, setSettlesAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    try {
      setData(await claudeAccounts());
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, refreshToken]);

  // Only ticks while a switch is still settling.
  useEffect(() => {
    if (settlesAt === null) return;
    const id = window.setInterval(() => {
      const t = Date.now();
      setNow(t);
      if (t >= settlesAt) setSettlesAt(null);
    }, 1000);
    return () => window.clearInterval(id);
  }, [settlesAt]);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await load();
      onChanged();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const pick = (a: Account) => {
    if (a.isActive || busy) return;
    const settle = (data?.settleSeconds ?? 0) * 1000;
    void act(async () => {
      await switchAccount(a.uuid);
      setSettlesAt(settle > 0 ? Date.now() + settle : null);
    });
  };

  if (data && !data.supported) {
    return (
      <div className="insight-section">
        <div className="changes-header" role="heading" aria-level={2}>
          Account
        </div>
        <div className="insight-note">{data.reason}</div>
      </div>
    );
  }

  const accounts = data?.accounts ?? [];
  const remaining = settlesAt ? Math.max(0, Math.ceil((settlesAt - now) / 1000)) : 0;

  return (
    <div className="insight-section">
      <div className="changes-header" role="heading" aria-level={2}>
        Account
        <button
          className="iaccount-add"
          onClick={() => void act(saveCurrentAccount)}
          disabled={busy}
          title={
            data?.activeSaved
              ? "Update the saved copy of the account you are signed in as"
              : `Save the account you are signed in as, read from the ${data?.store ?? "credential store"}`
          }
        >
          {data?.activeSaved ? "Update current" : "+ Save current"}
        </button>
      </div>

      {error && <div className="tree-error">{error}</div>}

      {accounts.length === 0 ? (
        <div className="insight-empty">
          {data?.activeEmail
            ? `Signed in as ${data.activeEmail}. Save it, then ‘claude /login’ to a second account and save that one too.`
            : "No Claude Code login found."}
        </div>
      ) : (
        <div className="iaccounts" role="radiogroup" aria-label="Claude Code account">
          {accounts.map((a) => (
            <div className="iaccount" key={a.uuid} data-active={a.isActive}>
              {renaming === a.uuid ? (
                <RenameField
                  initial={a.label}
                  onCancel={() => setRenaming(null)}
                  onCommit={(label) => {
                    setRenaming(null);
                    if (label !== a.label) void act(() => renameAccount(a.uuid, label));
                  }}
                />
              ) : (
                <>
                  <button
                    className="iaccount-pick"
                    role="radio"
                    aria-checked={a.isActive}
                    disabled={busy || a.isActive}
                    onClick={() => pick(a)}
                    title={a.isActive ? a.email : `Switch to ${a.email}`}
                  >
                    <span className="iaccount-mark" aria-hidden>
                      {a.isActive ? "●" : "○"}
                    </span>
                    <span className="iaccount-label">{a.label}</span>
                    {a.isActive && <span className="iaccount-state">active</span>}
                  </button>
                  {confirming === a.uuid ? (
                    <span className="iaccount-confirm">
                      <button
                        className="iaccount-act"
                        onClick={() => {
                          setConfirming(null);
                          void act(() => forgetAccount(a.uuid));
                        }}
                      >
                        Forget
                      </button>
                      <button className="iaccount-act" onClick={() => setConfirming(null)}>
                        Keep
                      </button>
                    </span>
                  ) : (
                    <span className="iaccount-tools">
                      <button
                        className="iaccount-act"
                        onClick={() => setRenaming(a.uuid)}
                        title="Rename"
                      >
                        {"✎"}
                      </button>
                      <button
                        className="iaccount-act"
                        onClick={() => setConfirming(a.uuid)}
                        title="Forget this account"
                      >
                        {"✕"}
                      </button>
                    </span>
                  )}
                </>
              )}
            </div>
          ))}
        </div>
      )}

      {confirming && (
        <div className="insight-note">
          Forgetting drops the only saved copy of that login. Signing back into it
          needs <code>claude /login</code>.
        </div>
      )}

      {remaining > 0 && (
        <div className="insight-note" role="status">
          Switched. The running session keeps going and picks the new account up
          in {remaining}s.
        </div>
      )}

      {!data?.activeSaved && data?.activeEmail && accounts.length > 0 && (
        <div className="insight-note">
          Signed in as {data.activeEmail}, which is not saved here. Save it before
          switching, or its login is lost.
        </div>
      )}
    </div>
  );
}

/** Rename in place. Enter commits, Escape abandons, blur commits. */
function RenameField({
  initial,
  onCommit,
  onCancel,
}: {
  initial: string;
  onCommit(label: string): void;
  onCancel(): void;
}) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);

  // Focus pulls the caret out of xterm, which otherwise swallows the keys.
  useEffect(() => ref.current?.select(), []);

  return (
    <input
      ref={ref}
      className="iaccount-rename"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => onCommit(value.trim())}
      onKeyDown={(e) => {
        if (e.key === "Enter") onCommit(value.trim());
        if (e.key === "Escape") onCancel();
        e.stopPropagation();
      }}
    />
  );
}

import { useEffect, useState } from "react";
import {
  BADGE,
  gitCommitDetails,
  gitOutgoing,
  type CommitDetails,
  type Outgoing,
} from "../git/api";
import { openLogWindow } from "../window";
import { Modal } from "./Modal";
import { relativeTime } from "../git/format";

interface Props {
  root: string;
  onPush(opts: { force: boolean; tags: boolean }): void;
  onCancel(): void;
}

/**
 * IntelliJ's Push dialog: what is about to leave, where it goes, and how.
 * A commit unfolds into its files; a file opens that commit in the log.
 */
export function PushDialog({ root, onPush, onCancel }: Props) {
  const [outgoing, setOutgoing] = useState<Outgoing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [details, setDetails] = useState<Map<string, CommitDetails>>(new Map());
  const [force, setForce] = useState(false);
  const [tags, setTags] = useState(false);

  useEffect(() => {
    gitOutgoing(root)
      .then(setOutgoing)
      .catch((e) => setError(String(e).replace(/^Error:\s*/, "")));
  }, [root]);

  const toggle = (id: string) => {
    setOpen((o) => (o === id ? null : id));
    if (details.has(id)) return;
    void gitCommitDetails(root, id)
      .then((d) => setDetails((prev) => new Map(prev).set(id, d)))
      .catch(() => {});
  };

  const commits = outgoing?.commits ?? [];
  const nothing = outgoing !== null && commits.length === 0;

  return (
    <Modal
      title="Push Commits"
      wide
      confirm={force ? "Force Push" : "Push"}
      danger={force}
      // Nothing to send can still mean tags to send, or a force to make.
      canConfirm={outgoing?.branch != null && (!nothing || tags || force)}
      onConfirm={() => onPush({ force, tags })}
      onCancel={onCancel}
    >
      <div className="push-target">
        {outgoing === null && !error ? (
          "Loading…"
        ) : outgoing?.branch ? (
          <>
            <span className="push-branch">{outgoing.branch}</span>
            <span aria-hidden="true">→</span>
            <span className="push-branch">{outgoing.target ?? "no remote"}</span>
            {outgoing.target && !commits.length && <span className="modal-hint">up to date</span>}
          </>
        ) : (
          error ?? "HEAD is detached: check out a branch to push."
        )}
      </div>
      {commits.length > 0 && (
        <div className="push-commits">
          {commits.map((c) => (
            <div key={c.id} className="push-commit" data-open={open === c.id}>
              <button className="push-commit-row" onClick={() => toggle(c.id)}>
                <span className="push-twisty" aria-hidden="true">
                  {open === c.id ? "▾" : "▸"}
                </span>
                <span className="push-subject">{c.subject}</span>
                <span className="push-meta">
                  {c.author} · {relativeTime(c.time)}
                </span>
              </button>
              {open === c.id && (
                <div className="push-files">
                  {details.get(c.id)?.files.map((f) => (
                    <button
                      key={f.path}
                      className="push-file"
                      title="Show this commit in the log"
                      onClick={() => void openLogWindow({ root, select: c.id, file: f.path })}
                    >
                      <span className="tree-status" data-status={f.kind}>
                        {BADGE[f.kind]}
                      </span>
                      {f.rel}
                    </button>
                  )) ?? <div className="modal-hint">Loading…</div>}
                </div>
              )}
            </div>
          ))}
          {outgoing?.more && <div className="modal-hint">…and more</div>}
        </div>
      )}
      <label className="modal-check">
        <input type="checkbox" checked={tags} onChange={(e) => setTags(e.target.checked)} />
        <span>Push tags (annotated tags on pushed commits)</span>
      </label>
      <label className="modal-check">
        <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />
        <span>
          Force push <span className="modal-hint">— with lease: refuses if the remote moved</span>
        </span>
      </label>
    </Modal>
  );
}

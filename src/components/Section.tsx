import { type ReactNode } from "react";
import { patchLayout, settings, useSetting } from "../settings/store";

interface Props {
  /** Stable key for the remembered state. Renaming one forgets that band. */
  id: string;
  title: string;
  /** A pill after the title. Omitted where there is nothing worth counting. */
  count?: number;
  /** Governs a band until the user has an opinion about it. */
  defaultOpen?: boolean;
  /** Controls belonging to the band, kept outside the toggle's hit area. */
  actions?: ReactNode;
  children: ReactNode;
}

/**
 * A titled, collapsible band in the right-hand panel.
 *
 * The disclosure is a button *inside* the heading rather than the heading
 * itself: the Account band carries its own action, and one clickable region
 * nested in another is how you save an account while meaning to collapse it.
 *
 * Open state lives in `layout.sections` rather than in component state. The
 * panel unmounts whenever it is hidden (see `App.tsx`), so anything local is
 * forgotten the moment you close the rail.
 */
export function Section({
  id,
  title,
  count,
  defaultOpen = true,
  actions,
  children,
}: Props) {
  const stored = useSetting((s): boolean | undefined => s.layout.sections[id]);
  const open = stored ?? defaultOpen;

  const toggle = () => {
    const next = !open;
    const rest = { ...settings().layout.sections };
    // Record the deviation, not the state: back at the default, the entry goes
    // away and the default governs again.
    if (next === defaultOpen) delete rest[id];
    else rest[id] = next;
    patchLayout({ sections: rest });
  };

  return (
    <div className="insight-section">
      <div className="section-head" role="heading" aria-level={2}>
        <button className="section-toggle" onClick={toggle} aria-expanded={open}>
          <span className="tree-chevron">{open ? "▾" : "▸"}</span>
          {title}
          {count !== undefined && <span className="changes-count">{count}</span>}
        </button>
        {actions}
      </div>

      {open && children}
    </div>
  );
}

/** How the log and the blame gutter say when something happened. */

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "just now", "5 min ago", "3 hours ago", "yesterday", then a date. */
export function relativeTime(seconds: number, now = Date.now() / 1000): string {
  const ago = now - seconds;
  if (ago < MINUTE) return "just now";
  if (ago < HOUR) return `${Math.floor(ago / MINUTE)} min ago`;
  if (ago < DAY) {
    const h = Math.floor(ago / HOUR);
    return `${h} hour${h === 1 ? "" : "s"} ago`;
  }
  if (ago < 2 * DAY) return "yesterday";
  if (ago < 7 * DAY) return `${Math.floor(ago / DAY)} days ago`;
  return shortDate(seconds);
}

/** The year only when it is not this one, as IntelliJ's log does. */
export function shortDate(seconds: number): string {
  const d = new Date(seconds * 1000);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

export function fullDate(seconds: number): string {
  return new Date(seconds * 1000).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

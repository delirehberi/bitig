/** Relative times and day labels for the dashboard, in the viewer's local time. */

const MS_PER_MINUTE = 60_000;
const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;

const relativeTime = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

/** "just now", "5 minutes ago", "3 hours ago", "yesterday", "4 days ago". */
export function formatTimeAgo(iso: string, now: Date): string {
  const minutes = Math.round((Date.parse(iso) - now.getTime()) / MS_PER_MINUTE);
  if (minutes > -1) return "just now";
  if (minutes > -MINUTES_PER_HOUR) return relativeTime.format(minutes, "minute");
  const hours = Math.round(minutes / MINUTES_PER_HOUR);
  if (hours > -HOURS_PER_DAY) return relativeTime.format(hours, "hour");
  return relativeTime.format(-daysBetween(new Date(iso), now), "day");
}

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** Whole calendar days from `from` to `to`, in local time. */
function daysBetween(from: Date, to: Date): number {
  return Math.round((startOfDay(to) - startOfDay(from)) / (MS_PER_MINUTE * MINUTES_PER_HOUR * HOURS_PER_DAY));
}

/** "Today", "Yesterday", or a short date such as "Tue 20 Oct". */
export function formatDayLabel(iso: string, now: Date): string {
  const date = new Date(iso);
  const days = daysBetween(date, now);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return date.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
}

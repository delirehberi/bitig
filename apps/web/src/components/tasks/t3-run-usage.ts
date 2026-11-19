const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;

/** Formats a run duration as `45s`, `3m 05s`, or `1h 02m` (#BIT-163). */
export function formatRunElapsed(elapsedMs: number): string {
  const totalSeconds = Math.round(elapsedMs / MS_PER_SECOND);
  if (totalSeconds < SECONDS_PER_MINUTE) return `${String(totalSeconds)}s`;
  const totalMinutes = Math.floor(totalSeconds / SECONDS_PER_MINUTE);
  const seconds = totalSeconds % SECONDS_PER_MINUTE;
  if (totalMinutes < MINUTES_PER_HOUR) {
    return `${String(totalMinutes)}m ${String(seconds).padStart(2, "0")}s`;
  }
  const hours = Math.floor(totalMinutes / MINUTES_PER_HOUR);
  const minutes = totalMinutes % MINUTES_PER_HOUR;
  return `${String(hours)}h ${String(minutes).padStart(2, "0")}m`;
}

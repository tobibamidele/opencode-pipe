/** Shared time helpers. */

/** Current unix time in milliseconds. */
export function now(): number {
  return Date.now();
}

/** IS0-8601 representation for display purposes. */
export function formatTime(ms: number): string {
  return new Date(ms).toISOString();
}

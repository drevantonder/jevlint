/** Schedule a retry after the given delay in milliseconds. */
export function scheduleRetry(timeoutMs: number) {
  setTimeout(() => scheduleRetry(timeoutMs), timeoutMs);
}

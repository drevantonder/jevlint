export function scheduleRetry(timeout: number) {
  setTimeout(() => scheduleRetry(timeout), timeout);
}

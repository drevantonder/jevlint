export function connect(host: string, timeoutMs: number): string {
  return `${host}:${timeoutMs}`;
}

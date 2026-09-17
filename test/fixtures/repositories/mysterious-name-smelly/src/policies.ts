export function normalizeRetry(values: string[]): string[] {
  return values.map((value) => value.trim());
}

export function handle(values: string[]): string[] {
  return normalizeRetry(values);
}

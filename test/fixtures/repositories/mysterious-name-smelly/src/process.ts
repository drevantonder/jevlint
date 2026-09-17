import { normalizeRetry } from "./policies.js";

export function process(data: string[]): string[] {
  const x = normalizeRetry(data);
  const tmp: string[] = [];
  for (const item of x) {
    const result = item.trim();
    if (result.length > 0) tmp.push(result);
  }
  return tmp;
}

import { fetchJson } from "./network.js";

export function total(lines: string[]): number {
  return lines.length;
}

export async function loadTotal(): Promise<number> {
  return total(await fetchJson());
}

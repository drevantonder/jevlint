import { collectMatches } from "./collect-matches.js";
import type { Match } from "./collect-matches.js";

export function searchAll(queries: string[]): number {
  let total = 0;
  for (const query of queries) {
    const acc: Match[] = [];
    collectMatches(query, acc);
    total += acc.length;
  }
  return total;
}

export interface Match {
  start: number;
  end: number;
}

export function collectMatches(query: string, out: Match[]): void {
  const words = query.split(" ");
  for (const word of words) {
    out.push({ start: query.indexOf(word), end: query.indexOf(word) + word.length });
  }
}

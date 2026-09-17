export interface Match {
  start: number;
  end: number;
}

export function collectMatches(query: string): Match[] {
  return query.split(" ").map((word) => ({
    start: query.indexOf(word),
    end: query.indexOf(word) + word.length,
  }));
}

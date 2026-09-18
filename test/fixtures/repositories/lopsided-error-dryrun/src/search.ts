function dryAsk(query: string): string {
  return "dry-run:" + query;
}

export async function search(query: string): Promise<string> {
  let first: string;
  try {
    first = dryAsk(query);
  } catch {
    first = "fallback";
  }
  const second = dryAsk(query);
  return `${first}:${second}`;
}

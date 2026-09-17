export function total(lines: string[]): number {
  return lines.length;
}

export async function fetchLines(): Promise<string[]> {
  return ["a", "b"];
}

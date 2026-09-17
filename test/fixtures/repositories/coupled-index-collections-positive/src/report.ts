export function buildReport(names: string[], scores: number[]): string[] {
  const lines: string[] = [];
  for (let i = 0; i < names.length; i += 1) {
    lines.push(`${names[i]}: ${scores[i]}`);
  }
  return lines;
}

export function describeForSplitter(path: string): string {
  return `split:${path}`;
}

export function splitReport(files: string[]): string[] {
  return files.map(describeForSplitter);
}

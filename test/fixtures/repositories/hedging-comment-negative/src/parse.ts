// Split on commas; quoted fields are handled by the caller contract below.
export function parseRow(input: string): string[] {
  return input.split(",");
}

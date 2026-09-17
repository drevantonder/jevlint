import Papa from "papaparse";

export function parseUpload(input: string): Papa.ParseResult<Record<string, string>> {
  return Papa.parse(input, { header: true });
}

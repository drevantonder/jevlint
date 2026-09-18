import { readFile } from "node:fs/promises";

export async function loadPrefixed(name: string): Promise<string> {
  return readFile(name, "utf8");
}

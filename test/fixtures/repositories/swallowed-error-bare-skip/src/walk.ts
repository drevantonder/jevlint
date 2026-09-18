import { promises as fs } from "node:fs";

let skipped = 0;

export function skippedCount(): number {
  return skipped;
}

export async function walk(root: string): Promise<string[]> {
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    // Before the split: every failure, vanished path or real breakdown,
    // became the same bare skip with no reason recorded anywhere.
    skipped += 1;
    return [];
  }

  const found: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      found.push(...await walk(`${root}/${entry.name}`));
    } else {
      found.push(`${root}/${entry.name}`);
    }
  }
  return found;
}

import { promises as fs } from "node:fs";
import type { Coverage } from "./coverage.js";

export async function walk(root: string, coverage: Coverage): Promise<string[]> {
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    // Vanished paths are ordinary absence: the entry raced away between
    // observation and use (removed file, dangling link, unmounted path).
    if (
      error instanceof Error
      && (error.code === "ENOENT" || error.code === "ENOTDIR" || error.code === "ELOOP")
    ) {
      return [];
    }
    // Anything else is a breakdown the caller must hear about: carry the
    // reason per path, stream it to stderr, and mark coverage incomplete.
    const reason = error instanceof Error ? error.message : String(error);
    process.stderr.write(`walk: skipping ${root}: ${reason}\n`);
    coverage.skipped.push({ path: root, reason });
    coverage.complete = false;
    return [];
  }

  const found: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      found.push(...await walk(`${root}/${entry.name}`, coverage));
    } else {
      found.push(`${root}/${entry.name}`);
    }
  }
  return found;
}

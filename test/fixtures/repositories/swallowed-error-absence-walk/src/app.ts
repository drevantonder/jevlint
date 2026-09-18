import type { Coverage } from "./coverage.js";
import { walk } from "./walk.js";

export async function run(root: string): Promise<Coverage> {
  const coverage: Coverage = { skipped: [], complete: true };
  await walk(root, coverage);
  return coverage;
}

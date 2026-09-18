import { skippedCount, walk } from "./walk.js";

export async function run(root: string): Promise<{ files: string[]; skipped: number }> {
  const files = await walk(root);
  return { files, skipped: skippedCount() };
}

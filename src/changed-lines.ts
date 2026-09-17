import type { LineRange } from "./types.js";

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

export function parseChangedLineRanges(diff: string): LineRange[] {
  const ranges: LineRange[] = [];

  for (const line of diff.split("\n")) {
    const match = HUNK_HEADER.exec(line);
    if (!match) continue;

    const start = Number(match[1]);
    const count = match[2] === undefined ? 1 : Number(match[2]);
    if (count === 0) continue;

    ranges.push({ start, end: start + count - 1 });
  }

  return ranges;
}

export type SkippedEntry = { path: string; reason: string };

export type Coverage = { skipped: SkippedEntry[]; complete: boolean };

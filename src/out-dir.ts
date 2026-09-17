import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { sortAbstentions, sortJudgments } from "./analyze.js";
import type {
  FileReviewArtifact,
  Judgment,
  ReviewReport,
  StructuralAbstentionCount,
} from "./types.js";

export function artifactFileName(filePath: string): string {
  if (isAbsolute(filePath) || filePath.split("/").includes("..") || filePath === "") {
    throw new Error(`jevlint: refusing to write artifact outside the output directory: ${filePath}`);
  }
  return `${filePath}.json`;
}

export function createFileArtifact(
  filePath: string,
  judgments: Judgment[],
  abstentions: StructuralAbstentionCount[],
): FileReviewArtifact {
  const sortedAbstentions = sortAbstentions(abstentions);
  return {
    version: 1,
    filePath,
    summary: {
      evaluated: judgments.length,
      abstained: sortedAbstentions.reduce((total, abstention) => total + abstention.count, 0),
    },
    judgments: sortJudgments(judgments),
    abstentions: sortedAbstentions,
  };
}

export async function writeFileArtifact(
  outDir: string,
  artifact: FileReviewArtifact,
): Promise<void> {
  const path = join(outDir, artifactFileName(artifact.filePath));
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(artifact, null, 2)}\n`);
}

export async function writeSummaryArtifact(
  outDir: string,
  report: ReviewReport,
): Promise<void> {
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, "summary.json"), `${JSON.stringify(report, null, 2)}\n`);
}

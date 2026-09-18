import type { Candidate, ProjectFile, SourceFile } from "../types.js";
import {
  buildModuleEvidence,
  dirOf,
  isFrameworkScaffolded,
  isSourcePath,
  isTestFile,
  plainStem,
  testStem,
} from "./module.js";
import type { ModuleEvidence } from "./module.js";

export type FarAwayTestEvidence = {
  module: ModuleEvidence;
  test: {
    filePath: string;
    dir: string;
    stem: string;
  };
  subject: {
    candidates: string[];
    dir: string | null;
  };
  distanceSegments: number;
  repoNorm: {
    testFiles: number;
    colocated: number;
    agreement: number;
  };
};

function subjectCandidates(stem: string, testPath: string, projectFiles: ProjectFile[]): string[] {
  const found: string[] = [];
  for (const file of projectFiles) {
    if (file.filePath === testPath) continue;
    if (!isSourcePath(file.filePath)) continue;
    if (isTestFile(file.filePath, projectFiles)) continue;
    if (plainStem(file.filePath) !== stem) continue;
    found.push(file.filePath);
    if (found.length >= 5) break;
  }
  return found.sort();
}

function distanceBetweenDirs(left: string, right: string): number {
  const leftSegments = left === "" ? [] : left.split("/");
  const rightSegments = right === "" ? [] : right.split("/");
  let common = 0;
  while (
    common < leftSegments.length
    && common < rightSegments.length
    && leftSegments[common] === rightSegments[common]
  ) {
    common += 1;
  }
  return leftSegments.length + rightSegments.length - common * 2;
}

export function buildFarAwayTestEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
  changes: SourceFile[] = [],
): FarAwayTestEvidence | undefined {
  if (candidate.kind !== "module") return undefined;
  if (!isTestFile(candidate.filePath, projectFiles)) return undefined;
  if (isFrameworkScaffolded(candidate.filePath)) return undefined;
  const module = buildModuleEvidence(candidate.filePath, changes, projectFiles);
  if (!module) return undefined;
  const norm = module.repoNorms.testPlacement;
  if (norm.testFiles < 5 || norm.value !== "colocated") return undefined;

  const stem = testStem(candidate.filePath) ?? plainStem(candidate.filePath);
  const dir = dirOf(candidate.filePath);
  const siblings = projectFiles.some((file) =>
    file.filePath !== candidate.filePath
    && dirOf(file.filePath) === dir
    && plainStem(file.filePath) === stem
    && !isTestFile(file.filePath, projectFiles)
  );
  if (siblings) return undefined;

  const subjects = subjectCandidates(stem, candidate.filePath, projectFiles);
  const subjectDir = subjects.length > 0 ? dirOf(subjects[0]!) : null;
  return {
    module,
    test: { filePath: candidate.filePath, dir, stem },
    subject: { candidates: subjects, dir: subjectDir },
    distanceSegments: subjectDir === null ? -1 : distanceBetweenDirs(dir, subjectDir),
    repoNorm: { testFiles: norm.testFiles, colocated: norm.colocated, agreement: norm.agreement },
  };
}

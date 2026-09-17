import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildStabilityInversionEvidence } from "../src/evidence/stability-inversion.js";
import type { ProjectFile } from "../src/types.js";

const owner = `import type { Profile } from "./internal/profile.js";
export interface User {
  id: string;
  profile: Profile;
}
`;

const internalProfile = `/** @internal Test-only shape, do not depend on this. */
export interface Profile {
  nickname: string;
}
`;

const consumer = `import type { User } from "./types.js";
export function greet(user: User): string {
  return user.id;
}
`;

const calmTarget = `export interface Profile {
  nickname: string;
}
`;

const calmConsumer = `import type { Profile } from "./profile.js";
export function shortName(profile: Profile): string {
  return profile.nickname;
}
`;

function candidateFor(source: string) {
  const candidate = extractCandidates("src/types.ts", source)
    .find(({ kind }) => kind === "abstraction");
  expect(candidate).toBeDefined();
  if (!candidate) throw new Error("Fixture has no abstraction candidate.");
  return candidate;
}

describe("stability inversion evidence", () => {
  it("reports a stable abstraction depending on an internal test-marked module", () => {
    const projectFiles: ProjectFile[] = [
      { filePath: "src/types.ts", source: owner },
      { filePath: "src/internal/profile.ts", source: internalProfile },
      { filePath: "src/greet.ts", source: consumer },
    ];

    const evidence = buildStabilityInversionEvidence(candidateFor(owner), projectFiles);

    expect(evidence).toMatchObject({
      abstraction: { name: "User", exported: true },
      direction: "stable-depends-on-volatile",
      ownerImporters: { count: 1, files: ["src/greet.ts"] },
    });
    expect(evidence?.dependencies).toHaveLength(1);
    expect(evidence?.dependencies[0]).toMatchObject({
      symbol: "Profile",
      targetModule: "src/internal/profile.ts",
      volatility: {
        importerCount: 1,
        internalPath: true,
        internalAnnotation: true,
      },
    });
  });

  it("reports calm targets with no volatility markers", () => {
    const localOwner = owner.replace("./internal/profile.js", "./profile.js");
    const projectFiles: ProjectFile[] = [
      { filePath: "src/types.ts", source: localOwner },
      { filePath: "src/profile.ts", source: calmTarget },
      { filePath: "src/render.ts", source: calmConsumer.replace("./profile.js", "./profile.js") },
    ];

    const evidence = buildStabilityInversionEvidence(candidateFor(localOwner), projectFiles);

    expect(evidence?.dependencies[0]).toMatchObject({
      targetModule: "src/profile.ts",
      volatility: {
        testOrFixturePath: false,
        internalPath: false,
        internalAnnotation: false,
      },
    });
  });

  it("abstains when the abstraction references no project module", () => {
    const standalone = `export interface User {
  id: string;
  nickname: string;
}
`;
    const projectFiles: ProjectFile[] = [{ filePath: "src/types.ts", source: standalone }];
    expect(buildStabilityInversionEvidence(candidateFor(standalone), projectFiles)).toBeUndefined();
  });
});

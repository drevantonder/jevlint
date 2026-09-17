import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildModeFlagParameterEvidence } from "../src/evidence/mode-flag-parameter.js";
import type { ProjectFile } from "../src/types.js";

const reportSource = `export interface User {
  name: string;
  email: string;
}

export function renderUser(user: User, detailed: boolean): string {
  if (detailed) {
    const header = "Name: " + user.name;
    const contact = "Email: " + user.email;
    return header + "\\n" + contact;
  }
  return "Name: " + user.name;
}
`;

const pageSource = `import { renderUser } from "./report.js";
import type { User } from "./report.js";

export function summaryPage(user: User): string {
  return renderUser(user, false);
}

export function detailPage(user: User): string {
  return renderUser(user, true);
}
`;

function candidate(source: string, filePath: string) {
  return extractCandidates(filePath, source).find(({ kind }) => kind === "function");
}

describe("mode flag parameter evidence", () => {
  it("extracts a boolean flag with disjoint paths and literal call sites", () => {
    const files: ProjectFile[] = [
      { filePath: "src/report.ts", source: reportSource },
      { filePath: "src/page.ts", source: pageSource },
    ];
    const fn = candidate(reportSource, "src/report.ts");
    expect(fn).toBeDefined();
    if (!fn) return;

    const evidence = buildModeFlagParameterEvidence(fn, files);

    expect(evidence).toMatchObject({
      function: { name: "renderUser", filePath: "src/report.ts" },
      flag: {
        name: "detailed",
        booleanAnnotated: true,
        booleanDefault: false,
        optionsBag: false,
        uses: [expect.objectContaining({ kind: "if", test: "detailed" })],
      },
      callSites: {
        trueCount: 1,
        falseCount: 1,
        otherCount: 0,
      },
    });
    expect(evidence?.branchOverlap).toMatchObject({ disjoint: true });
  });

  it("abstains when no parameter feeds a branch", () => {
    const source = `export function greet(name: string): string {
      return "hello " + name;
    }
    `;
    const fn = candidate(source, "src/greet.ts");
    expect(fn).toBeDefined();
    if (!fn) return;

    expect(buildModeFlagParameterEvidence(fn, [{ filePath: "src/greet.ts", source }])).toBeUndefined();
  });
});

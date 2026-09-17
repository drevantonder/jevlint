import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildUnsafeRedirectTargetEvidence } from "../src/evidence/unsafe-redirect-target.js";
import type { ProjectFile } from "../src/types.js";

function project(ownerSource: string) {
  const projectFiles: ProjectFile[] = [{ filePath: "src/auth.ts", source: ownerSource }];
  const candidate = extractCandidates("src/auth.ts", ownerSource)
    .filter(({ kind }) => kind === "function")
    .find(({ source }) => source.includes("login"));
  expect(candidate).toBeDefined();
  if (!candidate) throw new Error("Fixture has no login candidate.");
  return { candidate, projectFiles };
}

describe("unsafe redirect target evidence", () => {
  it("reports a request-derived redirect with no allow-check", () => {
    const { candidate, projectFiles } = project(
      "export function login(req: any, res: any) {\n"
      + "  res.redirect(req.query.next);\n"
      + "}\n",
    );

    expect(buildUnsafeRedirectTargetEvidence(candidate, projectFiles)).toMatchObject({
      function: { name: "login" },
      redirects: [{
        kind: "redirect-call",
        target: "req.query.next",
        callerControlled: true,
        hasAllowCheck: false,
      }],
    });
  });

  it("reports location assignment over caller input", () => {
    const { candidate, projectFiles } = project(
      "export function login(req: any) {\n"
      + "  location.href = req.query.next;\n"
      + "}\n",
    );

    expect(buildUnsafeRedirectTargetEvidence(candidate, projectFiles)).toMatchObject({
      redirects: [{ kind: "location-assign", callerControlled: true }],
    });
  });

  it("notes URL construction as an allow-check signal", () => {
    const { candidate, projectFiles } = project(
      "export function login(req: any, res: any) {\n"
      + "  const target = new URL(req.query.next, \"https://example.com\");\n"
      + "  res.redirect(target);\n"
      + "}\n",
    );

    const evidence = buildUnsafeRedirectTargetEvidence(candidate, projectFiles);

    expect(evidence?.redirects).toHaveLength(1);
    expect(evidence?.redirects[0]).toMatchObject({ hasAllowCheck: true });
  });

  it("abstains for constant redirect targets", () => {
    const { candidate, projectFiles } = project(
      "export function login(res: any) {\n"
      + "  res.redirect(\"/home\");\n"
      + "}\n",
    );

    expect(buildUnsafeRedirectTargetEvidence(candidate, projectFiles)).toBeUndefined();
  });

  it("abstains when there is no navigation shape", () => {
    const { candidate, projectFiles } = project(
      "export function login(name: string) {\n"
      + "  return `hello ${name}`;\n"
      + "}\n",
    );

    expect(buildUnsafeRedirectTargetEvidence(candidate, projectFiles)).toBeUndefined();
  });
});

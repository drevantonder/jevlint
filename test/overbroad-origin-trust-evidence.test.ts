import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildOverbroadOriginTrustEvidence } from "../src/evidence/overbroad-origin-trust.js";
import type { ProjectFile } from "../src/types.js";

function project(ownerSource: string) {
  const projectFiles: ProjectFile[] = [{ filePath: "src/server.ts", source: ownerSource }];
  const candidate = extractCandidates("src/server.ts", ownerSource)
    .filter(({ kind }) => kind === "function")
    .find(({ source }) => source.includes("handle"));
  expect(candidate).toBeDefined();
  if (!candidate) throw new Error("Fixture has no handle candidate.");
  return { candidate, projectFiles };
}

describe("overbroad origin trust evidence", () => {
  it("reports a wildcard allow-origin header", () => {
    const { candidate, projectFiles } = project(
      "export function handle(req: any, res: any) {\n"
      + "  res.setHeader(\"Access-Control-Allow-Origin\", \"*\");\n"
      + "}\n",
    );

    expect(buildOverbroadOriginTrustEvidence(candidate, projectFiles)).toMatchObject({
      function: { name: "handle" },
      grants: [{ kind: "allow-origin-header" }],
      hasOriginCheck: false,
    });
  });

  it("reports postMessage to any origin with credentials alongside", () => {
    const { candidate, projectFiles } = project(
      "export function handle(token: string) {\n"
      + "  window.postMessage(token, \"*\");\n"
      + "}\n",
    );

    const evidence = buildOverbroadOriginTrustEvidence(candidate, projectFiles);

    expect(evidence).toMatchObject({ grants: [{ kind: "post-message" }] });
    expect(evidence?.grants[0]?.expression).toContain("postMessage");
  });

  it("reports a reflective CORS config", () => {
    const { candidate, projectFiles } = project(
      "import cors from \"cors\";\n"
      + "export function handle() {\n"
      + "  return cors({ origin: \"*\" });\n"
      + "}\n",
    );

    expect(buildOverbroadOriginTrustEvidence(candidate, projectFiles)).toMatchObject({
      grants: [{ kind: "cors-config" }],
    });
  });

  it("notes an origin comparison before the grant", () => {
    const { candidate, projectFiles } = project(
      "export function handle(req: any, res: any) {\n"
      + "  if (req.headers.origin === \"https://example.com\") {\n"
      + "    res.setHeader(\"Access-Control-Allow-Origin\", \"*\");\n"
      + "  }\n"
      + "}\n",
    );

    expect(buildOverbroadOriginTrustEvidence(candidate, projectFiles)).toMatchObject({
      grants: [{ kind: "allow-origin-header" }],
      hasOriginCheck: true,
    });
  });

  it("abstains when there is no wildcard grant", () => {
    const { candidate, projectFiles } = project(
      "export function handle(req: any, res: any) {\n"
      + "  res.setHeader(\"Content-Type\", \"application/json\");\n"
      + "}\n",
    );

    expect(buildOverbroadOriginTrustEvidence(candidate, projectFiles)).toBeUndefined();
  });
});

import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildDrilledPropEvidence } from "../src/evidence/drilled-prop.js";
import type { ProjectFile } from "../src/types.js";

const CHANNELS: ProjectFile = {
  filePath: "src/session.ts",
  source: "import { createContext, useContext } from \"react\";\n"
    + "export const SessionContext = createContext({ user: \"anon\" });\n"
    + "export function useSession(): { user: string } {\n"
    + "  return useContext(SessionContext);\n"
    + "}\n",
};

function project(ownerSource: string) {
  const projectFiles: ProjectFile[] = [
    { filePath: "src/Layout.tsx", source: ownerSource },
    CHANNELS,
  ];
  const candidate = extractCandidates("src/Layout.tsx", ownerSource)
    .filter(({ kind }) => kind === "function")
    .find(({ source }) => source.includes("Layout"));
  expect(candidate).toBeDefined();
  if (!candidate) throw new Error("Fixture has no Layout candidate.");
  return { candidate, projectFiles };
}

describe("drilled prop evidence", () => {
  it("reports a prop forwarded unread with a state channel available", () => {
    const { candidate, projectFiles } = project(
      "export function Layout({ user }: { user: string }): unknown {\n"
      + "  return <Sidebar user={user} />;\n"
      + "}\n",
    );

    const evidence = buildDrilledPropEvidence(candidate, projectFiles);

    expect(evidence).toMatchObject({
      forwardedProps: [expect.objectContaining({ name: "user", readElsewhere: false })],
      stateChannels: expect.arrayContaining([expect.objectContaining({ hook: "useSession" })]),
    });
  });

  it("marks props that intermediates read themselves", () => {
    const { candidate, projectFiles } = project(
      "export function Layout({ user }: { user: string }): unknown {\n"
      + "  const label = user.toUpperCase();\n"
      + "  return null;\n"
      + "}\n",
    );

    expect(buildDrilledPropEvidence(candidate, projectFiles)).toBeUndefined();
  });

  it("abstains when nothing is forwarded as JSX", () => {
    const source = "export function Layout({ user }: { user: string }): string {\n"
      + "  return user;\n"
      + "}\n";
    const projectFiles: ProjectFile[] = [{ filePath: "src/Layout.tsx", source }];
    const candidate = extractCandidates("src/Layout.tsx", source)
      .filter(({ kind }) => kind === "function")
      .find(({ source: text }) => text.includes("Layout"));
    expect(candidate).toBeDefined();
    if (!candidate) throw new Error("Fixture has no candidate.");

    expect(buildDrilledPropEvidence(candidate, projectFiles)).toBeUndefined();
  });
});

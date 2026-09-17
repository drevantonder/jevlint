import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildRuleEvidence } from "../src/evidence/index.js";
import { buildClientOnlyAuthorizationEvidence } from "../src/evidence/client-only-authorization.js";
import type { Candidate, ProjectFile } from "../src/types.js";

const guarded = `export function billingRoute(user: { isAdmin: boolean }) {
  if (!user.isAdmin) {
    redirect("/login");
  }
  return loadBilling();
}
`;

const bareHandler = `export function loadBilling() {
  return db.billing.all();
}
`;

const guardedHandler = `import { getServerSession } from "./auth";
export function billingRoute(user: { isAdmin: boolean }) {
  if (!user.isAdmin) {
    redirect("/login");
  }
  return loadBilling();
}
export async function loadBilling(req: unknown) {
  const session = await getServerSession(req);
  if (session.role !== "admin") throw new Error("forbidden");
  return db.billing.all();
}
`;

const plain = `export function total(items: { price: number }[]) {
  return items.reduce((sum, item) => sum + item.price, 0);
}
`;

function candidateFor(source: string, filePath: string, snippet: string): Candidate {
  const found = extractCandidates(filePath, source)
    .find(({ kind, source: text }) => kind === "function" && text.includes(snippet));
  expect(found).toBeDefined();
  expect(found?.kind).toBe("function");
  if (!found) throw new Error("candidate missing");
  return found;
}

describe("client-only authorization evidence", () => {
  it("extracts the client guard with no server check beside it", () => {
    const projectFiles: ProjectFile[] = [
      { filePath: "src/routes.ts", source: guarded },
      { filePath: "src/billing.ts", source: bareHandler },
    ];
    const candidate = candidateFor(guarded, "src/routes.ts", "function billingRoute");

    const evidence = buildClientOnlyAuthorizationEvidence(candidate, projectFiles);

    expect(evidence).toMatchObject({
      function: { name: "billingRoute", exported: true },
      clientGuards: [{ kind: "predicate", signal: expect.stringContaining("isAdmin") }],
      serverSignals: [],
    });
  });

  it("surfaces server-side role reads so the judgment can score low", () => {
    const projectFiles: ProjectFile[] = [{ filePath: "src/routes.ts", source: guardedHandler }];
    const candidate = candidateFor(guardedHandler, "src/routes.ts", "function billingRoute");

    const evidence = buildClientOnlyAuthorizationEvidence(candidate, projectFiles);

    expect(evidence?.clientGuards.length).toBeGreaterThan(0);
    expect(evidence?.serverSignals.length).toBeGreaterThan(0);
  });

  it("abstains when the function has no authorization signal", () => {
    const candidate = candidateFor(plain, "src/cart.ts", "function total");

    expect(buildClientOnlyAuthorizationEvidence(candidate, [{ filePath: "src/cart.ts", source: plain }]))
      .toBeUndefined();
  });

  it("abstains for non-function candidates", () => {
    const comment = { ...candidateFor(guarded, "src/routes.ts", "function billingRoute"), kind: "comment" as const };
    expect(buildClientOnlyAuthorizationEvidence(comment, [{ filePath: "src/routes.ts", source: guarded }]))
      .toBeUndefined();
  });

  it("dispatches through the rule registry", () => {
    const projectFiles: ProjectFile[] = [{ filePath: "src/routes.ts", source: guarded }];
    const candidate = candidateFor(guarded, "src/routes.ts", "function billingRoute");

    const result = buildRuleEvidence("jev/no-client-only-authorization", candidate, projectFiles);

    expect(result.handled).toBe(true);
    expect(result.handled && result.evidence).toBeDefined();
  });
});

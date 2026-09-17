import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildDisabledTlsVerificationEvidence } from "../src/evidence/disabled-tls-verification.js";
import type { ProjectFile } from "../src/types.js";

const smelly = `import https from "node:https";
export function chargeCard(payload: { amount: number }) {
  const agent = new https.Agent({ rejectUnauthorized: false });
  return https.request("https://pay.example", { agent });
}
`;

const globalBypass = `export function bootService() {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  return true;
}
`;

const identityStub = `import tls from "node:tls";
export function connectLedger(host: string) {
  return tls.connect({ host, checkServerIdentity: () => undefined });
}
`;

const cleaned = `import https from "node:https";
export function chargeCard(payload: { amount: number }) {
  const agent = new https.Agent({ rejectUnauthorized: true });
  return https.request("https://pay.example", { agent });
}
`;

function project(source: string, filePath = "src/payments.ts", extra: ProjectFile[] = []) {
  return { files: [{ filePath, source }, ...extra], filePath };
}

function candidateFor(source: string, filePath: string, marker: string) {
  const candidate = extractCandidates(filePath, source)
    .find(({ kind, source: text }) => kind === "function" && text.includes(marker));
  expect(candidate).toBeDefined();
  return candidate!;
}

describe("disabled TLS verification evidence", () => {
  it("captures rejectUnauthorized false scoped to an agent", () => {
    const { files, filePath } = project(smelly);
    const evidence = buildDisabledTlsVerificationEvidence(candidateFor(smelly, filePath, "chargeCard"), files);

    expect(evidence).toMatchObject({
      function: { name: "chargeCard", exported: true, fileRole: "service" },
      bypasses: [{ kind: "rejectUnauthorized" }],
      scope: "agent",
    });
    expect(evidence?.clientImports).toContain("node:https");
  });

  it("marks the TLS environment override as process-global", () => {
    const { files, filePath } = project(globalBypass);
    const evidence = buildDisabledTlsVerificationEvidence(candidateFor(globalBypass, filePath, "bootService"), files);

    expect(evidence).toMatchObject({
      bypasses: [{ kind: "tls-env" }],
      scope: "global",
    });
  });

  it("captures a checkServerIdentity stub", () => {
    const { files, filePath } = project(identityStub);
    const evidence = buildDisabledTlsVerificationEvidence(candidateFor(identityStub, filePath, "connectLedger"), files);

    expect(evidence?.bypasses).toMatchObject([{ kind: "checkServerIdentity" }]);
    expect(evidence?.scope).toBe("call");
  });

  it("flags test-only setup through the file role", () => {
    const { files, filePath } = project(smelly, "test/payments.test.ts");
    const evidence = buildDisabledTlsVerificationEvidence(candidateFor(smelly, filePath, "chargeCard"), files);

    expect(evidence?.function.fileRole).toBe("test");
    expect(evidence?.bypasses).toMatchObject([{ kind: "rejectUnauthorized" }]);
  });

  it("abstains when verification stays enabled", () => {
    const { files, filePath } = project(cleaned);
    expect(buildDisabledTlsVerificationEvidence(candidateFor(cleaned, filePath, "chargeCard"), files))
      .toBeUndefined();
  });

  it("abstains when no TLS option appears", () => {
    const source = `export function chargeCard(amount: number) {
  return amount * 2;
}
`;
    const { files, filePath } = project(source);
    expect(buildDisabledTlsVerificationEvidence(candidateFor(source, filePath, "chargeCard"), files))
      .toBeUndefined();
  });

  it("includes callers for shipped-path sensitivity", () => {
    const { files, filePath } = project(smelly, "src/payments.ts", [{
      filePath: "src/routes.ts",
      source: `import { chargeCard } from "./payments";\nexport function pay(p: never) { return chargeCard(p); }`,
    }]);
    const evidence = buildDisabledTlsVerificationEvidence(candidateFor(smelly, filePath, "chargeCard"), files);
    expect(evidence?.callers).toMatchObject([{ filePath: "src/routes.ts" }]);
  });
});

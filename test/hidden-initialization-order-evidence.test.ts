import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildHiddenInitializationOrderEvidence } from "../src/evidence/hidden-initialization-order.js";
import type { ProjectFile } from "../src/types.js";

const repositories = new URL("./fixtures/repositories/", import.meta.url);

async function project(name: string, paths: string[]): Promise<ProjectFile[]> {
  return Promise.all(paths.map(async (filePath) => ({
    filePath,
    source: await readFile(new URL(`${name}/${filePath}`, repositories), "utf8"),
  })));
}

function namedFunction(projectFiles: ProjectFile[], name: string) {
  const owner = projectFiles[0];
  expect(owner).toBeDefined();
  if (!owner) throw new Error("Missing fixture owner.");
  const candidate = extractCandidates(owner.filePath, owner.source)
    .find(({ source }) => source.includes(`function ${name}`));
  expect(candidate).toBeDefined();
  if (!candidate) throw new Error(`Missing ${name} candidate.`);
  return candidate;
}

describe("hidden initialization order evidence", () => {
  it("connects a module-state reader to its initializer and separate callers", async () => {
    const files = await project("hidden-initialization-order-positive", [
      "src/payments.ts",
      "src/bootstrap.ts",
      "src/checkout.ts",
    ]);

    const evidence = buildHiddenInitializationOrderEvidence(
      namedFunction(files, "chargeOrder"),
      files,
    );

    expect(evidence).toMatchObject({
      function: { name: "chargeOrder", exported: true },
      dependencies: [{
        binding: {
          name: "paymentClient",
          declaration: "let paymentClient: PaymentClient;",
        },
        initializers: [{
          name: "configurePayments",
          source: expect.stringContaining("paymentClient = client"),
          callers: [expect.objectContaining({ filePath: "src/bootstrap.ts" })],
        }],
      }],
      callers: [expect.objectContaining({ filePath: "src/checkout.ts" })],
      callerModules: [
        expect.objectContaining({ filePath: "src/bootstrap.ts" }),
        expect.objectContaining({ filePath: "src/checkout.ts" }),
      ],
    });
  });

  it("abstains when the caller supplies the dependency", async () => {
    const files = await project("hidden-initialization-order-negative", [
      "src/charge-order-explicit.ts",
      "src/checkout.ts",
    ]);

    expect(buildHiddenInitializationOrderEvidence(
      namedFunction(files, "chargeOrderExplicit"),
      files,
    )).toBeUndefined();
  });

  it("preserves explicit lifecycle naming and call order", async () => {
    const files = await project("hidden-initialization-order-exception", [
      "src/server-lifecycle.ts",
      "src/runtime.ts",
    ]);

    expect(buildHiddenInitializationOrderEvidence(
      namedFunction(files, "stopServer"),
      files,
    )).toMatchObject({
      function: { name: "stopServer" },
      dependencies: [{
        binding: { name: "server" },
        initializers: [{ name: "startServer" }],
      }],
      callerModules: [{
        filePath: "src/runtime.ts",
        source: expect.stringMatching(/startServer[\s\S]+stopServer/),
      }],
    });
  });

  it("shows a scoped context callback as an ambiguous ordering contract", async () => {
    const files = await project("hidden-initialization-order-ambiguous", [
      "src/request-context.ts",
      "src/handler.ts",
    ]);

    expect(buildHiddenInitializationOrderEvidence(
      namedFunction(files, "currentRequestContext"),
      files,
    )).toMatchObject({
      function: { name: "currentRequestContext" },
      dependencies: [{
        binding: { name: "requestContext" },
        initializers: [{ name: "runWithRequestContext" }],
      }],
      callerModules: [{
        source: expect.stringMatching(/runWithRequestContext[\s\S]+currentRequestContext/),
      }],
    });
  });

  it("does not mistake a same-named parameter for module state", () => {
    const source = `
      let paymentClient: PaymentClient;
      export function configurePayments(client: PaymentClient) { paymentClient = client; }
      export function chargeWithClient(paymentClient: PaymentClient, order: Order) {
        return paymentClient.charge(order.id, order.total);
      }
    `;
    const files = [{ filePath: "src/payments.ts", source }];

    expect(buildHiddenInitializationOrderEvidence(
      namedFunction(files, "chargeWithClient"),
      files,
    )).toBeUndefined();
  });

  it("does not mistake a same-named local for module state", () => {
    const source = `
      let paymentClient: PaymentClient;
      export function configurePayments(client: PaymentClient) { paymentClient = client; }
      export function previewCharge(order: Order) {
        const paymentClient = createPreviewPaymentClient();
        return paymentClient.charge(order.id, order.total);
      }
    `;
    const files = [{ filePath: "src/payments.ts", source }];

    expect(buildHiddenInitializationOrderEvidence(
      namedFunction(files, "previewCharge"),
      files,
    )).toBeUndefined();
  });

  it("does not treat a pure assignment as a module-state read", () => {
    const source = `
      let paymentClient: PaymentClient;
      export function initializePayments(client: PaymentClient) { paymentClient = client; }
      export function replacePaymentClient(client: PaymentClient) { paymentClient = client; }
    `;
    const files = [{ filePath: "src/payments.ts", source }];

    expect(buildHiddenInitializationOrderEvidence(
      namedFunction(files, "replacePaymentClient"),
      files,
    )).toBeUndefined();
  });

  it("preserves module-state reads in guards and returned expressions", () => {
    const source = `
      let paymentClient: PaymentClient | undefined;
      export function configurePayments(client: PaymentClient) { paymentClient = client; }
      export function requirePaymentClient() {
        if (!paymentClient) throw new Error("Payments are not configured");
        return paymentClient;
      }
    `;
    const files = [{ filePath: "src/payments.ts", source }];

    expect(buildHiddenInitializationOrderEvidence(
      namedFunction(files, "requirePaymentClient"),
      files,
    )).toMatchObject({
      dependencies: [{
        binding: { name: "paymentClient" },
        initializers: [{ name: "configurePayments" }],
      }],
    });
  });
});

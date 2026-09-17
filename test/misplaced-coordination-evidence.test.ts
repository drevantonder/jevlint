import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildRuleEvidence } from "../src/evidence/index.js";
import { buildMisplacedCoordinationEvidence } from "../src/evidence/misplaced-coordination.js";
import type { Candidate, ProjectFile } from "../src/types.js";

const orderSource = `import { chargeCard } from "./payment-service.js";
import { saveOrder } from "./order-repository.js";
import { sendEmail } from "./mailer.js";

export class Order {
  constructor(private id: string, private total: number) {}

  async place(): Promise<void> {
    await chargeCard(this.id, this.total);
    await saveOrder(this.id);
    await sendEmail("receipt");
  }

  describe(): string {
    return \`\${this.id}:\${this.total}\`;
  }
}
`;

const paymentService = `export async function chargeCard(id: string, total: number): Promise<void> {
  void id;
  void total;
}
`;

const orderRepository = `export async function saveOrder(id: string): Promise<void> {
  void id;
}
`;

const mailer = `export async function sendEmail(kind: string): Promise<void> {
  void kind;
}
`;

const checkoutSource = `import { Order } from "./order.js";

export async function checkout(order: Order): Promise<void> {
  await order.place();
}
`;

const ownRepositorySource = `import { saveOrder } from "./order-repository.js";

export class Order {
  constructor(private id: string) {}

  async save(): Promise<void> {
    await saveOrder(this.id);
  }
}
`;

const serviceHomeSource = `import { chargeCard } from "./payment-service.js";
import { saveOrder } from "./order-repository.js";
import { sendEmail } from "./mailer.js";
import type { Order } from "./order.js";

export class OrderService {
  async placeOrder(order: Order): Promise<void> {
    await chargeCard(order.id, order.total);
    await saveOrder(order.id);
    await sendEmail("receipt");
  }
}
`;

const standaloneSource = `import { chargeCard } from "./payment-service.js";

export async function place(id: string, total: number): Promise<void> {
  await chargeCard(id, total);
}
`;

function projectFor(source: string, filePath: string, extra: ProjectFile[] = []): ProjectFile[] {
  return [
    { filePath, source },
    { filePath: "src/payment-service.ts", source: paymentService },
    { filePath: "src/order-repository.ts", source: orderRepository },
    { filePath: "src/mailer.ts", source: mailer },
    ...extra,
  ];
}

function candidateFor(source: string, filePath: string, snippet: string): Candidate {
  const found = extractCandidates(filePath, source)
    .find(({ kind, source: text }) => kind === "function" && text.includes(snippet));
  expect(found).toBeDefined();
  expect(found?.kind).toBe("function");
  if (!found) throw new Error("candidate missing");
  return found;
}

describe("misplaced coordination evidence", () => {
  it("extracts the enclosing type, own-field reads, and collaborator roles", () => {
    const projectFiles = projectFor(orderSource, "src/order.ts", [
      { filePath: "src/checkout.ts", source: checkoutSource },
    ]);
    const candidate = candidateFor(orderSource, "src/order.ts", "chargeCard(");

    const evidence = buildMisplacedCoordinationEvidence(candidate, projectFiles);

    expect(evidence).toMatchObject({
      method: { name: "place", className: "Order", isCoordinatorHome: false, isLifecycleHook: false },
      ownership: { ownFieldReads: expect.arrayContaining(["id", "total"]) },
    });
    expect(evidence?.collaborators.map(({ source }) => source).sort()).toEqual([
      "./mailer.js",
      "./order-repository.js",
      "./payment-service.js",
    ]);
    expect(evidence?.collaborators.map(({ role }) => role).sort()).toEqual([
      "notifier",
      "persistence",
      "service",
    ]);
    expect(evidence?.callers).toEqual([
      { filePath: "src/checkout.ts", call: expect.stringContaining(".place("), line: expect.any(Number) },
    ]);
  });

  it("flags delegation behind the type's own repository seam", () => {
    const projectFiles = projectFor(ownRepositorySource, "src/order.ts");
    const candidate = candidateFor(ownRepositorySource, "src/order.ts", "saveOrder(");

    const evidence = buildMisplacedCoordinationEvidence(candidate, projectFiles);

    expect(evidence?.collaborators).toEqual([
      expect.objectContaining({ source: "./order-repository.js", role: "persistence", isOwnRepository: true }),
    ]);
  });

  it("flags coordination inside a coordinator-home module", () => {
    const projectFiles = projectFor(serviceHomeSource, "src/order-service.ts");
    const candidate = candidateFor(serviceHomeSource, "src/order-service.ts", "chargeCard(");

    const evidence = buildMisplacedCoordinationEvidence(candidate, projectFiles);

    expect(evidence?.method).toMatchObject({
      name: "placeOrder",
      className: "OrderService",
      isCoordinatorHome: true,
      coordinatorSignal: "service",
    });
  });

  it("abstains when the method calls no imported collaborator", () => {
    const projectFiles = projectFor(orderSource, "src/order.ts");
    const candidate = candidateFor(orderSource, "src/order.ts", "this.id}:");

    expect(buildMisplacedCoordinationEvidence(candidate, projectFiles)).toBeUndefined();
  });

  it("abstains for functions outside any class", () => {
    const projectFiles = projectFor(standaloneSource, "src/place.ts");
    const candidate = candidateFor(standaloneSource, "src/place.ts", "chargeCard(");

    expect(buildMisplacedCoordinationEvidence(candidate, projectFiles)).toBeUndefined();
  });

  it("abstains when collaborator ownership cannot be established", () => {
    const source = `import { saveOrder } from "./missing.js";

export class Order {
  constructor(private id: string) {}

  async save(): Promise<void> {
    await saveOrder(this.id);
  }
}
`;
    const projectFiles: ProjectFile[] = [{ filePath: "src/order.ts", source }];
    const candidate = candidateFor(source, "src/order.ts", "saveOrder(");

    expect(buildMisplacedCoordinationEvidence(candidate, projectFiles)).toBeUndefined();
  });

  it("abstains for non-function candidates", () => {
    const comment = {
      ...candidateFor(orderSource, "src/order.ts", "chargeCard("),
      kind: "comment" as const,
    };
    const projectFiles = projectFor(orderSource, "src/order.ts");

    expect(buildMisplacedCoordinationEvidence(comment, projectFiles)).toBeUndefined();
  });

  it("dispatches through the rule registry", () => {
    const projectFiles = projectFor(orderSource, "src/order.ts");
    const candidate = candidateFor(orderSource, "src/order.ts", "chargeCard(");

    const result = buildRuleEvidence("jev/no-misplaced-coordination", candidate, projectFiles);

    expect(result.handled).toBe(true);
    expect(result.handled && result.evidence).toBeDefined();
  });
});

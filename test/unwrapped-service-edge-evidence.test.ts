import { describe, expect, it } from "vitest";
import { buildUnwrappedServiceEdgeEvidence } from "../src/evidence/unwrapped-service-edge.js";
import { buildRuleEvidence } from "../src/evidence/index.js";
import type { Candidate, ProjectFile, SourceFile } from "../src/types.js";

function projectFile(filePath: string, source = "export const value = 1;\n"): ProjectFile {
  return { filePath, source };
}

function moduleCandidate(filePath: string): Candidate {
  return {
    id: "module_0",
    kind: "module",
    filePath,
    source: "",
    start: 0,
    end: 0,
    startLine: 1,
    startColumn: 1,
    endLine: 1,
    endColumn: 1,
  };
}

const client = `import axios from "axios";
export async function getJson(url: string) {
  const response = await axios.get(url);
  return response.data;
}
`;

const checkout = `import { getJson } from "../http/client.js";
export async function checkout() {
  return getJson("https://api.shop.example.com/cart");
}
`;

const cart = `import { getJson } from "../http/client.js";
export async function cart() {
  return getJson("https://api.shop.example.com/cart");
}
`;

const rates = `import { getJson } from "../http/client.js";
export async function rates() {
  return getJson("https://api.shop.example.com/rates");
}
`;

const trackBefore = `export async function track(id: string) {
  return id;
}
`;

const trackAfter = `import { statusOf } from "./status.js";
export async function track(id: string) {
  const response = await fetch(\`https://api.carrier.example.com/v1/track/\${id}\`);
  return statusOf(await response.json());
}
`;

const status = `export function statusOf(payload: unknown) {
  return payload;
}
`;

function repo(trackSource: string, trackOld: string | null, trackLines: { start: number; end: number }[]) {
  const files = [
    projectFile("http/client.ts", client),
    projectFile("billing/checkout.ts", checkout),
    projectFile("orders/cart.ts", cart),
    projectFile("shipping/rates.ts", rates),
    projectFile("shipping/status.ts", status),
    projectFile("shipping/track.ts", trackSource),
    ...Array.from({ length: 5 }, (_, index) => projectFile(`extra/widget-${index}.ts`)),
  ];
  const changes: SourceFile[] = [{
    filePath: "shipping/track.ts",
    source: trackSource,
    oldSource: trackOld,
    changedLines: trackLines,
  }];
  return { files, changes };
}

describe("unwrapped service edge evidence", () => {
  it("captures a novel host fetched ad hoc beside an established wrapper", () => {
    const { files, changes } = repo(trackAfter, trackBefore, [{ start: 3, end: 3 }]);

    const evidence = buildUnwrappedServiceEdgeEvidence(
      moduleCandidate("shipping/track.ts"),
      files,
      changes,
    );

    expect(evidence?.hosts).toHaveLength(1);
    expect(evidence?.hosts[0]?.host).toBe("api.carrier.example.com");
    expect(evidence?.wrappers).toHaveLength(1);
    expect(evidence?.wrappers[0]).toMatchObject({ path: "http/client.ts", importerCount: 3 });
    expect(evidence?.usesWrapper).toBe(false);
    expect(evidence?.callMarkers.outboundCall).toBe(true);
    expect(evidence?.callMarkers.reliabilityMarkers).toEqual([]);
  });

  it("is reachable through the shared evidence dispatch", () => {
    const { files, changes } = repo(trackAfter, trackBefore, [{ start: 3, end: 3 }]);

    const result = buildRuleEvidence(
      "jev/no-unwrapped-service-edge",
      moduleCandidate("shipping/track.ts"),
      files,
      changes,
    );

    expect(result.handled).toBe(true);
    if (result.handled) expect(result.evidence).toBeDefined();
  });

  it("abstains for non-module candidates", () => {
    const { files, changes } = repo(trackAfter, trackBefore, [{ start: 3, end: 3 }]);

    expect(
      buildUnwrappedServiceEdgeEvidence(
        { ...moduleCandidate("shipping/track.ts"), id: "change_0", kind: "change" },
        files,
        changes,
      ),
    ).toBeUndefined();
  });

  it("abstains when the host is already used elsewhere in the repo", () => {
    const legacy = `export const carrierEndpoint = "https://api.carrier.example.com/v1/track";
export function legacy() {
  return carrierEndpoint;
}
`;
    const { files, changes } = repo(trackAfter, trackBefore, [{ start: 3, end: 3 }]);
    const withLegacy = [...files, projectFile("billing/legacy.ts", legacy)];

    expect(
      buildUnwrappedServiceEdgeEvidence(moduleCandidate("shipping/track.ts"), withLegacy, changes),
    ).toBeUndefined();
  });

  it("abstains when the added lines hold a URL but no outbound call", () => {
    const endpointAfter = `import { statusOf } from "./status.js";
export const carrierEndpoint = "https://api.carrier.example.com/v1/track";
export async function track(id: string) {
  return statusOf(id);
}
`;
    const { files, changes } = repo(endpointAfter, trackBefore, [{ start: 2, end: 2 }]);

    expect(
      buildUnwrappedServiceEdgeEvidence(moduleCandidate("shipping/track.ts"), files, changes),
    ).toBeUndefined();
  });

  it("abstains when the host was already present before the change", () => {
    const { files, changes } = repo(trackAfter, trackAfter, [{ start: 3, end: 3 }]);

    expect(
      buildUnwrappedServiceEdgeEvidence(moduleCandidate("shipping/track.ts"), files, changes),
    ).toBeUndefined();
  });
});

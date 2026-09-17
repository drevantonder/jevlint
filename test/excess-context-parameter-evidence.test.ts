import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildExcessContextParameterEvidence } from "../src/evidence/excess-context-parameter.js";
import type { ProjectFile } from "../src/types.js";

const smelly = `import { loadAppConfig, type AppConfig } from "./config";

export function renderTimeout(appConfig: AppConfig) {
  return formatMs(appConfig.timeout);
}

export function renderRetries(appConfig: AppConfig) {
  return appConfig.retries + appConfig.timeout;
}
`;

const forwarded = `import { saveRecord } from "./store";

export function persist(record: Record<string, string>) {
  return saveRecord(record);
}
`;

const fullyUsed = `export type Point = { x: number; y: number };

export function distance(point: Point) {
  return Math.sqrt(point.x * point.x + point.y * point.y);
}
`;

function candidateFor(filePath: string, source: string, marker: string) {
  const candidate = extractCandidates(filePath, source)
    .find(({ source: text }) => text.includes(marker));
  expect(candidate).toBeDefined();
  return candidate!;
}

describe("excess context parameter evidence", () => {
  it("shows one member read against a wide annotated parameter", () => {
    const config = `export type AppConfig = {
      timeout: number;
      retries: number;
      endpoint: string;
      apiKey: string;
      region: string;
      logLevel: string;
      cacheTtl: number;
      maxConnections: number;
      enableTracing: boolean;
      serviceName: string;
      namespace: string;
      owner: string;
    };
    export function loadAppConfig(): AppConfig { throw new Error("unimplemented"); }
    `;
    const files: ProjectFile[] = [
      { filePath: "src/render.ts", source: smelly },
      { filePath: "src/config.ts", source: config },
      {
        filePath: "src/app.ts",
        source: `import { loadAppConfig } from "./config";\nimport { renderTimeout } from "./render";\nrenderTimeout(loadAppConfig());`,
      },
    ];
    const evidence = buildExcessContextParameterEvidence(
      candidateFor("src/render.ts", smelly, "appConfig.timeout"),
      files,
    );

    expect(evidence).toMatchObject({
      function: { name: "renderTimeout", exported: true },
      parameter: {
        name: "appConfig",
        annotation: "AppConfig",
        declaredProperties: expect.arrayContaining(["timeout", "retries", "endpoint"]),
      },
      usage: {
        distinctMembers: 1,
        forwardedWhole: false,
      },
      repository: {
        callers: [{ filePath: "src/app.ts", call: "renderTimeout(loadAppConfig())" }],
      },
    });
    expect(evidence?.parameter.declaredProperties).toHaveLength(12);
  });

  it("flags a sibling family sharing the same wide type", () => {
    const files: ProjectFile[] = [{ filePath: "src/render.ts", source: smelly }];
    const evidence = buildExcessContextParameterEvidence(
      candidateFor("src/render.ts", smelly, "appConfig.timeout"),
      files,
    );
    expect(evidence?.repository.sameTypeSiblings).toContain("renderRetries");
  });

  it("abstains when the parameter is forwarded whole", () => {
    const files: ProjectFile[] = [
      { filePath: "src/persist.ts", source: forwarded },
      { filePath: "src/store.ts", source: "export function saveRecord(r: object) {}" },
    ];
    expect(buildExcessContextParameterEvidence(
      candidateFor("src/persist.ts", forwarded, "saveRecord(record)"),
      files,
    )).toBeUndefined();
  });

  it("abstains when every used shape is primitive", () => {
    const source = `export function add(left: number, right: number) {
      return left + right;
    }`;
    const files: ProjectFile[] = [{ filePath: "src/math.ts", source }];
    expect(buildExcessContextParameterEvidence(
      candidateFor("src/math.ts", source, "left + right"),
      files,
    )).toBeUndefined();
  });

  it("still reports a fully used narrow parameter so Jev can score it low", () => {
    const files: ProjectFile[] = [{ filePath: "src/point.ts", source: fullyUsed }];
    const evidence = buildExcessContextParameterEvidence(
      candidateFor("src/point.ts", fullyUsed, "point.x"),
      files,
    );
    expect(evidence).toMatchObject({
      parameter: { name: "point", declaredProperties: ["x", "y"] },
      usage: { distinctMembers: 2, forwardedWhole: false },
    });
  });

  it("handles destructured parameters against their declared props", () => {
    const source = `export function renderTimeout({ timeout, retries, endpoint }: AppConfig) {
      return formatMs(timeout);
    }`;
    const files: ProjectFile[] = [{ filePath: "src/render.ts", source }];
    const evidence = buildExcessContextParameterEvidence(
      candidateFor("src/render.ts", source, "formatMs(timeout)"),
      files,
    );
    expect(evidence).toMatchObject({
      parameter: { destructured: true, declaredProperties: ["timeout", "retries", "endpoint"] },
      usage: { distinctMembers: 1 },
    });
  });
});

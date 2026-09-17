import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildTypeCodeDispatchEvidence } from "../src/evidence/type-code-dispatch.js";
import type { ProjectFile } from "../src/types.js";

const geometrySource = `export type Shape =
  | { kind: "circle"; radius: number }
  | { kind: "square"; side: number }
  | { kind: "triangle"; base: number; height: number };

export function area(shape: Shape): number {
  switch (shape.kind) {
    case "circle":
      return Math.PI * shape.radius * shape.radius;
    case "square":
      return shape.side * shape.side;
    case "triangle":
      return (shape.base * shape.height) / 2;
  }
}
`;

const describeSource = `import type { Shape } from "./shape.js";

export function describeShape(shape: Shape): string {
  if (shape.kind === "circle") return "round";
  if (shape.kind === "square") return "boxy";
  return "pointy";
}
`;

const renderSource = `import { area } from "./shape.js";
import type { Shape } from "./shape.js";

export function render(shape: Shape): string {
  return "area: " + area(shape);
}
`;

function candidate(source: string, filePath: string) {
  return extractCandidates(filePath, source).find(({ kind }) => kind === "function");
}

describe("type code dispatch evidence", () => {
  it("extracts a switch on a domain type code with cross-file handlers", () => {
    const files: ProjectFile[] = [
      { filePath: "src/shape.ts", source: geometrySource },
      { filePath: "src/describe.ts", source: describeSource },
      { filePath: "src/render.ts", source: renderSource },
    ];
    const fn = candidate(geometrySource, "src/shape.ts");
    expect(fn).toBeDefined();
    if (!fn) return;

    const evidence = buildTypeCodeDispatchEvidence(fn, files);

    expect(evidence).toMatchObject({
      function: { name: "area", filePath: "src/shape.ts" },
      dispatch: {
        baseExpression: "shape.kind",
        arms: [
          expect.objectContaining({ kind: "switch-case", test: '"circle"' }),
          expect.objectContaining({ kind: "switch-case", test: '"square"' }),
          expect.objectContaining({ kind: "switch-case", test: '"triangle"' }),
        ],
      },
      otherHandlers: [expect.objectContaining({
        filePath: "src/describe.ts",
        functionName: "describeShape",
      })],
      callers: [expect.objectContaining({
        filePath: "src/render.ts",
        call: expect.stringContaining("area("),
      })],
    });
    expect(evidence?.declaredUnionType).toContain("circle");
  });

  it("abstains for a single transient branch", () => {
    const source = `export function label(mode: string): string {
      if (mode === "fast") return "F";
      return "S";
    }
    `;
    const fn = candidate(source, "src/label.ts");
    expect(fn).toBeDefined();
    if (!fn) return;

    expect(buildTypeCodeDispatchEvidence(fn, [{ filePath: "src/label.ts", source }])).toBeUndefined();
  });
});

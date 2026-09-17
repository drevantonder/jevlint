import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildMirroredDerivedStateEvidence } from "../src/evidence/mirrored-derived-state.js";

const listSource = `import { useEffect, useState } from "react";

export function ItemList({ items }: { items: string[] }): string[] {
  const [local, setLocal] = useState(items);
  useEffect(() => {
    setLocal(items);
  }, [items]);
  const remove = (id: string): void => {
    setLocal(local.filter((item) => item !== id));
  };
  return local;
}
`;

const plainSource = `export function total(items: number[]): number {
  return items.reduce((sum, item) => sum + item, 0);
}
`;

function candidate(source: string, filePath: string) {
  return extractCandidates(filePath, source).find(({ kind }) => kind === "function");
}

describe("mirrored derived state evidence", () => {
  it("extracts an effect syncing props into local state", () => {
    const fn = candidate(listSource, "src/list.ts");
    expect(fn).toBeDefined();
    if (!fn) return;

    const evidence = buildMirroredDerivedStateEvidence(fn, [{ filePath: "src/list.ts", source: listSource }]);

    expect(evidence).toMatchObject({
      function: { name: "ItemList", filePath: "src/list.ts" },
      sync: { kind: "effect-sync", target: "local", source: "items" },
      sourceOrigin: "parameter",
      sourceAlsoInScope: true,
    });
    expect(evidence?.independentWrites).toBeGreaterThanOrEqual(1);
  });

  it("abstains when no sync shape exists", () => {
    const fn = candidate(plainSource, "src/total.ts");
    expect(fn).toBeDefined();
    if (!fn) return;

    expect(buildMirroredDerivedStateEvidence(fn, [{ filePath: "src/total.ts", source: plainSource }])).toBeUndefined();
  });
});

import { afterEach, describe, expect, it } from "vitest";
import { buildModuleGraph } from "../src/evidence/module.js";
import {
  clearParseCache,
  hashSource,
  parseCached,
  parseCacheSize,
  setParseCacheLimit,
} from "../src/evidence/parse-cache.js";

const FIRST = "function alpha() { return 1; }\n";
const SECOND = "function alpha() { return 2; }\n";

afterEach(() => {
  clearParseCache();
  setParseCacheLimit(1000);
});

describe("parseCached", () => {
  it("returns the same result object for identical inputs", () => {
    expect(parseCached("memo.ts", FIRST)).toBe(parseCached("memo.ts", FIRST));
  });

  it("re-parses when the source changes under the same path", () => {
    const before = parseCached("memo.ts", FIRST);
    const after = parseCached("memo.ts", SECOND);
    expect(after).not.toBe(before);
    expect(after.program.body.length).toBe(before.program.body.length);
  });

  it("keys on file path as well as content", () => {
    expect(parseCached("a.ts", FIRST)).not.toBe(parseCached("b.ts", FIRST));
  });

  it("evicts least-recently-used entries past the limit", () => {
    setParseCacheLimit(2);
    parseCached("a.ts", FIRST);
    parseCached("b.ts", FIRST);
    parseCached("c.ts", FIRST);
    expect(parseCacheSize()).toBe(2);
  });

  it("hashes deterministically and avalanches on small edits", () => {
    expect(hashSource(FIRST)).toBe(hashSource(FIRST));
    expect(hashSource(FIRST)).not.toBe(hashSource(SECOND));
  });
});

describe("buildModuleGraph memoization", () => {
  const files = (extra = "") => [
    { filePath: "a.ts", source: `import { b } from "./b.js";\n${extra}` },
    { filePath: "b.ts", source: "export const b = 1;\n" },
  ];

  it("returns the shared graph while inputs are identical", () => {
    const projectFiles = files();
    expect(buildModuleGraph(projectFiles)).toBe(buildModuleGraph(projectFiles));
  });

  it("rebuilds when a source string is replaced", () => {
    const projectFiles = files();
    const first = buildModuleGraph(projectFiles);
    const next = files("export const extra = 2;\n");
    expect(buildModuleGraph(next)).not.toBe(first);
  });
});

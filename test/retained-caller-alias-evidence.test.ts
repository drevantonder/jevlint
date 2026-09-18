import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { analyzeFileWithFailures } from "../src/analyze.js";
import { extractCandidates } from "../src/candidates.js";
import { defaultConfig } from "../src/defaults.js";
import { buildRetainedCallerAliasEvidence } from "../src/evidence/retained-caller-alias.js";
import type {
  Candidate,
  EvaluationRequest,
  Evaluator,
  JevLintConfig,
  ProjectFile,
} from "../src/types.js";

const repositories = new URL("./fixtures/repositories/", import.meta.url);

async function project(name: string, paths: string[]): Promise<ProjectFile[]> {
  return Promise.all(paths.map(async (filePath) => ({
    filePath,
    source: await readFile(new URL(`${name}/${filePath}`, repositories), "utf8"),
  })));
}

function functionCandidate(owner: ProjectFile, snippet: string): Candidate {
  const candidate = extractCandidates(owner.filePath, owner.source)
    .find(({ kind, source }) => kind === "function" && source.includes(snippet));
  expect(candidate).toBeDefined();
  if (!candidate) throw new Error(`Fixture has no function candidate containing: ${snippet}`);
  return candidate;
}

describe("retained caller alias evidence", () => {
  it("fires on a bare this-field store and a cache-store of caller arrays", async () => {
    const files = await project("retained-caller-alias-positive", ["src/cart.ts"]);
    const owner = files[0];
    expect(owner).toBeDefined();
    if (!owner) return;

    const fieldEvidence = buildRetainedCallerAliasEvidence(
      functionCandidate(owner, "this.items = items"),
      files,
    );
    expect(fieldEvidence).toMatchObject({
      function: {
        name: "setItems",
        exported: true,
        parameters: ["items: CartItem[]"],
      },
      retentions: [
        {
          parameter: "items",
          kind: "this-field",
          target: "this.items",
          operation: "this.items = items",
          via: "reference",
        },
      ],
      copies: [],
    });

    const cacheEvidence = buildRetainedCallerAliasEvidence(
      functionCandidate(owner, "this.index.set(sku, entries)"),
      files,
    );
    expect(cacheEvidence).toMatchObject({
      function: { name: "indexBySku" },
      retentions: [
        {
          parameter: "entries",
          kind: "cache-store",
          target: "this.index.set",
          operation: "this.index.set(sku, entries)",
          via: "reference",
        },
      ],
    });
  });

  it("abstains when every store copies before retaining", async () => {
    const files = await project("retained-caller-alias-copied", ["src/cart.ts"]);
    const owner = files[0];
    expect(owner).toBeDefined();
    if (!owner) return;

    for (const snippet of ["[...items]", "tags.slice()", "structuredClone(entry)", "Array.from(items)"]) {
      expect(
        buildRetainedCallerAliasEvidence(functionCandidate(owner, snippet), files),
        snippet,
      ).toBeUndefined();
    }
  });

  it("abstains when the reference stays in local state", async () => {
    const files = await project("retained-caller-alias-local", ["src/prepare.ts"]);
    const owner = files[0];
    expect(owner).toBeDefined();
    if (!owner) return;

    expect(
      buildRetainedCallerAliasEvidence(functionCandidate(owner, "const working = items"), files),
    ).toBeUndefined();
  });

  it("abstains when primitively annotated parameters are stored", async () => {
    const files = await project("retained-caller-alias-primitive", ["src/counter.ts"]);
    const owner = files[0];
    expect(owner).toBeDefined();
    if (!owner) return;

    expect(
      buildRetainedCallerAliasEvidence(functionCandidate(owner, "this.count = count"), files),
    ).toBeUndefined();
    expect(
      buildRetainedCallerAliasEvidence(functionCandidate(owner, "this.label = label"), files),
    ).toBeUndefined();
  });

  it("fires on an outer-scope store of a caller array", () => {
    const source = `let lastSeen: string[] = [];
export function remember(tags: string[]): void {
  lastSeen = tags;
}`;
    const candidate = functionCandidate(
      { filePath: "src/remember.ts", source },
      "lastSeen = tags",
    );

    expect(
      buildRetainedCallerAliasEvidence(candidate, [{ filePath: "src/remember.ts", source }]),
    ).toMatchObject({
      function: { name: "remember" },
      retentions: [
        {
          parameter: "tags",
          kind: "outer-scope",
          target: "lastSeen",
          operation: "lastSeen = tags",
          via: "reference",
        },
      ],
    });
  });

  it("fires through a member read with a fallback default", () => {
    const source = `export class View {
  private rows: Row[] = [];
  configure(options: ViewOptions): void {
    this.rows = options.rows ?? [];
  }
}`;
    const candidate = functionCandidate(
      { filePath: "src/view.ts", source },
      "options.rows ?? []",
    );

    expect(
      buildRetainedCallerAliasEvidence(candidate, [{ filePath: "src/view.ts", source }]),
    ).toMatchObject({
      retentions: [
        {
          parameter: "options",
          kind: "this-field",
          target: "this.rows",
          operation: "this.rows = options.rows ?? []",
          via: "member",
        },
      ],
    });
  });

  it("does not retain a rest parameter collected fresh for the call", () => {
    const source = `export class Batch {
  private names: string[] = [];
  add(...names: string[]): void {
    this.names = names;
  }
}`;
    const candidate = functionCandidate(
      { filePath: "src/batch.ts", source },
      "this.names = names",
    );

    expect(
      buildRetainedCallerAliasEvidence(candidate, [{ filePath: "src/batch.ts", source }]),
    ).toBeUndefined();
  });

  it("carries retentions through a fake evaluator with raw scores", async () => {
    const projectFiles = await project("retained-caller-alias-positive", ["src/cart.ts"]);
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const rule = defaultConfig.rules["jev/no-retained-caller-alias"];
    expect(rule).toBeDefined();
    if (!rule) return;
    const config: JevLintConfig = { rules: { "jev/no-retained-caller-alias": rule } };
    const evaluator: Evaluator = {
      async evaluate(request: EvaluationRequest): Promise<Record<string, number>> {
        return Object.fromEntries(Object.keys(request.questions).map((id) => [id, 0.83]));
      },
    };

    const result = await analyzeFileWithFailures({
      filePath: "src/cart.ts",
      source: owner.source,
      changedLines: [{ start: 1, end: owner.source.split("\n").length }],
      config,
      projectFiles,
    }, evaluator);

    expect(result.failures).toEqual([]);
    expect(result.judgments.map((judgment) => judgment.probability)).toEqual([0.83, 0.83]);
    expect(result.judgments.map((judgment) => judgment.ruleId)).toEqual([
      "jev/no-retained-caller-alias",
      "jev/no-retained-caller-alias",
    ]);
    const kinds = result.judgments.map((judgment) => {
      // SAFETY: rule evidence is a JSON object and this builder sets retentions on every firing.
      const evidence = judgment.evidence as {
        retentions?: { kind: string; parameter: string }[];
      } | null;
      return evidence?.retentions?.[0];
    });
    expect(kinds).toEqual([
      expect.objectContaining({ kind: "this-field", parameter: "items" }),
      expect.objectContaining({ kind: "cache-store", parameter: "entries" }),
    ]);
  });

  it("leaves no judgments for the copied fixture through a fake evaluator", async () => {
    const projectFiles = await project("retained-caller-alias-copied", ["src/cart.ts"]);
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const rule = defaultConfig.rules["jev/no-retained-caller-alias"];
    expect(rule).toBeDefined();
    if (!rule) return;
    const config: JevLintConfig = { rules: { "jev/no-retained-caller-alias": rule } };
    const evaluator: Evaluator = {
      async evaluate(request: EvaluationRequest): Promise<Record<string, number>> {
        return Object.fromEntries(Object.keys(request.questions).map((id) => [id, 0.83]));
      },
    };

    const result = await analyzeFileWithFailures({
      filePath: "src/cart.ts",
      source: owner.source,
      changedLines: [{ start: 1, end: owner.source.split("\n").length }],
      config,
      projectFiles,
    }, evaluator);

    expect(result.failures).toEqual([]);
    expect(result.judgments).toEqual([]);
  });
});

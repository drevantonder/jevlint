import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { analyzeFile, analyzeFileWithFailures } from "../src/analyze.js";
import { buildBareJsonParseEvidence } from "../src/evidence/bare-json-parse.js";
import type {
  EvaluationRequest,
  Evaluator,
  JevLintConfig,
  ProjectFile,
} from "../src/types.js";

function candidateFor(source: string, filePath: string, marker: string) {
  const candidate = extractCandidates(filePath, source)
    .find(({ kind, source: text }) => kind === "function" && text.includes(marker));
  expect(candidate).toBeDefined();
  if (!candidate) throw new Error("fixture candidate missing");
  return candidate;
}

function files(source: string, filePath = "src/webhook.ts"): ProjectFile[] {
  return [{ filePath, source }];
}

const BARE_EXTERNAL = `export async function handleWebhook(req: Request) {
  const payload = JSON.parse(await req.text());
  return payload.event;
}`;

const GUARDED = `import { z } from "zod";
const Event = z.object({ event: z.string() });
export async function handleWebhook(req: Request) {
  try {
    const payload = Event.safeParse(JSON.parse(await req.text()));
    if (!payload.success) throw new Error("bad shape");
    return payload.data.event;
  } catch (error) {
    throw new Error("invalid webhook payload", { cause: error });
  }
}`;

const LOCAL_CONSTANT = `export function defaultConfig() {
  return JSON.parse('{"retries": 3}');
}`;

const NO_PARSE = `export function double(value: number) {
  return value * 2;
}`;

const NESTED_ONLY = `export function makeHandler() {
  return async (req: Request) => {
    const payload = JSON.parse(await req.text());
    return payload;
  };
}`;

class RawScoreEvaluator implements Evaluator {
  requests: EvaluationRequest[] = [];

  async evaluate(request: EvaluationRequest): Promise<Record<string, number>> {
    this.requests.push(request);
    return Object.fromEntries(
      Object.keys(request.questions).map((id) => [id, 0.83]),
    );
  }
}

const ruleConfig: JevLintConfig = {
  rules: {
    "jev/no-bare-json-parse": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this production path decode external JSON with bare JSON.parse so malformed input throws an un-actionable error?",
          inspect: "Compare each parse site and its input provenance with the try coverage, contextual catch, schema validation, and safe wrapper in the supplied evidence.",
          focus: "Judge whether malformed input reaches JSON.parse with no context added and no shape established afterwards.",
          decision_boundary: [
            "JSON.parse on request or body input with no try coverage and no validator is strong evidence of an un-actionable throw.",
            "A contextual catch that rewraps the error or a schema check after the parse weakens the claim.",
            "Parsing a closed literal weakens the claim.",
            "If no JSON.parse site is established, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "External input reaches bare JSON.parse with no contextual catch or schema check",
            remedy: "Catch the parse to add input context or decode through a validating parser",
          },
          false: {
            what: "The parse is guarded, validated, wrapped, or decodes a closed constant",
          },
        },
      },
      message: "This path decodes external JSON with bare JSON.parse.",
    },
  },
};

describe("bare JSON.parse evidence", () => {
  it("fires on bare JSON.parse of request input with no guards", () => {
    const candidate = candidateFor(BARE_EXTERNAL, "src/webhook.ts", "handleWebhook");
    const evidence = buildBareJsonParseEvidence(candidate, files(BARE_EXTERNAL));
    expect(evidence).toMatchObject({
      function: { name: "handleWebhook", exported: true },
      hasContextualCatch: false,
      hasSchemaValidation: false,
      validationLibrary: null,
      hasSafeWrapper: false,
    });
    expect(evidence?.parseSites).toMatchObject([
      {
        inputProvenance: "external",
        insideTry: false,
      },
    ]);
    expect(evidence?.parseSites[0]?.expression).toContain("JSON.parse");
    expect(evidence?.parseSites[0]?.argument).toContain("req.text()");
  });

  it("surfaces try coverage, contextual catch, and schema validation as mitigating context", () => {
    const candidate = candidateFor(GUARDED, "src/webhook.ts", "handleWebhook");
    const evidence = buildBareJsonParseEvidence(candidate, files(GUARDED));
    expect(evidence?.parseSites).toMatchObject([
      {
        inputProvenance: "external",
        insideTry: true,
      },
    ]);
    expect(evidence).toMatchObject({
      hasContextualCatch: true,
      hasSchemaValidation: true,
      validationLibrary: "zod",
    });
  });

  it("marks closed literals as local provenance", () => {
    const candidate = candidateFor(LOCAL_CONSTANT, "src/config.ts", "defaultConfig");
    const evidence = buildBareJsonParseEvidence(
      candidate,
      files(LOCAL_CONSTANT, "src/config.ts"),
    );
    expect(evidence?.parseSites).toMatchObject([{ inputProvenance: "local" }]);
  });

  it("abstains when the function never calls JSON.parse", () => {
    const candidate = candidateFor(NO_PARSE, "src/math.ts", "double");
    expect(buildBareJsonParseEvidence(candidate, files(NO_PARSE, "src/math.ts")))
      .toBeUndefined();
  });

  it("abstains for the outer function when JSON.parse lives only in a nested closure", () => {
    const candidate = candidateFor(NESTED_ONLY, "src/webhook.ts", "makeHandler");
    const nested = extractCandidates("src/webhook.ts", NESTED_ONLY)
      .filter(({ kind }) => kind === "function");
    expect(nested.length).toBeGreaterThan(1);
    expect(buildBareJsonParseEvidence(candidate, files(NESTED_ONLY))).toBeUndefined();
  });

  it("reports the raw evaluator score with the evidence content attached", async () => {
    const evaluator = new RawScoreEvaluator();
    const judgments = await analyzeFile(
      {
        filePath: "src/webhook.ts",
        source: BARE_EXTERNAL,
        changedLines: [{ start: 1, end: 4 }],
        config: ruleConfig,
      },
      evaluator,
    );
    expect(evaluator.requests).toHaveLength(1);
    expect(evaluator.requests[0]?.state.candidates[0]?.evidence?.["jev/no-bare-json-parse"])
      .toMatchObject({
        parseSites: [{ inputProvenance: "external", insideTry: false }],
        hasContextualCatch: false,
        hasSchemaValidation: false,
      });
    expect(judgments).toEqual([
      expect.objectContaining({
        ruleId: "jev/no-bare-json-parse",
        candidateKind: "function",
        probability: 0.83,
        evidence: expect.objectContaining({
          parseSites: expect.arrayContaining([
            expect.objectContaining({ inputProvenance: "external" }),
          ]),
        }),
      }),
    ]);
  });

  it("records a structural abstention when nothing is parsed", async () => {
    const evaluator = new RawScoreEvaluator();
    const result = await analyzeFileWithFailures(
      {
        filePath: "src/math.ts",
        source: NO_PARSE,
        changedLines: [{ start: 1, end: 3 }],
        config: ruleConfig,
      },
      evaluator,
    );
    expect(result.judgments).toEqual([]);
    expect(evaluator.requests).toHaveLength(0);
    expect(result.abstentions).toEqual([
      { ruleId: "jev/no-bare-json-parse", candidateKind: "function", count: 1 },
    ]);
  });
});

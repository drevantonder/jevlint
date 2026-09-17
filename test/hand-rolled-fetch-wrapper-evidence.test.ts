import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { defaultConfig } from "../src/config.js";
import { buildRuleEvidence } from "../src/evidence/index.js";
import { buildHandRolledFetchWrapperEvidence } from "../src/evidence/hand-rolled-fetch-wrapper.js";
import type { ProjectFile } from "../src/types.js";

const RULE = "jev/no-hand-rolled-fetch-wrapper";

function project(ownerSource: string, excerpt: string) {
  const projectFiles: ProjectFile[] = [{ filePath: "src/http.ts", source: ownerSource }];
  const candidate = extractCandidates("src/http.ts", ownerSource)
    .filter(({ kind }) => kind === "function")
    .find(({ source }) => source.includes(excerpt));
  expect(candidate).toBeDefined();
  if (!candidate) throw new Error("Fixture has no transport candidate.");
  return { candidate, projectFiles };
}

const SMELLY = "import https from \"node:https\";\n"
  + "export function getJson(url: string): Promise<unknown> {\n"
  + "  return new Promise((resolve, reject) => {\n"
  + "    https.get(url, (response) => {\n"
  + "      const chunks: Buffer[] = [];\n"
  + "      response.on(\"data\", (chunk: Buffer) => chunks.push(chunk));\n"
  + "      response.on(\"end\", () => {\n"
  + "        if (response.statusCode !== 200) reject(new Error(`bad status ${response.statusCode}`));\n"
  + "        else resolve(JSON.parse(Buffer.concat(chunks).toString()));\n"
  + "      });\n"
  + "    }).on(\"error\", reject);\n"
  + "  });\n"
  + "}\n";

describe("hand rolled fetch wrapper wiring", () => {
  it("ships as a function judgment without thresholds", () => {
    expect(defaultConfig.rules[RULE]).toMatchObject({ scope: "function", message: expect.any(String) });
    expect(defaultConfig.rules[RULE]).not.toHaveProperty("threshold");
    expect(defaultConfig.rules[RULE]).not.toHaveProperty("severity");
  });

  it("passes transport helper candidates through dispatch", () => {
    const { candidate, projectFiles } = project(SMELLY, "getJson");

    const result = buildRuleEvidence(RULE, candidate, projectFiles);

    expect(result).toEqual({ handled: true, evidence: expect.any(Object) });
  });
});

describe("hand rolled fetch wrapper evidence", () => {
  it("reports node:https request assembly with chunk handling", () => {
    const { candidate, projectFiles } = project(SMELLY, "getJson");

    const evidence = buildHandRolledFetchWrapperEvidence(candidate, projectFiles);

    expect(evidence).toMatchObject({
      function: { name: "getJson" },
      transportImport: "node:https",
      requestAssembly: expect.arrayContaining(["request-call", "status-branching"]),
      chunkHandling: expect.arrayContaining(["data-listener", "chunk-concat", "end-listener"]),
      transportOptions: [],
      jsonHelper: true,
    });
  });

  it("carries proxy configuration as justification signal", () => {
    const { candidate, projectFiles } = project(
      "import https from \"node:https\";\n"
        + "export function getViaProxy(url: string, proxy: string): Promise<string> {\n"
        + "  return new Promise((resolve, reject) => {\n"
        + "    const target = new URL(url);\n"
        + "    const request = https.request({ host: target.host, path: target.pathname, agent: new https.Agent({ proxy } as never) }, (response) => {\n"
        + "      const chunks: Buffer[] = [];\n"
        + "      response.on(\"data\", (chunk: Buffer) => chunks.push(chunk));\n"
        + "      response.on(\"end\", () => resolve(Buffer.concat(chunks).toString()));\n"
        + "    });\n"
        + "    request.on(\"error\", reject);\n"
        + "    request.end();\n"
        + "  });\n"
        + "}\n",
      "getViaProxy",
    );

    const evidence = buildHandRolledFetchWrapperEvidence(candidate, projectFiles);

    expect(evidence).toMatchObject({ transportOptions: expect.arrayContaining(["proxy", "agent"]) });
  });

  it("abstains when the helper already delegates to fetch", () => {
    const { candidate, projectFiles } = project(
      "export function getJson(url: string): Promise<unknown> {\n"
        + "  return fetch(url).then((response) => {\n"
        + "    if (!response.ok) throw new Error(`bad status ${response.status}`);\n"
        + "    return response.json();\n"
        + "  });\n"
        + "}\n",
      "getJson",
    );

    expect(buildHandRolledFetchWrapperEvidence(candidate, projectFiles)).toBeUndefined();
  });
});

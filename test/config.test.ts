import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultConfig, loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("uses the bundled rules when no config file exists", async () => {
    const directory = await mkdtemp(join(tmpdir(), "jevlint-config-"));

    const config = await loadConfig({ cwd: directory });

    expect(Object.keys(config.rules)).toEqual([
      "jev/no-hidden-input-mutation",
      "jev/no-hidden-io",
      "jev/no-lossy-sentinel-return",
      "jev/no-query-side-effect",
      "jev/no-narrating-comment",
      "jev/no-pass-through-wrapper",
      "jev/no-mysterious-name",
      "jev/no-speculative-generality",
      "jev/no-ad-hoc-branching",
      "jev/no-mixed-responsibilities",
      "jev/no-data-clump",
      "jev/no-scattered-policy",
      "jev/no-correlated-state-booleans",
      "jev/no-unconstrained-state-string",
      "jev/no-conditionally-valid-state",
      "jev/no-needless-abstraction",
      "jev/no-generic-magic",
      "jev/no-disproportionate-configuration",
      "jev/no-avoidable-orchestration",
      "jev/no-hidden-runtime-input",
      "jev/no-hidden-initialization-order",
      "jev/no-implicit-atomicity",
      "jev/no-complexity-displacement",
      "jev/no-transport-coupled-domain",
      "jev/no-persistence-model-leak",
      "jev/no-interchangeable-domain-primitives",
      "jev/no-domain-policy-in-adapter",
      "jev/no-feature-envy",
    ]);
  });

  it("rejects malformed rule settings at the config boundary", async () => {
    const directory = await mkdtemp(join(tmpdir(), "jevlint-config-"));
    await writeFile(
      join(directory, "jevlint.config.ts"),
      `export default {
        rules: {
          "personal/invalid": {
            scope: "function",
            question: { instructions: "Is this invalid?" },
            threshold: 2,
            severity: "warning",
            message: "Invalid threshold."
          }
        }
      }`,
    );

    await expect(loadConfig({ cwd: directory })).rejects.toThrow();
  });

  it("loads TypeScript config and allows bundled rules to be disabled", async () => {
    const directory = await mkdtemp(join(tmpdir(), "jevlint-config-"));
    const configPath = join(directory, "jevlint.config.ts");
    await writeFile(
      configPath,
      `export default {
        rules: {
          "jev/no-narrating-comment": "off",
          "personal/suspicious-name": {
            scope: "function",
            question: { instructions: "Is this function misleadingly named?" },
            threshold: 0.9,
            severity: "error",
            message: "Function name is misleading."
          }
        }
      }`,
    );

    const config = await loadConfig({ cwd: directory });

    expect(config.rules["jev/no-narrating-comment"]).toBeUndefined();
    expect(config.rules["jev/no-pass-through-wrapper"]).toEqual(
      defaultConfig.rules["jev/no-pass-through-wrapper"],
    );
    expect(config.rules["personal/suspicious-name"]).toMatchObject({
      scope: "function",
      severity: "error",
    });
  });
});

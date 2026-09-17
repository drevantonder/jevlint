import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildEnglishOnlyPluralizationEvidence } from "../src/evidence/english-only-pluralization.js";

const pipelined = `import { t } from "i18next";
export function cartLabel(count: number) {
  return count === 1 ? t("cart.item.one") : t("cart.item.other");
}
`;

const localeFile = {
  filePath: "locales/en.json",
  source: `{"cart": {"item": {"one": "item", "other": "items"}}}`,
};

const frameworkUser = {
  filePath: "src/other.ts",
  source: `import i18next from "i18next";
export function boot() {
  return i18next.language;
}
`,
};

const withRules = `import { t } from "i18next";
export function cartLabel(count: number) {
  const form = new Intl.PluralRules("en").select(count);
  return count === 1 ? t("cart.item.one") : t("cart.item.other", { form });
}
`;

const bareLiteral = `export function cartLabel(count: number) {
  return count === 1 ? \`\${count} item\` : \`\${count} items\`;
}
`;

function candidateFor(source: string, filePath: string, marker: string) {
  const candidate = extractCandidates(filePath, source)
    .find(({ kind, source: text }) => kind === "function" && text.includes(marker));
  expect(candidate).toBeDefined();
  return candidate!;
}

describe("english only pluralization evidence", () => {
  it("extracts an English branch over translation keys with locale reach", () => {
    const filePath = "src/cart.ts";
    const evidence = buildEnglishOnlyPluralizationEvidence(
      candidateFor(pipelined, filePath, "cartLabel"),
      [{ filePath, source: pipelined }, localeFile, frameworkUser],
    );

    expect(evidence).toMatchObject({
      function: { name: "cartLabel" },
      usesPluralRules: false,
      localeReach: ["locales/en.json"],
    });
    expect(evidence?.pluralBranches.length).toBe(1);
    expect(evidence?.projectI18nFrameworks).toContain("i18next");
  });

  it("marks Intl.PluralRules as the plural-rules path", () => {
    const filePath = "src/cart.ts";
    const evidence = buildEnglishOnlyPluralizationEvidence(
      candidateFor(withRules, filePath, "cartLabel"),
      [{ filePath, source: withRules }, localeFile, frameworkUser],
    );

    expect(evidence).toMatchObject({ usesPluralRules: true });
    expect(evidence?.pluralBranches.length).toBe(1);
  });

  it("abstains on bare literal ternaries, which belong to unlocalized strings", () => {
    const filePath = "src/cart.ts";
    expect(buildEnglishOnlyPluralizationEvidence(
      candidateFor(bareLiteral, filePath, "cartLabel"),
      [{ filePath, source: bareLiteral }, localeFile, frameworkUser],
    )).toBeUndefined();
  });

  it("abstains in a single-locale product with no i18n shelf", () => {
    const localT = `function t(key: string) {
  return key;
}
export function cartLabel(count: number) {
  return count === 1 ? t("cart.item.one") : t("cart.item.other");
}
`;
    const filePath = "src/cart.ts";
    expect(buildEnglishOnlyPluralizationEvidence(
      candidateFor(localT, filePath, "cartLabel"),
      [{ filePath, source: localT }],
    )).toBeUndefined();
  });
});

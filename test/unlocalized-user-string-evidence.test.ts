import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildUnlocalizedUserStringEvidence } from "../src/evidence/unlocalized-user-string.js";
import type { ProjectFile } from "../src/types.js";

const smelly = `export function CheckoutSummary({ count }: { count: number }) {
  return (
    <div>
      <p>Order complete</p>
      <span>{count === 1 ? "item" : "items"}</span>
    </div>
  );
}
`;

const i18nModule: ProjectFile = {
  filePath: "src/i18n.ts",
  source: `import i18next from "i18next";
export const locale = i18next.language;
`,
};

const translated = `import { useTranslation } from "react-i18next";
export function CheckoutSummary() {
  const { t } = useTranslation();
  return <p>{t("order.complete")}</p>;
}
`;

const thrown = `export function loadCart(id: string) {
  const cart = store.get(id);
  if (!cart) throw new Error("Cart not found");
  return cart;
}
`;

const internalOnly = `export function cartKey(id: string) {
  return ["cart", id].join(":");
}
`;

function candidateFor(source: string, filePath: string, marker: string) {
  const candidate = extractCandidates(filePath, source)
    .find(({ kind, source: text }) => kind === "function" && text.includes(marker));
  expect(candidate).toBeDefined();
  return candidate!;
}

describe("unlocalized user string evidence", () => {
  it("captures JSX copy and hand-rolled plurals beside an i18n framework", () => {
    const filePath = "src/summary.tsx";
    const files = [{ filePath, source: smelly }, i18nModule];
    const evidence = buildUnlocalizedUserStringEvidence(
      candidateFor(smelly, filePath, "CheckoutSummary"),
      files,
    );

    expect(evidence).toMatchObject({
      function: { name: "CheckoutSummary", exported: true },
      surfaceStrings: [{ kind: "jsx-text", text: "Order complete" }],
      plurals: [{ expression: expect.stringContaining("item") }],
      i18nInFunction: false,
      projectI18nFrameworks: ["i18next"],
    });
  });

  it("captures thrown messages for surfaced-error judgment", () => {
    const filePath = "src/cart.ts";
    const files = [{ filePath, source: thrown }];
    const evidence = buildUnlocalizedUserStringEvidence(candidateFor(thrown, filePath, "loadCart"), files);

    expect(evidence?.surfaceStrings).toMatchObject([{ kind: "thrown" }]);
    expect(evidence?.projectI18nFrameworks).toEqual([]);
  });

  it("abstains when copy already passes through translation", () => {
    const filePath = "src/summary.tsx";
    const files = [{ filePath, source: translated }];
    const evidence = buildUnlocalizedUserStringEvidence(
      candidateFor(translated, filePath, "CheckoutSummary"),
      files,
    );

    expect(evidence).toBeUndefined();
  });

  it("abstains when no user-surface string exists", () => {
    const filePath = "src/cart.ts";
    const files = [{ filePath, source: internalOnly }];
    expect(buildUnlocalizedUserStringEvidence(candidateFor(internalOnly, filePath, "cartKey"), files))
      .toBeUndefined();
  });

  it("includes callers for surface-visibility sensitivity", () => {
    const filePath = "src/summary.tsx";
    const files: ProjectFile[] = [
      { filePath, source: smelly },
      {
        filePath: "src/page.tsx",
        source: `import { CheckoutSummary } from "./summary";\nexport function Page() { return CheckoutSummary({ count: 2 }); }`,
      },
    ];
    const evidence = buildUnlocalizedUserStringEvidence(
      candidateFor(smelly, filePath, "CheckoutSummary"),
      files,
    );
    expect(evidence?.callers).toMatchObject([{ filePath: "src/page.tsx" }]);
  });
});

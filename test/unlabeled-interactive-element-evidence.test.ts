import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildUnlabeledInteractiveElementEvidence } from "../src/evidence/unlabeled-interactive-element.js";
import type { ProjectFile } from "../src/types.js";

const smelly = `export function Dialog({ onClose }: { onClose: () => void }) {
  return (
    <div role="dialog">
      <button onClick={onClose}>
        <Icon />
      </button>
    </div>
  );
}
`;

const labeled = `export function Dialog({ onClose }: { onClose: () => void }) {
  return (
    <div role="dialog">
      <button aria-label="Close" onClick={onClose}>
        <Icon />
      </button>
    </div>
  );
}
`;

const associated = `export function Search() {
  return (
    <form>
      <label htmlFor="q">Query</label>
      <input id="q" type="text" />
    </form>
  );
}
`;

const hidden = `export function TokenForm() {
  return (
    <form>
      <input type="hidden" value="abc" />
    </form>
  );
}
`;

const linkClick = `export function More({ onMore }: { onMore: () => void }) {
  return (
    <a onClick={onMore}>
      <Icon />
    </a>
  );
}
`;

function candidateFor(source: string, filePath: string, marker: string) {
  const candidate = extractCandidates(filePath, source)
    .find(({ kind, source: text }) => kind === "function" && text.includes(marker));
  expect(candidate).toBeDefined();
  return candidate!;
}

describe("unlabeled interactive element evidence", () => {
  it("flags an icon-only button with no accessible name", () => {
    const filePath = "src/Dialog.tsx";
    const files = [{ filePath, source: smelly }];
    const evidence = buildUnlabeledInteractiveElementEvidence(
      candidateFor(smelly, filePath, "Dialog"),
      files,
    );

    expect(evidence).toMatchObject({
      function: { name: "Dialog", exported: true },
      elements: [{ tag: "button", trigger: "button", titled: false }],
    });
    expect(evidence?.elements[0]?.expression).toContain("<button");
  });

  it("flags a click-handled anchor with no name", () => {
    const filePath = "src/More.tsx";
    const files = [{ filePath, source: linkClick }];
    const evidence = buildUnlabeledInteractiveElementEvidence(
      candidateFor(linkClick, filePath, "More"),
      files,
    );

    expect(evidence?.elements).toMatchObject([{ tag: "a", trigger: "link-click" }]);
  });

  it("abstains when the button carries an aria label", () => {
    const filePath = "src/Dialog.tsx";
    const files = [{ filePath, source: labeled }];
    expect(buildUnlabeledInteractiveElementEvidence(candidateFor(labeled, filePath, "Dialog"), files))
      .toBeUndefined();
  });

  it("abstains when a label is associated with the input", () => {
    const filePath = "src/Search.tsx";
    const files = [{ filePath, source: associated }];
    const evidence = buildUnlabeledInteractiveElementEvidence(
      candidateFor(associated, filePath, "Search"),
      files,
    );

    expect(evidence).toBeUndefined();
  });

  it("abstains for hidden inputs outside assistive technology", () => {
    const filePath = "src/TokenForm.tsx";
    const files = [{ filePath, source: hidden }];
    expect(buildUnlabeledInteractiveElementEvidence(candidateFor(hidden, filePath, "TokenForm"), files))
      .toBeUndefined();
  });

  it("includes callers for exposure sensitivity", () => {
    const filePath = "src/Dialog.tsx";
    const files: ProjectFile[] = [
      { filePath, source: smelly },
      {
        filePath: "src/App.tsx",
        source: `import { Dialog } from "./Dialog";\nexport function App() { return Dialog({ onClose: () => {} }); }`,
      },
    ];
    const evidence = buildUnlabeledInteractiveElementEvidence(
      candidateFor(smelly, filePath, "Dialog"),
      files,
    );
    expect(evidence?.callers).toMatchObject([{ filePath: "src/App.tsx" }]);
  });
});

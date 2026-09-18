import { defineConfig } from "./src/config.js";

// jevlint reviews itself here: the rulehealth plugin judges this repo's own
// rule corpus (src/evidence/* builders plus src/defaults.ts propositions).
// The meta-rules abstain on every file outside that corpus by construction,
// so a full-tree run stays quiet apart from the corpus. To look only at the
// corpus, scope the run with PATHs:
//
//   pnpm jevlint audit src/evidence src/defaults.ts
export default defineConfig({
  plugins: [{ name: "rulehealth", specifier: "./src/rulehealth/plugin.ts" }],
});

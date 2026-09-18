// Fixture plugin: plain descriptor objects (defineRule/definePlugin are
// identity helpers, so omitting them here changes nothing at load).
import type { Candidate } from "../../src/types.js";

export default {
  name: "acme",
  rules: {
    "no-todo-without-ticket": {
      name: "no-todo-without-ticket",
      scope: "comment",
      question: {
        instructions: "Does this TODO comment name a trackable ticket?",
        criteria: {
          true: "The comment references a ticket identifier",
          false: "The comment names no ticket",
        },
      },
      message: "TODO comment names no trackable ticket.",
      buildEvidence: (candidate: Candidate) => {
        if (!/TODO/.test(candidate.source)) return undefined;
        return { source: candidate.source, hasTicket: /[A-Z]+-\d+/.test(candidate.source) };
      },
    },
    "no-forwarding-function": {
      name: "no-forwarding-function",
      scope: "function",
      question: {
        instructions: "Does this function merely forward its arguments?",
      },
      message: "Function only forwards its arguments.",
      buildEvidence: (candidate: Candidate) => ({ source: candidate.source }),
    },
  },
};

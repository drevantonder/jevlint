import type { JevLintConfig } from "./types.js";

export const defaultConfig: JevLintConfig = {
  rules: {
    "jev/no-hidden-input-mutation": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this function mutate a caller-owned input without making that behavior clear in its API contract?",
          inspect: "Compare the function name, parameter contract, extracted mutations, module context, and repository callers in the supplied evidence.",
          focus: "Judge whether a reasonable caller would understand before reading the implementation that the supplied object or collection will change in place.",
          decision_boundary: [
            "Names such as normalize, prepare, map, or transform usually promise a result, not mutation of the input used to produce it.",
            "Returning the same mutated value does not by itself disclose in-place mutation.",
            "Names such as mutate, inPlace, appendTo, or explicit mutable accumulator contracts can disclose mutation clearly.",
            "Builder callbacks, reducers, performance-sensitive buffer APIs, and framework lifecycle hooks may intentionally accept mutable inputs when that contract is visible.",
            "If the evidence does not establish caller ownership or whether mutation is part of the contract, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "The function changes an argument that callers can still observe, while its name and visible contract suggest a pure transformation or do not disclose mutation",
            remedy: "Return a new value or rename and document the API so in-place mutation is explicit",
          },
          false: {
            what: "The function returns a copy, mutates only local state, clearly advertises in-place behavior, follows an explicit mutable protocol, or lacks enough evidence to establish surprise",
          },
        },
      },
      threshold: 0.85,
      severity: "warning",
      message: "This function mutates caller-owned input without making that behavior clear.",
    },
    "jev/no-query-side-effect": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this value-returning function conceal a material command behind an API that presents itself as a query?",
          inspect: "Compare the function name and return paths with each extracted side effect, its resolved target module, and the repository callers in the supplied evidence.",
          focus: "Judge whether callers seeking information would be surprised that the call also changes domain or persistent state.",
          decision_boundary: [
            "A get, find, check, calculate, or similarly query-shaped API that reserves, consumes, marks, publishes, or otherwise changes domain state is strong evidence of a concealed command.",
            "Commands such as create, reserve, update, or consume may return useful values without pretending to be queries.",
            "Logging, metrics, tracing, and behavior-preserving cache population are operational side effects, not command-query mixing when they do not change the domain result.",
            "An ignored call or assignment is only a structural candidate; use its target and context to establish a material state change.",
            "If the target behavior or the API's query contract is unclear, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "The API promises information while also performing a caller-relevant state change that callers cannot infer from its contract",
            remedy: "Separate the query from the command or rename the operation so the state change is explicit",
          },
          false: {
            what: "The function is a clearly named command, remains observational apart from telemetry or caching, has no material state change, or lacks enough evidence to classify the effect",
          },
        },
      },
      threshold: 0.85,
      severity: "warning",
      message: "This query-shaped API also performs a hidden state-changing command.",
    },
    "jev/no-narrating-comment": {
      scope: "comment",
      question: {
        instructions: {
          question: "Does the comment merely narrate behavior already obvious from the nearby code?",
          focus: "Judge whether the comment adds information beyond the syntax and plainly visible behavior.",
        },
        criteria: {
          true: {
            what: "The comment repeats the operation performed by the nearby code",
            examples: ["Increment the counter", "Return the normalized user"],
          },
          false: {
            what: "The comment explains intent, constraints, tradeoffs, or surprising behavior",
            examples: ["Keep this adapter so callers do not depend on the vendor API"],
          },
        },
      },
      threshold: 0.85,
      severity: "warning",
      message: "Comment restates nearby code.",
    },
    "jev/no-pass-through-wrapper": {
      scope: "function",
      question: {
        instructions: {
          question: "Does the repository evidence show that callers should bypass this delegating function and call its target directly?",
          inspect: "Compare the wrapper with its delegated target, module ownership, imports, exports, and actual callers in the supplied evidence.",
          focus: "Judge whether deleting the wrapper would preserve behavior while requiring callers to know no additional policy or implementation detail.",
          decision_boundary: [
            "A project-owned wrapper forwarding to a project-owned target with the same operation and vocabulary is strong evidence of an unnecessary middleman.",
            "A domain-owned wrapper around an external package is a useful dependency boundary even when the body is a single call.",
            "Being exported is not by itself evidence of a stable public boundary.",
            "If callers, ownership, or target information is insufficient, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "The target is equally suitable for the shown callers, and the wrapper contributes no policy, vocabulary, stable contract, ownership boundary, or dependency isolation",
            examples: [
              "A local getUserById function only calls a local repository's getUserById with the same argument",
            ],
            remedy: "Have callers use the project-owned target directly and remove the extra hop",
          },
          false: {
            what: "The wrapper establishes a useful boundary, changes meaning, or cannot safely be judged from the supplied evidence",
            examples: [
              "A domain module prevents callers from importing an external vendor SDK",
              "An interface implementation or substitutable seam",
              "A stable public API over replaceable implementation modules",
              "Validation, authorization, observability, caching, translation, or error policy",
            ],
          },
        },
      },
      threshold: 0.8,
      severity: "warning",
      message: "This function appears to be an unnecessary delegation layer.",
    },
    "jev/no-mysterious-name": {
      scope: "function",
      question: {
        instructions: {
          question: "Do the function name or its important local names fail to communicate their purpose?",
          focus: "Judge whether a reader must reconstruct meaning from the implementation because names are vague placeholders.",
        },
        criteria: {
          true: {
            what: "The function or important values use opaque names such as doIt, process, handle, data, x, or result without domain context",
            not_for: "Short conventional names whose meaning is obvious in a tiny local scope",
          },
          false: {
            what: "Names state the domain action and the role of important values",
          },
        },
      },
      threshold: 0.85,
      severity: "warning",
      message: "Names obscure this function's purpose.",
    },
    "jev/no-speculative-generality": {
      scope: "function",
      question: {
        instructions: {
          question: "Does the repository evidence show that this function carries extension points for hypothetical rather than demonstrated variation?",
          inspect: "Compare the function's options, callbacks, hooks, strategies, or generic parameters with its real callers and their observed argument lists.",
          focus: "Judge whether removing unused flexibility would preserve all behavior demonstrated in the repository while making the function materially simpler.",
          decision_boundary: [
            "Repeated callers using only the same simple path are strong evidence that elaborate extension points are speculative.",
            "Callers exercising distinct meaningful modes are evidence that the variation is real.",
            "A framework, plugin, library, or public extension boundary may serve callers outside the repository; require stronger evidence before flagging it.",
            "A default parameter or generic type alone is not a smell.",
          ],
        },
        criteria: {
          true: {
            what: "The function implements substantial flexibility that no shown caller or current responsibility needs",
            examples: [
              "Lifecycle hooks and transformation callbacks around joining a first and last name while every caller uses defaults",
            ],
            remedy: "Keep the concrete behavior and add extension points only when a real variation appears",
          },
          false: {
            what: "The evidence demonstrates meaningful variation, an intentional external extension boundary, or too little caller coverage to judge safely",
          },
        },
      },
      threshold: 0.85,
      severity: "warning",
      message: "This function contains flexibility not justified by its observed uses.",
    },
    "jev/no-ad-hoc-branching": {
      scope: "function",
      question: {
        instructions: {
          question: "Do the extracted branches form a patchwork of unrelated special-case policies rather than one coherent decision?",
          inspect: "Compare every branch condition, its outcome, the surrounding module, and the function's role and callers in the supplied evidence.",
          focus: "Look for independent business dimensions and exceptions that have accumulated without a shared discriminant, policy type, or explicit decision model.",
          decision_boundary: [
            "Several conditions involving unrelated flags, regions, customer exceptions, sources, or thresholds are strong evidence of ad-hoc policy accumulation.",
            "An exhaustive switch over one discriminated state is cohesive even when it has many cases.",
            "Ordered validation, parsing, and guard clauses may test different facts while still serving one clear invariant.",
            "Branch count alone is never sufficient.",
          ],
        },
        criteria: {
          true: {
            what: "The branches encode multiple unrelated policy dimensions with no visible organizing domain concept",
            examples: ["Region plus legacy status, an unrelated review flag, and source plus amount in one routing function"],
            remedy: "Model the policy dimensions explicitly or separate decisions by responsibility",
          },
          false: {
            what: "The branches are a cohesive decision tree, exhaustive state handling, ordered validation, parsing, or guards around one invariant",
          },
        },
      },
      threshold: 0.85,
      severity: "warning",
      message: "This function appears to accumulate unrelated special-case policies.",
    },
    "jev/no-correlated-state-booleans": {
      scope: "abstraction",
      question: {
        instructions: {
          question: "Does this type use boolean fields as mutually dependent alternatives of one state, allowing contradictory or meaningless combinations?",
          inspect: "Use the declared shape, each boolean field, and the typed construction, transition, and read sites in the repository evidence.",
          focus: "Judge whether these booleans jointly encode one lifecycle or choice that should have one explicit set of valid cases.",
          decision_boundary: [
            "Flags that are repeatedly reset together or checked in priority order as alternative statuses are strong evidence of one state split across booleans.",
            "Independent capabilities, permissions, preferences, filters, and feature flags may combine freely and are not a violation.",
            "Separate observations can legitimately disagree, such as network availability and service reachability.",
            "Two or more boolean fields alone are never enough. If their relationship or invalid combinations are not established by the evidence, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "The booleans represent exclusive or dependent cases of one concept, and the declared type admits combinations the code does not meaningfully handle",
            remedy: "Replace the correlated flags with a discriminated union, enum-like status, or separate valid case types",
          },
          false: {
            what: "The booleans are independent dimensions, intentionally combinable controls, distinct observations, or too weakly evidenced to prove a shared state",
          },
        },
      },
      threshold: 0.85,
      severity: "warning",
      message: "Correlated booleans make contradictory states representable.",
    },
    "jev/no-unconstrained-state-string": {
      scope: "abstraction",
      question: {
        instructions: {
          question: "Does this type leave a closed internal state unconstrained as string even though repository decisions rely on a finite set of literal cases?",
          inspect: "Use the string property, its literal comparisons or switch cases, transitions, typed usages, and module context in the supplied evidence.",
          focus: "Decide whether the property is an internal finite state whose valid values the type should enumerate.",
          decision_boundary: [
            "Exhaustive-looking branches, rejection of unknown values, and transitions among a few named lifecycle values are strong evidence of closed state.",
            "Strings from wire formats, storage schemas, plugins, or vendor protocols may need to accept unknown future values at that boundary.",
            "Open domains such as locale tags, MIME types, user input, and external identifiers remain strings even when code special-cases a few values.",
            "A few literal comparisons alone are not proof of a closed set. If the evidence does not establish finite internal state, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "The property represents a finite internal lifecycle or mode, but its string type accepts values outside every meaningful case",
            remedy: "Use a literal union, enum-like type, or discriminated union and parse external strings at the boundary",
          },
          false: {
            what: "The string belongs to an open domain, preserves forward compatibility at an external boundary, or lacks enough evidence of a closed set",
          },
        },
      },
      threshold: 0.85,
      severity: "warning",
      message: "A closed state is represented by an unconstrained string.",
    },
    "jev/no-conditionally-valid-state": {
      scope: "abstraction",
      question: {
        instructions: {
          question: "Does this record make payload validity depend on a discriminant while its type permits payloads to be missing or present in the wrong cases?",
          inspect: "Use the finite discriminant, optional or nullable fields, case-specific reads, typed usages, and module context in the repository evidence.",
          focus: "Judge whether each discriminant case has a different required payload that should be encoded as a separate valid variant.",
          decision_boundary: [
            "Non-null assertions or assumed payload reads in particular cases are strong evidence that the flat record omits a type invariant.",
            "Optional metadata that has the same meaning in every case does not need to become part of each variant.",
            "Generated wire types and external schemas may need to preserve a permissive upstream contract; prefer mapping them into valid internal state rather than flagging the boundary type itself.",
            "A tagged record with optional fields is not enough. If case-specific requirements are unclear, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "At least one payload is required or forbidden according to the discriminant, but the declared record accepts combinations that violate that invariant",
            remedy: "Represent each valid case as a discriminated union member with exactly its required payload",
          },
          false: {
            what: "The loose fields are case-independent metadata, optional by domain meaning, fixed by an external contract, or not proven to depend on a case",
          },
        },
      },
      threshold: 0.85,
      severity: "warning",
      message: "This state type permits invalid discriminant and payload combinations.",
    },
    "jev/no-needless-abstraction": {
      scope: "abstraction",
      question: {
        instructions: {
          question: "Does this interface add ceremony and concepts without removing meaningful coupling or enabling demonstrated substitution?",
          inspect: "Judge the interface together with every discovered implementation and consumer in the supplied repository evidence.",
          focus: "Compare the knowledge consumers would need with and without the abstraction, not merely the number of implementations.",
          decision_boundary: [
            "One trivial implementation and consumers that instantiate it directly are strong evidence that the interface adds a needless layer.",
            "A domain-owned port that isolates an external dependency is useful even with one production implementation.",
            "Multiple real implementations, test substitution, platform variants, or ownership boundaries demonstrate useful abstraction.",
            "One implementation alone is not proof of a smell.",
          ],
        },
        criteria: {
          true: {
            what: "Removing the interface and using the concrete behavior would preserve responsibilities while reducing names, indirection, and wiring",
            remedy: "Keep the concrete implementation until a boundary or second behavior creates a real abstraction",
          },
          false: {
            what: "The interface isolates ownership or dependencies, supports demonstrated substitution, or gives consumers a materially simpler contract",
          },
        },
      },
      threshold: 0.85,
      severity: "warning",
      message: "This abstraction appears to add ceremony without reducing coupling.",
    },
    "jev/no-generic-magic": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this function use reflection or dynamic indirection where explicit code would better fit the concrete variation shown by the repository?",
          inspect: "Compare the extracted dynamic operations with the function's real callers, argument shapes, and surrounding module.",
          focus: "Judge whether the mechanism removes genuine repetition across changing shapes or hides one small fixed mapping behind generic machinery.",
          decision_boundary: [
            "Computed property mapping, reflection, or metadata dispatch for one fixed known shape is strong evidence of generic magic.",
            "Callers demonstrating distinct field sets or runtime-defined shapes justify a dynamic mechanism.",
            "Serialization, framework integration, and schema-driven code often have inherently dynamic inputs.",
            "A generic type parameter or one computed access alone is not proof.",
          ],
        },
        criteria: {
          true: {
            what: "The dynamic mechanism obscures a small stable operation and its observed callers do not need the generality",
            remedy: "Express the known mapping or behavior directly",
          },
          false: {
            what: "The evidence shows genuinely dynamic shapes, multiple meaningful mappings, or an inherently reflective boundary",
          },
        },
      },
      threshold: 0.85,
      severity: "warning",
      message: "Dynamic machinery obscures a simpler concrete operation.",
    },
    "jev/no-disproportionate-configuration": {
      scope: "abstraction",
      question: {
        instructions: {
          question: "Is this configuration surface substantially larger and more interactive than the variation its real callers need?",
          inspect: "Compare every option with the configured functions and the complete argument combinations observed at their repository call sites.",
          focus: "Judge the conceptual and interaction cost of the options, not option count by itself.",
          decision_boundary: [
            "Hooks, transforms, retry controls, and modes left unused while every caller supplies the same simple option are strong evidence of disproportionate configuration.",
            "Distinct caller combinations that represent real behavior justify a configuration object.",
            "Configuration for an external library or public boundary may be used outside the repository; require stronger evidence before flagging it.",
            "Several independent ordinary request parameters are not automatically excessive.",
          ],
        },
        criteria: {
          true: {
            what: "Most of the configuration machinery and its interactions are unsupported by observed use and complicate a simple operation",
            remedy: "Expose only current decisions and add options when concrete callers need them",
          },
          false: {
            what: "Callers exercise meaningful combinations, the options map directly to inherent domain variability, or external usage is plausibly unobserved",
          },
        },
      },
      threshold: 0.85,
      severity: "warning",
      message: "This configuration surface is disproportionate to its observed uses.",
    },
    "jev/no-avoidable-orchestration": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this function impose sequential orchestration that the shown data and effect dependencies do not require?",
          inspect: "Use the ordered await steps, their bound results, syntactic dependencies, function context, and callers in the supplied evidence.",
          focus: "Distinguish independent work serialized by habit from ordering required by causality, transactions, rate limits, or side effects.",
          decision_boundary: [
            "Several awaits that use only original inputs and not prior results are strong evidence of avoidable serialization.",
            "A later step consuming an earlier result demonstrates a real data dependency.",
            "Inventory, payment, persistence, and other effects may require ordering even when no identifier dependency is visible.",
            "Sequential syntax alone is not proof; infer effect constraints cautiously.",
          ],
        },
        criteria: {
          true: {
            what: "The steps are independent in the supplied evidence and no ordering, transaction, rate-limit, or side-effect constraint is visible",
            remedy: "Run independent work together or simplify the orchestration boundary",
          },
          false: {
            what: "Data flow or credible effect constraints require the order, or the evidence is insufficient to establish independence",
          },
        },
      },
      threshold: 0.85,
      severity: "warning",
      message: "This function serializes work without a visible dependency.",
    },
    "jev/no-complexity-displacement": {
      scope: "change",
      question: {
        instructions: {
          question: "Does this change make one location look simpler mainly by pushing equivalent or greater complexity into callers, wiring, interfaces, or adjacent files?",
          inspect: "Compare every before/after file and declaration in the supplied change evidence, tracking responsibilities, invariants, branches, concepts, and required knowledge across boundaries.",
          focus: "Judge the repository-wide cognitive burden after the change, not local line count or whether code moved.",
          decision_boundary: [
            "Replacing direct behavior with callbacks, strategy objects, configuration, or caller wiring that restates the same behavior is strong evidence of displacement.",
            "Moving validation into a domain object or dependency details behind an ownership boundary can reduce complexity by improving cohesion.",
            "Extraction into well-named units is not displacement when each unit owns a distinct responsibility and callers know less.",
            "More files or declarations alone are not proof; compare concepts and knowledge required before and after.",
            "If the coverage metadata shows omitted or materially truncated context needed for the judgment, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "The after-state preserves the original decisions but spreads them across more concepts or forces other code to assemble them, without a clearer ownership boundary",
            remedy: "Simplify the whole path or place the responsibility with its natural owner rather than exporting the complexity",
          },
          false: {
            what: "The change removes decisions, improves responsibility ownership, isolates dependencies, or lowers total knowledge required despite introducing structure",
          },
        },
      },
      threshold: 0.8,
      severity: "warning",
      message: "This change appears to move complexity rather than reduce it.",
    },
    "jev/no-feature-envy": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this function primarily inspect or manipulate another object's data in a way that belongs on that object?",
          focus: "Look for repeated navigation into one collaborator's fields and domain decisions based mostly on those fields.",
        },
        criteria: {
          true: {
            what: "Most of the logic depends on another object's internal data and could naturally move to that owner",
          },
          false: {
            what: "The function coordinates peers, uses its own state, or asks the collaborator to perform its own domain operation",
          },
        },
      },
      threshold: 0.85,
      severity: "warning",
      message: "This behavior appears to belong with the data it inspects.",
    },
  },
};

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
    "jev/no-hidden-io": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this function cross a material I/O boundary whose latency, failure modes, or resource cost are hidden by its API contract?",
          inspect: "Compare the function name and signature with each confirmed or possible I/O operation, resolved project target, module context, and repository caller in the supplied evidence.",
          focus: "Judge whether a caller can reasonably tell that invoking this API may perform network, disk, database, process, or similar external I/O rather than local computation.",
          decision_boundary: [
            "Names such as calculate, format, resolve, or build usually imply local work when no domain convention says otherwise.",
            "Names such as fetch, load, read, write, request, send, persist, or repository operations normally disclose an I/O boundary.",
            "An async declaration reveals a Promise and scheduling boundary, but not by itself a network, disk, or database dependency.",
            "In-memory async work, lazy local initialization, and behavior-preserving memoization are not material I/O.",
            "Treat possible boundaries as insufficient unless the supplied target or context establishes actual external I/O.",
          ],
        },
        criteria: {
          true: {
            what: "The implementation performs confirmed material I/O while the API presents the operation as cheap, local, or computational",
            remedy: "Rename or redesign the API so callers can anticipate latency, failure, and resource cost",
          },
          false: {
            what: "The contract discloses the boundary, the work is local, only operational caching is involved, or the evidence does not confirm external I/O",
          },
        },
      },
      threshold: 0.85,
      severity: "warning",
      message: "This API hides a material I/O boundary and its cost.",
    },
    "jev/no-lossy-sentinel-return": {
      scope: "function",
      question: {
        instructions: {
          question: "Do this function's sentinel return paths collapse distinct outcomes that callers reasonably need to tell apart?",
          inspect: "Compare every sentinel path and its condition with successful returns, the function's named abstraction, module context, and actual repository callers in the supplied evidence.",
          focus: "Judge information loss at the API boundary, not whether null, undefined, or -1 appears at all.",
          decision_boundary: [
            "Invalid input, unsupported cases, authorization failure, dependency failure, and ordinary absence often require different caller actions; collapsing them into one sentinel is strong evidence of a lossy contract.",
            "Several paths may intentionally mean one domain outcome, such as no active session covering both missing and expired sessions.",
            "Conventional absence APIs such as find and index lookup may use a sentinel clearly when no further distinction belongs in their responsibility.",
            "A discriminated result, specific error, or named status preserves distinctions and is not a sentinel smell.",
            "Multiple sentinel returns alone are insufficient; if the evidence does not show a caller-relevant distinction, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "The same opaque sentinel represents materially different outcomes that require different interpretation, recovery, messaging, or policy",
            remedy: "Return a discriminated result or use distinct errors or statuses for caller-relevant outcomes",
          },
          false: {
            what: "All sentinel paths intentionally represent one named domain outcome, the distinction does not belong in this API, or caller relevance is not established",
          },
        },
      },
      threshold: 0.85,
      severity: "warning",
      message: "This sentinel return collapses caller-relevant outcomes.",
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
          inspect: "Compare the wrapper with its delegated target, forwarding shape, module ownership, imports, exports, and actual callers in the supplied evidence.",
          focus: "Judge whether deleting the wrapper would preserve behavior while requiring callers to know no additional policy, algorithm, constant, or implementation detail.",
          decision_boundary: [
            "A project-owned wrapper that passes its receiver and remaining parameters directly to a project-owned target is strong evidence of an unnecessary middleman, including when the receiver has an interface type.",
            "Calling a general primitive with a callback, nested operation, construction, fixed constant, encoding, or transformation is behavior rather than pass-through delegation.",
            "A domain-owned wrapper around an external package is a useful dependency boundary even when the body is a single call.",
            "Being exported or accepting an interface is not by itself evidence of a useful boundary.",
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
              "An interface implementation or substitutable seam that callers should not bypass",
              "A named immutable list operation implemented with map and a callback",
              "A random-token helper that fixes byte length and encoding",
              "A stable public API over replaceable implementation modules",
              "Validation, authorization, observability, caching, translation, or error policy",
            ],
          },
        },
      },
      threshold: 0.7,
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
    "jev/no-mixed-responsibilities": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this function itself own unrelated responsibilities that would change for different business reasons?",
          inspect: "Use the function, imported collaborator calls, collaborator module ownership, and callers in the supplied repository evidence.",
          focus: "Judge whether the work belongs to one coherent outcome, not how many modules or calls the function uses.",
          decision_boundary: [
            "Work that produces unrelated business outcomes, such as saving a profile while preparing a finance report and cleaning sessions, is strong evidence of mixed responsibilities.",
            "An application service may coordinate inventory, payment, shipping, and persistence as one order-fulfillment responsibility.",
            "A controller or adapter may parse boundary input, invoke one use case, and translate its result without mixing responsibilities.",
            "Logging, metrics, transactions, and cleanup tied to the main operation do not alone create another responsibility.",
            "A broad name or several collaborators is not proof. If the relationship between the operations is unclear, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "The function owns separable work with independent purposes and reasons to change, rather than coordinating one named workflow",
            remedy: "Move each unrelated outcome to its natural owner and keep orchestration only where one use case requires it",
          },
          false: {
            what: "Every operation advances one use case, implements one boundary translation, or supports the main operation with cross-cutting behavior",
          },
        },
      },
      threshold: 0.85,
      severity: "warning",
      message: "This function combines responsibilities with different reasons to change.",
    },
    "jev/no-data-clump": {
      scope: "function",
      question: {
        instructions: {
          question: "Is the repeated parameter group a missing domain value that should travel as one concept?",
          inspect: "Compare the parameter names and types, the responsibilities of every function carrying them, and the observed callers in the supplied repository evidence.",
          focus: "Require one cohesive concept with useful ownership or invariants. Repetition and parameter count alone are not enough.",
          decision_boundary: [
            "Address fields repeatedly passed through quoting, labeling, and validation are strong evidence of a missing Address value.",
            "Operands intrinsic to a mathematical operation, such as a value and its bounds, need not become an object.",
            "Framework-mandated callback or middleware signatures are contracts, not data clumps.",
            "Small public or boundary APIs may intentionally keep conventional scalar arguments for ergonomics.",
            "Generic names such as source, target, and options do not establish a domain concept. If ownership is unclear, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "The same values consistently travel together, represent one named domain concept, and gain clearer ownership or invariants when grouped",
            remedy: "Introduce the domain value and pass it through the affected functions as one concept",
          },
          false: {
            what: "The parameters are independent operands, a required signature, an intentional boundary API, coincidental names, or lack enough evidence for a shared concept",
          },
        },
      },
      threshold: 0.85,
      severity: "warning",
      message: "These parameters repeatedly travel together as an unnamed domain concept.",
    },
    "jev/no-scattered-policy": {
      scope: "function",
      question: {
        instructions: {
          question: "Do the matched branches independently encode one business policy that should have a single owner?",
          inspect: "Compare each condition, outcome, function purpose, and surrounding module in the supplied repository evidence.",
          focus: "Judge shared business meaning and coordinated change risk, not textual or structural similarity by itself.",
          decision_boundary: [
            "The same eligibility decision independently controlling several manifestations of one entitlement is strong evidence of scattered policy.",
            "Matching fields and literals in unrelated domain decisions are coincidental, not a shared policy.",
            "Separate external adapters may each enforce the same transport or authentication protocol at their own boundary.",
            "Calling one shared policy from several modules is centralized use, not scattered policy.",
            "If the evidence does not establish one named policy or a natural owner, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "Several modules restate the same business decision and would need coordinated edits when that decision changes",
            remedy: "Give the decision one domain owner and have each module consume its result",
          },
          false: {
            what: "The matches are unrelated decisions, required boundary checks, uses of one shared policy, or too ambiguous to assign common ownership",
          },
        },
      },
      threshold: 0.85,
      severity: "warning",
      message: "This business policy appears to be encoded independently in multiple modules.",
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
    "jev/no-hidden-runtime-input": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this function hide a material runtime input from callers by reading ambient state inside domain or application behavior?",
          inspect: "Compare the function's parameters and stated role with each extracted environment, process, time, randomness, browser, or global-state read and its real callers.",
          focus: "Judge whether the ambient value changes a domain result, policy decision, or effect while remaining absent from the function's contract.",
          decision_boundary: [
            "Environment flags, current time, randomness, or host state used inside otherwise deterministic domain behavior are strong evidence of a hidden input.",
            "Configuration loaders, composition roots, platform adapters, and explicit clock or ID providers exist to read runtime state and do not hide that responsibility.",
            "A time or random read is not enough by itself when generating that value is an inherent and clearly named responsibility.",
            "If the function's role or the material effect of the runtime value is unclear, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "Callers cannot see or supply a runtime value that materially changes the function's domain behavior",
            remedy: "Read the runtime value at a boundary and pass the resulting dependency or value explicitly",
          },
          false: {
            what: "The runtime read is the declared purpose of a boundary adapter or provider, is caller-controlled, is incidental to an explicit effect, or lacks enough evidence to establish hidden behavior",
          },
        },
      },
      threshold: 0.85,
      severity: "warning",
      message: "This function depends on a runtime input that its contract does not expose.",
    },
    "jev/no-hidden-initialization-order": {
      scope: "function",
      question: {
        instructions: {
          question: "Does using this function correctly require a separate initializer to run first, while that prerequisite is absent from the function's type and ownership API?",
          inspect: "Compare the function's reads of uninitialized module state with the functions that assign that state, their callers, and complete caller-module source.",
          focus: "Judge whether callers can invoke the function in a type-correct but invalid order because initialization is a hidden precondition.",
          decision_boundary: [
            "An application operation that reads a module dependency assigned only by a separate configure or initialize call is strong evidence of hidden initialization order.",
            "A runtime guard or error message may explain the failure but does not by itself make an invalid call order unrepresentable.",
            "Paired lifecycle commands such as start and stop can state their ordering contract clearly, especially when one orchestrator owns the sequence.",
            "A callback-scoped context API can make dynamic extent explicit by placing dependent work inside the initializer's callback.",
            "If framework ownership or actual call order is not clear from the supplied modules, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "The function accepts a call before required shared state exists, and callers must separately know which initializer to invoke first",
            remedy: "Pass the initialized dependency explicitly, return an initialized capability, or place dependent work inside an owning lifecycle object",
          },
          false: {
            what: "The order is explicit in a lifecycle or callback contract, the dependency is caller-supplied, or the evidence does not establish a hidden prerequisite",
          },
        },
      },
      threshold: 0.85,
      severity: "warning",
      message: "This function has an initialization prerequisite that its API does not express.",
    },
    "jev/no-implicit-atomicity": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this function rely on several durable effects succeeding as one domain operation without expressing an atomic boundary or recovery policy?",
          inspect: "Compare the ordered effect candidates with transaction signals, error handling, compensation, function purpose, module context, and callers.",
          focus: "Judge whether a real all-or-nothing domain invariant spans the effects and remains unprotected or undocumented in code.",
          decision_boundary: [
            "A balance transfer, ownership move, or state transition whose writes must agree is strong evidence when no transaction, outbox, idempotency, or compensation policy is visible.",
            "Several effect-like calls alone are never proof of an atomicity requirement; infer the shared invariant from their meaning and data flow.",
            "Telemetry, caching, notification, or audit work may be intentionally independent from the primary write.",
            "An explicit database transaction, unit of work, outbox, or complete compensating path makes the constraint visible even across several operations.",
            "Cross-service work may require a saga rather than a database transaction. Judge whether recovery is expressed, not which mechanism is used.",
            "If the domain invariant or durability of the operations is unclear, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "A partial success would violate a visible domain invariant, yet the function expresses no atomic boundary, idempotency, outbox, or recovery policy",
            remedy: "Encode the unit of work with the appropriate transaction, outbox, idempotency, or compensating workflow",
          },
          false: {
            what: "The effects are independent, atomicity or recovery is explicit, a partial result is acceptable, or the evidence does not establish a shared invariant",
          },
        },
      },
      threshold: 0.85,
      severity: "warning",
      message: "This operation has an all-or-nothing constraint that the code does not express.",
    },
    "jev/no-complexity-displacement": {
      scope: "change",
      question: {
        instructions: {
          question: "Does this change make one location look simpler mainly by pushing equivalent or greater complexity into callers, wiring, interfaces, or adjacent files?",
          inspect: "Compare the representative before/after files, declarations, and caller changes in the supplied evidence. Use the exact coverage and truncation metadata to identify what was not shown.",
          focus: "Judge the repository-wide cognitive burden after the change, not local line count or whether code moved. Abstain when omitted evidence could materially change that judgment.",
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
    "jev/no-transport-coupled-domain": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this function make a domain or application decision depend directly on a transport protocol representation?",
          inspect: "Use the function's transport parameters and operations, module role, imports, and repository callers in the supplied evidence.",
          focus: "Judge whether business meaning or policy is coupled to HTTP, RPC, messaging, or framework request and response details that a boundary adapter should translate.",
          decision_boundary: [
            "A domain decision that reads headers, route parameters, status codes, or framework request state is strong evidence of transport coupling.",
            "A controller, route, resolver, webhook receiver, or presenter may legitimately translate transport input and output around a domain operation.",
            "Protocol-mandated authentication, signature verification, streaming, and response negotiation belong at the transport boundary.",
            "A transport type in a thin function is not enough when the evidence does not show domain policy or application meaning inside it.",
            "If the function's ownership or the location of the decision is unclear, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "Domain or application behavior directly consumes or produces transport-specific state instead of receiving or returning domain-shaped values",
            remedy: "Translate protocol data in an adapter and keep the decision expressed in domain terms",
          },
          false: {
            what: "The function is a transport adapter, implements a protocol obligation, contains no domain decision, or lacks enough ownership evidence",
          },
        },
      },
      threshold: 0.85,
      severity: "warning",
      message: "Domain behavior is coupled to transport details.",
    },
    "jev/no-persistence-model-leak": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this function expose a persistence-owned record shape to code that should depend on domain or application meaning instead?",
          inspect: "Compare the persistence imports, return type and expressions, related persistence modules, and actual consumer source in the supplied evidence.",
          focus: "Judge ownership of the returned representation and whether consumers now depend on storage columns, ORM lifecycle, or schema details.",
          decision_boundary: [
            "Returning an ORM-generated record from an application service to domain consumers that read storage-shaped fields is strong evidence of a leak.",
            "A repository may use an ORM internally and return a reconstructed domain entity without leaking persistence representation.",
            "A deliberately owned read model or projection is not a leak merely because a database supplies its data.",
            "Migration, backup, archival, and persistence administration code may intentionally preserve raw storage records.",
            "A repository name, database call, or type named Record is not enough when representation ownership is unclear; answer no.",
          ],
        },
        criteria: {
          true: {
            what: "A persistence-layer model crosses its ownership boundary and downstream code relies on its storage-specific shape",
            remedy: "Map the record to a domain entity or an explicitly owned application read model before returning it",
          },
          false: {
            what: "The function maps to a domain-owned type, returns an intentional projection, supports persistence tooling, or lacks proof that the shape is persistence-owned",
          },
        },
      },
      threshold: 0.85,
      severity: "warning",
      message: "A persistence-owned model leaks across its boundary.",
    },
    "jev/no-interchangeable-domain-primitives": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this function make distinct, non-interchangeable domain values unsafe by accepting them as the same bare primitive type?",
          inspect: "Use the grouped parameters, function behavior, actual argument lists, and consumer source in the supplied evidence.",
          focus: "Judge whether the signature erases domain identity or invariants strongly enough that validly typed arguments can be swapped or misused in a consequential way.",
          decision_boundary: [
            "Source and destination account identifiers in one transfer signature are strong evidence when the body gives them opposing domain roles.",
            "Primitive values are not a smell by default; require a meaningful domain boundary and evidence of distinct identities or rules.",
            "Formatting inputs, names, coordinates, ranges, and similarly conventional data pairs usually remain clearest as primitives.",
            "Wire protocols, cryptographic APIs, serialization, and framework callbacks may require primitive representations at their adapter boundary.",
            "Different parameter names or an Id suffix alone do not prove harmful interchangeability; if the domain distinction is not demonstrated, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "The same primitive type hides materially different domain roles or invariants and permits a consequential argument substitution",
            remedy: "Represent each role with a distinct domain-owned type or accept a command whose fields preserve their identities",
          },
          false: {
            what: "The values are ordinary data, constrained by an external boundary, safely conventional, or not shown to carry distinct domain meaning",
          },
        },
      },
      threshold: 0.85,
      severity: "warning",
      message: "Bare primitives erase distinct domain meanings in this API.",
    },
    "jev/no-domain-policy-in-adapter": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this adapter make a business policy decision that belongs in the domain or application layer?",
          inspect: "Compare the extracted decisions with the adapter path, imports, related modules, function role, and repository consumers in the supplied evidence.",
          focus: "Judge who owns the decision. Distinguish choosing a business outcome from translating an outcome or satisfying a provider, protocol, or storage constraint.",
          decision_boundary: [
            "Declining a payment in a provider gateway based on customer age and charge amount is strong evidence that business policy lives in the adapter.",
            "Mapping an already-decided domain result to an HTTP status, provider field, persistence record, or message shape is adapter translation, not domain policy.",
            "Retry rules, provider limits, wire compatibility, transaction handling, and database error translation may belong to the adapter.",
            "A branch in an adapter is never sufficient by itself; identify the owner of the condition and outcome.",
            "If the branch could be either an upstream decision mapping or a new business choice and the evidence does not resolve it, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "The adapter originates a business eligibility, pricing, routing, entitlement, or lifecycle decision rather than translating one",
            remedy: "Move the policy to a domain or application-owned decision and pass its result into the adapter",
          },
          false: {
            what: "The branch translates an existing decision, handles a technical constraint, or lacks enough evidence to assign policy ownership",
          },
        },
      },
      threshold: 0.85,
      severity: "warning",
      message: "This adapter owns domain policy.",
    },
    "jev/no-swallowed-error": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this function absorb an operational failure while leaving its caller-facing outcome looking successful or indistinguishable from an ordinary no-result?",
          inspect: "Use each extracted try block, catch outcome, continuation after the catch, imported dependency contract, and observed callers in the supplied evidence.",
          focus: "Judge whether the function preserves failure meaning across its boundary, not whether it uses catch syntax or writes a log.",
          decision_boundary: [
            "A catch that logs and then continues into success state, or returns the same sentinel used for an ordinary absence, is strong evidence of a swallowed error.",
            "Logging alone does not preserve the failure for code that must decide what happened.",
            "Rethrowing, returning an explicit failure result, or otherwise making failure distinguishable preserves integrity.",
            "A documented best-effort side effect may fail without invalidating an already completed primary operation.",
            "When the primary operation completes before labeled telemetry or analytics, returning that primary success does not hide a caller-relevant failure.",
            "A credible fallback for an expected unavailable dependency is not a swallowed error; if the contract or consequence is unclear, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "The handler prevents a relevant failure from reaching the caller and the remaining return or state can be mistaken for success or normal absence",
            remedy: "Propagate the error or represent the failure explicitly in the function's contract",
          },
          false: {
            what: "Failure remains explicit, the failed work is genuinely best effort, a fallback preserves the contract, or the evidence cannot establish false success",
          },
        },
      },
      threshold: 0.85,
      severity: "warning",
      message: "This handler hides a failure from its caller.",
    },
    "jev/no-lossy-error-translation": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this catch replace a failure with an error that erases distinctions or diagnostic cause needed by the receiving layer?",
          inspect: "Compare each caught operation and thrown replacement with the imported error contracts and caller handling in the supplied evidence.",
          focus: "Judge information loss across the boundary, not the mere use of a new error type.",
          decision_boundary: [
            "Collapsing actionable failure categories into one generic message without retaining cause or equivalent details is strong evidence of lossy translation.",
            "A direct rethrow, a replacement with the original cause, or a domain error that retains the needed category and context preserves integrity.",
            "A deliberate trust-boundary translation may hide sensitive internals or collapse authentication failures to enforce security policy.",
            "A stable public error contract can be useful even when it omits implementation details.",
            "If the caller's information needs or the boundary policy are unclear, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "The replacement discards failure identity, cause, or actionable context that shown callers or the function contract need",
            remedy: "Preserve the original cause and retain the failure distinctions required at the boundary",
          },
          false: {
            what: "The translation preserves needed meaning, intentionally sanitizes a trust boundary, directly rethrows, or lacks enough evidence of harmful loss",
          },
        },
      },
      threshold: 0.85,
      severity: "warning",
      message: "This error translation discards failure information needed by its caller.",
    },
    "jev/no-unsafe-retry": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this retry repeat an operation without enough policy to make another attempt safe for the shown failure and effect?",
          inspect: "Use the extracted loop or retry helper, catch guards, stop conditions, delays, idempotency signals, dependency contracts, and callers in the supplied evidence.",
          focus: "Judge retry safety as a whole; do not flag a retry merely because one conventional feature is absent.",
          decision_boundary: [
            "Repeating a non-idempotent effect for every exception without an idempotency mechanism or failure classification is strong evidence of an unsafe retry.",
            "A credible policy identifies retryable failures, bounds attempts, controls timing when needed, and prevents duplicate side effects.",
            "Attempt count, delay length, or catch count alone never establishes safety or danger.",
            "A small immediate retry of an idempotent local read can be safe without backoff or elaborate classification.",
            "A retry helper may own policy outside this function; if its contract is unavailable or the operation's effect is unclear, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "The shown operation can be repeated after the wrong failures, indefinitely or too aggressively, or with duplicate side effects and no compensating safety mechanism",
            remedy: "Define retry eligibility, termination, timing, and idempotency at one explicit policy boundary",
          },
          false: {
            what: "The retry is safe for the operation, delegates to a credible policy, is a bounded idempotent exception, or lacks enough evidence to judge",
          },
        },
      },
      threshold: 0.85,
      severity: "warning",
      message: "This retry does not show a safe policy for repeating the operation.",
    },
    "jev/no-hidden-partial-failure": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this batch allow some items to fail and then present an outcome that hides those failed or omitted items from a caller that relies on completion?",
          inspect: "Compare the extracted batch mechanism, settled-status handling or per-item catches, function outcome, dependency role, and observed caller behavior in the supplied evidence.",
          focus: "Judge whether partial failure remains visible at the contract boundary, not whether the implementation uses allSettled or catches per item.",
          decision_boundary: [
            "Returning only fulfilled values while a caller marks the batch complete is strong evidence of hidden partial failure.",
            "Returning or reporting both successes and failures preserves the batch outcome even when processing continues.",
            "Logging failed items does not preserve failure for a caller that must decide whether the batch completed.",
            "Optional enrichment may safely fall back while retaining every primary item; such a failure does not make the primary batch partial.",
            "Refreshes of derived caches, indexes, hints, or analytics are credible best-effort work when failure leaves the primary records valid.",
            "Catch-and-continue batch processing may be intentionally best effort; if the contract and caller consequence are unclear, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "The function can omit or fail work while its return value or subsequent caller behavior represents the batch as complete or otherwise conceals which items failed",
            remedy: "Expose failed items or an explicit partial outcome and require callers to handle it",
          },
          false: {
            what: "Failures remain explicit, every primary item retains a valid fallback, the work is credibly best effort, or the evidence cannot establish a misleading completion signal",
          },
        },
      },
      threshold: 0.85,
      severity: "warning",
      message: "This batch hides partial failure from its caller.",
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

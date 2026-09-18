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
      message: "This batch hides partial failure from its caller.",
    },
    "jev/no-duplicated-logic": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this function reimplement logic that already exists elsewhere in the repository?",
          inspect: "Compare the normalized statement fingerprint with each matching function excerpt, the shared literals and member names, shared imports, common callers, and repository callers in the supplied evidence.",
          focus: "Judge whether the candidate repeats domain behavior already owned elsewhere, rather than sharing only generic scaffolding.",
          decision_boundary: [
            "A body that matches another function statement-for-statement, including the same literals and domain member names, is strong evidence of reimplemented logic.",
            "Shared try/catch structure, map/filter chains, or other generic scaffolding with no shared literals or domain tokens is weak evidence on its own.",
            "A single shared literal or member name without structural similarity is insufficient; look for the fingerprint and excerpts to agree.",
            "Matches in test fixtures, generated code, or intentionally parallel implementations with distinct ownership are not duplication that needs one home.",
            "If the evidence does not establish a concrete matching implementation with shared domain behavior, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "The function repeats an algorithm or behavior that already exists in another repository function, sharing structure plus domain tokens",
            remedy: "Extract the shared behavior into one named unit and reuse it from both call sites",
          },
          false: {
            what: "Any similarity is generic scaffolding, the matches have distinct behavior, or no concrete matching implementation is established",
          },
        },
      },
      message: "This function reimplements logic that already exists elsewhere in the repository.",
    },
    "jev/no-type-code-dispatch": {
      scope: "function",
      question: {
        instructions: {
          question: "Do this function's branches dispatch on a domain type code whose variants should own the behavior instead?",
          inspect: "Compare the switch discriminant or compared base expression with each arm's variant-specific behavior, the declared union type, other handlers of the same member across the repository, and repository callers in the supplied evidence.",
          focus: "Judge whether the discriminant is a typed domain code with variant-specific arms, rather than transient local branching.",
          decision_boundary: [
            "A multi-arm switch on a member such as node.type, where each arm builds variant behavior and other modules switch on the same member, is strong evidence the variants should own the behavior.",
            "Two arms on a transient local string with no declared union and no other handlers in the repository is weak evidence on its own.",
            "Branching on booleans, null checks, or error shapes without a domain type code does not establish this smell.",
            "A declared union type alone is insufficient; the arms must carry variant-specific behavior that polymorphism could own.",
            "If the discriminant is not a domain type code or the arms share one behavior, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "The function switches over a domain type code with variant-specific arms while the variant types could own the behavior",
            remedy: "Move each arm's behavior onto its variant type behind a shared operation",
          },
          false: {
            what: "The branching is local, transient, or uniform across arms, or the discriminant is not a domain type code",
          },
        },
      },
      message: "This function dispatches on a domain type code that its variants should own.",
    },
    "jev/no-mode-flag-parameter": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this function's boolean parameter select between behaviors that callers should invoke as separate operations?",
          inspect: "Compare the flag parameter declaration with each branch it controls, the overlap between the selected paths, whether the parameter is positional or part of an options bag, and the literal true/false call sites in the supplied evidence.",
          focus: "Judge whether the flag creates two operations behind one signature that every caller must understand by reading the implementation.",
          decision_boundary: [
            "A positional boolean with callers passing literal true and false to select disjoint behavior paths is strong evidence of a mode flag.",
            "A boolean consumed once in a shared guard with otherwise identical behavior is weak evidence on its own.",
            "An options-bag field or configuration value that tunes one behavior is not a mode flag.",
            "A single if on the flag with no alternate path is insufficient; the parameter must select between behaviors.",
            "If the evidence does not show callers selecting between distinct behaviors through the parameter, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "A boolean parameter selects between distinct behaviors that callers pass as literals, forcing each caller to know the implementation",
            remedy: "Split the function into separately named operations or replace the flag with an explicit strategy",
          },
          false: {
            what: "The parameter tunes one behavior, guards shared logic, lives in an options bag, or lacks evidence of behavior selection",
          },
        },
      },
      message: "This boolean parameter selects between behaviors that should be separate operations.",
    },
    "jev/no-message-chain": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this call chain navigate intermediate objects whose internals the calling function should not need to know?",
          inspect: "Compare each chain's navigation depth and whether intermediate links take arguments, repeated chain prefixes in the same body, the imported types of the intermediate links, any direct accessor the owner already exposes, and repository callers in the supplied evidence.",
          focus: "Judge whether the caller depends on the shape of intermediaries it merely passes through.",
          decision_boundary: [
            "Reaching through several imported types with argument-free navigation links, such as order.customer().address().zip(), is strong evidence of a message chain.",
            "A two-link fluent builder chain where the intermediate type is the same module's own builder is weak evidence on its own.",
            "Chains that compute at each link with meaningful arguments are collaboration, not navigation.",
            "A single chain with no repetition and no evidence about intermediate ownership is insufficient.",
            "If the intermediaries are the caller's own objects or the chain stays within one abstraction, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "The function navigates through intermediate objects it does not own, coupling itself to each intermediary's shape",
            remedy: "Add a direct operation on the nearest collaborator that hides the navigation",
          },
          false: {
            what: "The chain is a fluent builder, single-level collaboration, or stays within objects the caller owns",
          },
        },
      },
      message: "This call chain navigates intermediate objects it should not need to know.",
    },
    "jev/no-mixed-abstraction-levels": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this function mix raw implementation mechanics with domain-level operations instead of staying at one level of abstraction?",
          inspect: "Compare the extracted mechanical spans with the domain-level calls, their ratio and interleaving, the module imports, any same-module helper that already wraps the mechanics, and repository callers in the supplied evidence.",
          focus: "Judge whether one body interleaves bit-level or index-level plumbing with domain decisions, rather than isolating the mechanics.",
          decision_boundary: [
            "Byte-offset math, counter loops, or buffer manipulation interleaved line-by-line with domain calls such as chargeCustomer() is strong evidence of mixed levels.",
            "One contained parsing loop feeding a single domain call, with the mechanics isolated in a block, is weak evidence on its own.",
            "Mechanics alone or domain calls alone never establish mixing; both classes must be present in one body.",
            "A same-module helper that already wraps the mechanical part weakens the case when this function stays at the domain level.",
            "If the evidence does not show both raw mechanics and domain operations interleaved in one body, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "The function interleaves low-level implementation mechanics with domain-level operations in one body",
            remedy: "Extract the mechanical plumbing into a named helper so the function reads at one level",
          },
          false: {
            what: "The body stays at one level, isolates its mechanics in a block or helper, or lacks evidence of both classes",
          },
        },
      },
      message: "This function mixes raw mechanics with domain-level operations.",
    },

    "jev/no-unvalidated-boundary-shape": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this function consume a cross-boundary value assuming a shape nothing in the function verifies?",
          inspect: "Compare each boundary read and its origin with the validators present, the validation library import, the related producer modules, and the repository callers in the supplied evidence.",
          focus: "Judge whether the function reads properties or destructures values that cross a network, parser, or plugin boundary without establishing that the expected shape holds.",
          decision_boundary: [
            "Reading data properties off a safeParse-style wrapper, a raw fetch Response, or an unchecked payload field without narrowing is strong evidence of an unverified shape assumption.",
            "A schema parse, success check, type narrowing, key check, or instance check between the boundary and the use establishes the shape and answers the question negatively.",
            "Optional chaining and fallback defaults guard absence but do not establish that sibling fields or nested shapes exist.",
            "Reads of ordinary domain parameters with no boundary origin in the evidence are insufficient; answer no when no cross-boundary source is established.",
          ],
        },
        criteria: {
          true: {
            what: "The function reads or destructures a boundary-crossing value while no validator in the evidence establishes the assumed shape",
            remedy: "Validate the payload with a shared schema or narrow its shape before reading caller-relevant fields",
          },
          false: {
            what: "The reads stay within verified shapes, a validator covers the access, or the evidence does not establish a cross-boundary source",
          },
        },
      },
      message: "This function assumes a boundary value's shape without verifying it.",
    },
    "jev/no-stale-binding-use": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this function read a pre-update binding after the updated value was already derived, silently discarding the fresh value?",
          inspect: "Compare each stale use with its discarded derivation, the full derived-binding list, and the repository callers in the supplied evidence.",
          focus: "Judge whether the function derives a fresher value and then returns or passes the older binding, so callers observe an outcome that never advances.",
          decision_boundary: [
            "Building an updated copy and then returning the original container, or refreshing credentials and then connecting with the pre-refresh values, is strong evidence of a discarded update.",
            "Returning the original intentionally after establishing the derived copy carries no semantic difference answers the question negatively.",
            "A derived binding that is used later in the function is propagated, not discarded.",
            "If the evidence does not show the use occurring after the derivation, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "A return or call argument reads the older binding while a derived fresher binding in the same function goes unused",
            remedy: "Return or pass the derived value, or remove the derivation if the original is genuinely intended",
          },
          false: {
            what: "The derived value is propagated, the original is intentionally equivalent, or ordering does not show a discarded update",
          },
        },
      },
      message: "This function discards a derived update and uses the stale binding.",
    },
    "jev/no-pre-gate-side-effect": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this function perform an externally visible effect before the check that can reject the operation, leaving residue observable after rejection?",
          inspect: "Compare the position of each effect with each rejecting gate, the compensating cleanup present, and the repository callers in the supplied evidence.",
          focus: "Judge ordering: a legitimate write that lands before a limit, flag, or authorization check leaves residue whenever the check rejects.",
          decision_boundary: [
            "A cache, analytics, database, or network write textually preceding a gate with an early exit is strong evidence of residue on the rejection path.",
            "Writes placed after every rejecting gate, and writes before purely descriptive checks that cannot reject, answer the question negatively.",
            "Compensating cleanup on the rejection path weakens the residue concern but does not erase the ordering smell by itself.",
            "Local-only mutations and logging that cannot leak across requests are insufficient; answer no when no externally visible effect precedes a gate.",
          ],
        },
        criteria: {
          true: {
            what: "An externally visible effect lands before a rejecting gate with no cleanup that fully removes the residue",
            remedy: "Move the gate before the effect or compensate the rejection path so rejected operations leave no trace",
          },
          false: {
            what: "Effects follow every gate, the checks cannot reject, cleanup removes the residue, or no pre-gate effect is established",
          },
        },
      },
      message: "This function writes a visible effect before the check that can reject it.",
    },
    "jev/no-inverted-authorization-predicate": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this authorization predicate admit or deny the wrong set of subjects because of its operator or scope selection?",
          inspect: "Compare each predicate with its sibling predicates in the same module, the permission framework import, and the enforcement callers in the supplied evidence.",
          focus: "Judge whether the operator or scope set matches the evident intent: either-or roles joined by and, fallback scopes broader than requested, or identity comparisons whose branches invert the outcome.",
          decision_boundary: [
            "Joining admin-or-owner style roles with && while sibling checks for the same roles use || is strong evidence of an inverted predicate.",
            "A manage check that falls back to granting on a view scope admits subjects the policy never intended.",
            "Equality direction on identity or token matches combined with swapped allow and deny branches inverts who passes.",
            "Genuinely conjunctive requirements, such as owning the resource and belonging to the team, with both conditions intended, answer the question negatively.",
          ],
        },
        criteria: {
          true: {
            what: "The predicate's operator or scope set admits subjects the policy should deny or denies subjects it should admit",
            remedy: "Align the operator and scope set with the intended policy and mirror the sibling predicates that already express it",
          },
          false: {
            what: "The operator and scopes match a conjunctive or correctly scoped policy, or the evidence does not establish an authorization intent",
          },
        },
      },
      message: "This authorization predicate admits or denies the wrong subjects.",
    },
    "jev/no-hardcoded-config-shadow": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this literal duplicate a value the repository already owns as configuration, so the two can diverge silently?",
          inspect: "Compare each literal with the config sources found in the repository, the sibling modules reading the same concept from config, and the repository callers in the supplied evidence.",
          focus: "Judge whether the literal shadows an existing source of truth: a locale, URL, size, or limit the repository configures elsewhere.",
          decision_boundary: [
            "A locale, endpoint, or per-type limit literal alongside a config source or sibling reads for the same concept is strong evidence of a shadow.",
            "A literal matching a config default where the module genuinely has no access to the config layer and the value is documented as a fallback answers the question negatively.",
            "One-off literals with no corresponding config source anywhere in the repository are insufficient; answer no when the inventory shows no source of truth.",
            "Readable, well-named literals can still shadow config; naming clarity alone does not settle the question.",
          ],
        },
        criteria: {
          true: {
            what: "A literal restates a configured value owned elsewhere, so changing config leaves this call site behind",
            remedy: "Read the value from the shared config source or locale hook instead of restating it",
          },
          false: {
            what: "No config source owns the concept, the module cannot reach the config layer, or the literal is a documented fallback",
          },
        },
      },
      message: "This literal shadows a value the repository configures elsewhere.",
    },
    "jev/no-sibling-identifier-swap": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this expression use a near-identical sibling identifier where the surrounding pattern indicates the other one was meant?",
          inspect: "Compare each finding with the full scope-binding use counts and the repository callers in the supplied evidence.",
          focus: "Judge selection among live bindings: the same identifier validated twice while a sibling goes unused, one side of a start and end pair used alone, or an expression compared against itself.",
          decision_boundary: [
            "Repeated identical arguments to distinct parameter positions, or the same validation applied twice while a required sibling is never referenced, is strong evidence of a swap.",
            "Using one side of a paired binding while its counterpart sits unused deserves suspicion only when the surrounding pattern needs both sides.",
            "Intentional repeated use, such as a re-read or a deliberate self-check with the sibling used elsewhere, answers the question negatively.",
            "A single use of one binding with no unused sibling in scope is insufficient; answer no when every sibling is accounted for.",
          ],
        },
        criteria: {
          true: {
            what: "The expression selects the wrong sibling among live bindings, leaving the intended identifier unused or comparing a value with itself",
            remedy: "Use the intended sibling identifier so each binding the pattern requires is actually referenced",
          },
          false: {
            what: "Each sibling is used as intended, repetition is deliberate, or no unused sibling suggests a mistaken selection",
          },
        },
      },
      message: "This expression uses the wrong sibling identifier.",

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
      message: "This behavior appears to belong with the data it inspects.",
    },
    "jev/no-foreign-mutation": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this change mutate objects it does not own — globals, prototypes, or another module's state — so its effects reach code beyond its visible scope?",
          inspect: "Compare each extracted mutation, its target ownership, the imported targets, and the repository callers in the supplied evidence.",
          focus: "Judge whether the mutation reaches state no caller passed in and no caller can anticipate from the signature.",
          decision_boundary: [
            "Assignment to a prototype, globalThis, or a member of an imported binding is strong evidence of foreign mutation.",
            "Mutation of the function's own parameters is caller-visible input mutation, not foreign mutation.",
            "Mutation of locally declared state is not foreign mutation even when the state outlives the call.",
            "Test-only global stubbing inside setup hooks may be an intentional seam rather than a hidden effect.",
            "If the ownership of the mutated root is unclear, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "The function changes globals, prototypes, or another module's state that callers did not supply and cannot infer from the contract",
            remedy: "Return the change explicitly, accept the target as a parameter, or confine the effect to owned state",
          },
          false: {
            what: "The function mutates only its inputs, locals, or clearly owned state, or the evidence does not establish foreign ownership",
          },
        },
      },
      message: "This function mutates state it does not own.",
    },
    "jev/no-temporal-call-coupling": {
      scope: "function",
      question: {
        instructions: {
          question: "Must callers invoke a separate setup operation before this one, in an order the code does not enforce?",
          inspect: "Compare the shared state, the writer operations that establish it, the guard evidence, the callers of each side, and the reader-alone call sites in the supplied evidence.",
          focus: "Judge whether a caller can trigger the wrong sequence without any compile-time or runtime complaint.",
          decision_boundary: [
            "A reader of module state written only by a separately invoked setup operation is strong evidence of temporal coupling.",
            "A reader that throws a clear not-initialized error still requires the handshake but makes the failure explicit rather than silent.",
            "Paired lifecycle commands owned by one orchestrator may state their ordering contract clearly.",
            "Passing the initialized dependency as a parameter removes the ordering handshake entirely.",
            "If the writer always runs before the reader at every observed call site, or the ordering evidence is unclear, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "The operation assumes state established by another operation callers must discover and sequence themselves",
            remedy: "Pass the initialized dependency explicitly or return an initialized capability callers cannot misuse",
          },
          false: {
            what: "The order is enforced by types, guards, or ownership, or the evidence does not establish an unenforced sequence",
          },
        },
      },
      message: "This operation assumes a setup call the code does not enforce.",
    },
    "jev/no-shotgun-change": {
      scope: "change",
      question: {
        instructions: {
          question: "Did this change have to make parallel edits across many modules for a single concept, suggesting the concept has no single home?",
          inspect: "Compare the per-file hunks, the identifiers edited in parallel across files, the shared dependencies, and the coverage metadata in the supplied evidence.",
          focus: "Judge whether the diff shows one concept scattered across owners rather than distinct per-file responsibilities.",
          decision_boundary: [
            "Near-identical hunks touching the same identifier or member path in several files with no shared owning module touched is strong evidence of shotgun change.",
            "A rename with its independent call-site updates touches many files but follows one declaration rather than scattering a concept.",
            "Structurally distinct per-file hunks serving different responsibilities are a broad change, not a scattered concept.",
            "If the coverage metadata shows omitted files needed for the judgment, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "One concept required coordinated parallel edits across modules without a single owning home",
            remedy: "Move the behavior to one owner so future changes land in a single place",
          },
          false: {
            what: "The files changed for distinct reasons, followed one declaration, or lack enough evidence of a scattered concept",
          },
        },
      },
      message: "This change scatters one concept across many modules.",
    },
    "jev/no-undocumented-contract": {
      scope: "function",
      question: {
        instructions: {
          question: "Is this exported operation's contract — what it expects, guarantees, and what counts as misuse — stated nowhere a caller can find it?",
          inspect: "Compare the parameter shape and types, return-type presence, documented status, thrown errors, cross-module callers, and misuse-shaped call sites in the supplied evidence.",
          focus: "Judge whether a caller in another module can use the operation correctly from its contract alone. JSDoc presence is noted in the evidence; score only whether the contract is statable from names and types alone.",
          decision_boundary: [
            "An exported operation with several primitive parameters, literal-shaped call sites, or undocumented thrown errors is strong evidence of an unstated contract.",
            "A self-describing export such as isValidEmail with precise types may state its contract through names alone.",
            "A module whose sibling exports are documented while this one is not departs from its local norm.",
            "Internal helpers without cross-module callers need less contract than widely used boundaries.",
            "If names and types already make expectations, guarantees, and misuse clear, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "Cross-module callers must guess at expectations, guarantees, or misuse that no contract states",
            remedy: "Document the expected inputs, guarantees, and misuse conditions at the export boundary",
          },
          false: {
            what: "Names and types already carry the contract, the operation is internal, or the evidence does not establish a gap callers cannot bridge",
          },
        },
      },
      message: "This exported operation states its contract nowhere callers can find it.",
    },
    "jev/no-unbounded-wait": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this network or I/O call wait without a deadline, timeout, or cancellation bound that keeps a hung remote from blocking forever?",
          inspect: "Use the extracted wait calls, their timeout and signal options, module-level abort control, any one-hop wrapper policy, dependency roles, and callers in the supplied evidence.",
          focus: "Judge whether this attempt is bounded against a hung remote, not whether retries or fallbacks exist elsewhere.",
          decision_boundary: [
            "A bare fetch or client call with no signal, timeout, or abort control anywhere in the module is strong evidence of an unbounded wait.",
            "A wrapper that sets a default timeout one hop away bounds the wait even when the call site shows no explicit option.",
            "An explicit signal, timeout option, or AbortSignal timeout attached to the call establishes a bound.",
            "Retry policy, error handling, or response validation alone never bounds the wait itself.",
            "If the evidence cannot establish that the call reaches a network, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "The shown call can block indefinitely on a hung remote because no deadline, timeout, or cancellation is attached at the call, in scope, or one hop away",
            remedy: "Attach an explicit timeout, deadline, or cancellation signal to every remote wait",
          },
          false: {
            what: "The wait is bounded by an explicit option, a scope-level abort control, a wrapper default, or the evidence cannot establish a network wait",
          },
        },
      },
      message: "This remote call waits without a visible deadline, timeout, or cancellation.",
    },
    "jev/no-detached-async-work": {
      scope: "function",
      question: {
        instructions: {
          question: "Is this asynchronous work detached from completion tracking and error handling, so its failure would surface as an unhandled rejection or silent loss?",
          inspect: "Use the extracted detached calls, each callee's async certainty, how the work is stored or returned, the module rejection guard, dependency roles, and callers in the supplied evidence.",
          focus: "Judge whether anyone observes this work's completion or failure, not whether the callee itself handles errors internally.",
          decision_boundary: [
            "A bare-statement call to a confirmed async function in a non-async handler with no catch tail and no module rejection guard is strong evidence of detached work.",
            "Awaiting, returning, or attaching a catch or then handler keeps the work tracked even when the handler is brief.",
            "Storing the promise without awaiting or returning it leaves completion unobserved even when the value is named.",
            "A module-level unhandledRejection guard or a tracked background set makes fire-and-forget intentional rather than lost.",
            "Calls whose promise return cannot be established from the evidence are only possible, never proof of detachment.",
          ],
        },
        criteria: {
          true: {
            what: "The shown asynchronous work runs without await, return, handler tail, tracked storage, or a guard that would observe its failure",
            remedy: "Await, return, or explicitly track the promise and give its failure an observer",
          },
          false: {
            what: "Completion or failure stays observable through await, return, handlers, tracked storage, a rejection guard, or the evidence cannot establish async work",
          },
        },
      },
      message: "This asynchronous work runs without completion tracking or error handling.",
    },
    "jev/no-shared-mutable-module-state": {
      scope: "abstraction",
      question: {
        instructions: {
          question: "Does this module couple its functions through hidden shared mutable data that callers cannot see?",
          inspect: "Use the extracted shared bindings, each writer and reader function, any reset or inspect export, the importing modules, and observed caller behavior in the supplied evidence.",
          focus: "Judge whether independent-looking exports communicate through module state, not whether module state exists at all.",
          decision_boundary: [
            "One binding assigned in two or more distinct exports, with importers calling both sides, is strong evidence of hidden coupling.",
            "State initialized once at load and only read thereafter is configuration, not shared mutable coupling.",
            "An export that resets or inspects the state makes the coupling visible; weigh whether the seam and observed caller discipline contain the ordering and re-entrancy risk.",
            "A writer that only runs as one-time setup narrows but does not remove the sharing; judge how much runtime behavior still depends on hidden order.",
            "A binding written in only one function is local ownership even when other functions read it.",
            "If the evidence does not establish mutation from multiple functions, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "The module's exports coordinate through a module-level mutable binding, so call order and re-entrancy change behavior invisibly to callers",
            remedy: "Pass the shared data explicitly, scope it to one owner, or make the coordination part of the exported contract",
          },
          false: {
            what: "The state is load-time configuration, singly owned, exposed through an explicit contract, or not proven to be shared across functions",
          },
        },
      },
      message: "This module couples its functions through hidden shared mutable state.",
    },
    "jev/no-type-checker-escape": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this type-system escape hide a wrong-assumption failure that would otherwise be caught at compile time?",
          inspect: "Use each extracted escape, its asserted type, the value's source, downstream calls and member access, nearby narrowing guards, validator imports, bare any notes, and callers in the supplied evidence.",
          focus: "Judge whether the escape lets an unchecked assumption reach real use, not whether escapes are stylistically undesirable.",
          decision_boundary: [
            "An assertion over a runtime boundary value that is dereferenced or passed on with no validator or guard in the module is strong evidence of a hidden wrong-assumption failure.",
            "An assertion directly after a matching typeof, in, or instanceof check restates what the guard proved and hides little.",
            "A validator import between the boundary and the use replaces the escape with a checked contract.",
            "Bare any annotations alone are a deterministic lint matter noted in evidence; they never by themselves establish a hidden failure.",
            "Double assertions through any or unknown, non-null assertions on lookups, and suppression comments each widen the unchecked gap.",
            "If the escaped value never reaches a use that assumes its shape, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "The escape lets an unchecked value reach dereferences, typed parameters, or downstream calls where a wrong assumption fails at runtime instead of compile time",
            remedy: "Narrow with a guard or validator at the boundary and keep the escape as close to the check as possible",
          },
          false: {
            what: "A guard or validator covers the assumption, the escape restates checked knowledge, or the value never reaches a shape-assuming use",
          },
        },
      },
      message: "This type-system escape hides an assumption the compiler can no longer check.",
    },
    "jev/no-unawaited-iteration-work": {
      scope: "function",
      question: {
        instructions: {
          question: "Do the promises produced by this iteration's callbacks escape the surrounding flow, so per-item failures avoid the visible error handling?",
          inspect: "Compare each extracted iteration call, its callback async-ness, the awaited and Promise.all signals, the enclosing try/catch regions, and the repository callers in the supplied evidence.",
          focus: "Judge whether callback rejections can settle into the surrounding flow, not whether individual callbacks use await internally.",
          decision_boundary: [
            "A forEach or each loop with an async callback inside a try/catch is strong evidence of escaping work, because the iteration primitive discards every callback promise.",
            "An awaited Promise.all over a mapped collection shows the per-item promises settle into the surrounding flow.",
            "A synchronous callback with no async work performs no detached promises even when it uses an iteration primitive.",
            "SetTimeout or setInterval wrappers around async work escape unless their handles are tracked and settled.",
            "If no async callback or iteration primitive is shown, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "Callback promises never settle into the surrounding flow, so per-item failures escape the visible error handling",
            remedy: "Await the per-item work with Promise.all over a mapped collection or a for...of loop",
          },
          false: {
            what: "The collection settles through an explicit await, the callbacks are synchronous, or the evidence does not show escaping async work",
          },
        },
      },
      message: "Per-item async work in this iteration escapes the surrounding error handling.",
    },
    "jev/no-asymmetric-normalization": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this comparison normalize one side while leaving the other raw, so equivalent inputs can compare unequal or blocked inputs can pass?",
          inspect: "Compare each extracted comparison, which side carries the normalizer, the normalizer used, and the repository callers supplying the raw operand in the supplied evidence.",
          focus: "Judge the symmetry of the single comparison site, not whether the involved types are otherwise well modeled.",
          decision_boundary: [
            "A normalized allow-list or block-list compared against a raw request input is strong evidence of a bypass or mismatch.",
            "Normalizing both sides, including one redundant normalization of an already-normalized constant, is symmetric comparison rather than asymmetry.",
            "A case-insensitive regular expression flag can normalize the pattern side when the input side is intentionally raw.",
            "One-sided formatting for display purposes that never gates a decision is not a comparison smell.",
            "If neither side normalizes or the comparison does not gate meaning, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "Exactly one operand flows from a normalizer while the other stays raw at a decision-making comparison",
            remedy: "Normalize both operands with the same transformation before comparing",
          },
          false: {
            what: "Both sides share normalization, the comparison is display-only, or the evidence does not establish a one-sided gate",
          },
        },
      },
      message: "This comparison normalizes one side but not the other.",
    },
    "jev/no-unguarded-nullable-dereference": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this member access or call dereference a value whose source can be absent, with no guard between the source and the use?",
          inspect: "Compare each extracted dereference, its nullable origin, its guard status, the validator imports, and the repository callers in the supplied evidence.",
          focus: "Judge whether an absent value can reach the use at runtime, not whether absence handling exists elsewhere in the module.",
          decision_boundary: [
            "A property read or call on a find, Map.get, querySelector, or params-shaped result with no intervening guard is strong evidence of an unguarded dereference.",
            "An explicit presence check with throw or return, optional chaining, nullish handling, an assertion helper, or a schema validator between source and use is a guard.",
            "A guard elsewhere in the module does not protect this use unless it executes on every path from the source.",
            "Direct chaining off a nullable-returning call without an intermediate binding is still a dereference of a possibly absent value.",
            "If the source cannot be absent or a guard covers the path, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "A possibly absent value reaches a member access or call with no guard on the path between source and use",
            remedy: "Check presence explicitly, narrow with a validator, or handle absence before dereferencing",
          },
          false: {
            what: "A guard, validator, or caller guarantee covers the path, or the evidence does not establish that the source can be absent",
          },
        },
      },
      message: "This dereference can reach an absent value without a guard.",
    },
    "jev/no-falsy-absent-conflation": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this presence check treat a valid falsy value such as 0, empty string, or false as absent, silently dropping legitimate input?",
          inspect: "Compare each extracted truthiness or default site, the tested value, the declared types, and the repository callers passing edge values in the supplied evidence.",
          focus: "Judge whether falsy is a legitimate member of the tested domain, not whether truthiness checks appear at all.",
          decision_boundary: [
            "A truthiness test or || default on a numeric, timestamp, rate, count, or boolean domain where 0, empty string, or false carries meaning is strong evidence of conflation.",
            "A ?? default preserves falsy values and is the explicit absence check for nullable domains.",
            "A truthiness check on a value whose validator or type rejects every falsy member upstream is a genuine absence check.",
            "Explicit comparisons against undefined or null do not conflate falsy with absent.",
            "If the domain excludes falsy values or the evidence does not establish that falsy is legitimate, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "A truthiness test or fallback discards a falsy value that belongs to the domain",
            remedy: "Test explicitly for null or undefined, or default with ?? instead of ||",
          },
          false: {
            what: "Falsy values are invalid upstream, the check already distinguishes absence explicitly, or the domain evidence is insufficient",
          },
        },
      },
      message: "This presence check treats a valid falsy value as absent.",
    },
    "jev/no-unanchored-domain-check": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this host or domain allow-check match substrings rather than domain boundaries, so an attacker-controlled superstring can pass it?",
          inspect: "Compare each extracted check, its matching method, anchoring and dot-boundary signals, whether the URL was parsed first, and the callers in trust-gating paths in the supplied evidence.",
          focus: "Judge whether a superstring of an allowed entry can satisfy the check, not whether substring matching appears at all.",
          decision_boundary: [
            "An indexOf, includes, startsWith, or endsWith comparison of a request host or origin against an allow-list entry is strong evidence of an unanchored check.",
            "An unanchored regular expression without start or end anchors and without a dot-boundary admits sibling and superstring domains.",
            "Parsing with new URL and comparing the exact hostname, or requiring an explicit dot-boundary, anchors the check to domain structure.",
            "Substring matching on full paths or non-trust values where substring semantics are intended is not a domain-boundary smell.",
            "If the value never gates trust or the check is anchored to exact host equality, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "A trust-gating host comparison accepts superstrings of an allowed entry instead of matching domain boundaries",
            remedy: "Parse the URL and compare exact hostnames or require an explicit dot-boundary",
          },
          false: {
            what: "The check is anchored to exact host equality, the value never gates trust, or the evidence does not establish a superstring bypass",
          },
        },
      },
      message: "This host check matches substrings instead of domain boundaries.",
    },
    "jev/no-contract-signature-drift": {
      scope: "function",
      question: {
        instructions: {
          question: "Has this implementation or call site drifted from the contract it claims to satisfy in arity, abstract members, or nullability, so conforming callers hit runtime failures?",
          inspect: "Compare each extracted drift with the resolved contract module excerpt, sibling implementations, declared return contracts, and the repository callers in the supplied evidence.",
          focus: "Judge structural disagreement between an existing machine-readable contract and its implementation or use, not whether documentation prose is missing.",
          decision_boundary: [
            "An override with fewer parameters than the resolved base requires, a missing abstract member, a short call, or a null return against a non-nullable contract is strong evidence of drift.",
            "An override that adds only optional parameters while satisfying every existing call site still satisfies the contract.",
            "A contract excerpt that is unavailable or ambiguous is insufficient; structural disagreement must be visible.",
            "Intentional overloads and documented optional extensions that every caller honors are not drift.",
            "If the contract and implementation agree or the disagreement is not established, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "The implementation or call site structurally disagrees with an existing contract in parameters, members, or nullability",
            remedy: "Restore the missing parameters, members, or nullability guarantees so the contract holds",
          },
          false: {
            what: "The code satisfies the contract, extends it only with compatible optional shape, or lacks enough contract evidence to judge",
          },
        },
      },
      message: "This code disagrees with the contract signature it claims to satisfy.",
    },
    "jev/no-accidental-serialization": {
      scope: "function",
      question: {
        instructions: {
          question: "Are this loop's iterations independent, so awaiting each one inside the loop serializes work that could proceed concurrently?",
          inspect: "Compare each loop with its awaited calls and arguments, cross-iteration dataflow, callee import sources, ordering signals, and callers in the supplied evidence.",
          focus: "Judge whether the sequencing is accidental rather than required by data dependence, shared accumulation, ordering guarantees, or rate limits.",
          decision_boundary: [
            "Awaiting a remote fetch whose arguments derive from the element alone, with results stored by key and no shared mutation, is strong evidence of accidental serialization.",
            "A loop that folds each result into a running aggregate consumed in order requires sequencing.",
            "Result indexing by element alone does not prove independence when a limiter, comment, or shared write signals required order.",
            "A concurrency limiter or sequencing comment around the same call is evidence the order is deliberate.",
            "If cross-iteration dependence or the callee's domain is unclear, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "Independent iterations are awaited one at a time although no dataflow, ordering, or rate-limit constraint requires it",
            remedy: "Run the independent iterations concurrently and collect their results",
          },
          false: {
            what: "Iterations share state, consume results in order, honor a deliberate limit, or lack enough evidence of independence",
          },
        },
      },
      message: "This loop serializes independent iterations by awaiting each one.",
    },
    "jev/no-discarded-transformation": {
      scope: "function",
      question: {
        instructions: {
          question: "Is this array transformation's result discarded, so either the transformation computes something nobody needs or the method choice hides intended side effects?",
          inspect: "Compare each discarded map, filter, flatMap, or reduce call with its callback purity facts and the function's callers in the supplied evidence.",
          focus: "Distinguish a lost computation from a side-effecting callback misusing a transformation method as an iterator.",
          decision_boundary: [
            "A pure element mapper called as a bare statement with the array never referenced again is strong evidence of a lost computation.",
            "A callback whose body performs the module's persistence write or mutates outer state is evidence the discarded array is incidental and the method choice is the smell.",
            "A callback that both computes and mutates needs judgment about which purpose the call site serves.",
            "Reduce with an accumulator thread is a different shape from a discarded mapping; score only the listed methods with unused results.",
            "If the callback's effects or the fate of the computed value are unclear, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "A transformation computes a value nobody uses, or a transformation method hides an iteration performed only for side effects",
            remedy: "Use the computed result or replace the transformation with an explicit iteration",
          },
          false: {
            what: "The result is consumed, the method choice fits the iteration purpose, or the evidence does not establish a lost computation",
          },
        },
      },
      message: "This array transformation discards its result.",
    },
    "jev/no-load-bearing-async": {
      scope: "function",
      question: {
        instructions: {
          question: "Do callers depend on this function's promised return, so the async marker carries API meaning its body alone does not show?",
          inspect: "Compare the await-less async function with every awaiting call site, then-chain, promise combinator, and plain call in the supplied evidence.",
          focus: "Judge whether removing the async marker would break consumers that await the result or chain off the promise.",
          decision_boundary: [
            "An exported helper awaited at every call site across several modules with catch chains attached is strong evidence the marker is load-bearing.",
            "A private function whose callers all ignore the return value leaves the marker redundant.",
            "Feeding the result into Promise.all or Promise.allSettled is evidence callers treat the return as a promise.",
            "Exported functions may have unobserved external callers; weigh that uncertainty against the shown call sites.",
            "If no caller evidence shows dependence on the promise, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "Callers demonstrably rely on the promised return through awaiting, chaining, or combinators",
            remedy: "Keep the async marker and its promise contract, or migrate callers before changing the return",
          },
          false: {
            what: "Callers ignore the return value, the marker is redundant, or the evidence does not establish caller dependence",
          },
        },
      },
      message: "This async marker carries promise meaning its body does not show.",
    },
    "jev/no-untrusted-sink-input": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this sink call incorporate input an adversary can influence without parameterization or escaping the evidence can see?",
          inspect: "Compare each sink call with its interpolated sources traced one hop back, placeholder presence, escape helpers, modeling imports, and caller argument shapes in the supplied evidence.",
          focus: "Judge whether the interpolated value is adversary-reachable or an internal constant, and whether the sink neutralizes it.",
          decision_boundary: [
            "A query interpolating a handler parameter with no placeholder and no escape helper in the module is strong evidence of untrusted sink input.",
            "Interpolations that resolve to module constants or function-local literals are not adversary-reachable.",
            "Parameter placeholders, query builders, and escaping imports neutralize interpolation even when the value originates outside.",
            "A shell option enabled on a command sink raises the consequence of any interpolated value.",
            "If the source of the interpolated value or the sink's neutralization is unclear, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "An adversary-reachable value flows into a SQL, command, or DOM sink without visible parameterization or escaping",
            remedy: "Parameterize the sink input or pass it through an escaping or query-building boundary",
          },
          false: {
            what: "The value is an internal constant, the sink is parameterized or escaped, or the evidence does not establish adversary reachability",
          },
        },
      },
      message: "This sink call incorporates untrusted input without visible neutralization.",
    },
    "jev/no-unreleased-subscription": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this subscription or acquisition have no release tied to its owner's lifetime, so repeated owners accumulate unreleased registrations?",
          inspect: "Compare each acquisition with the removals present in the same module, effect cleanup returns, owner-lifetime signals, and callers in the supplied evidence.",
          focus: "Judge whether the missing removal leaks across repeated owners or the registration intentionally lives as long as the process.",
          decision_boundary: [
            "An addEventListener inside a per-request handler with no removal anywhere in the module is strong evidence of a leak.",
            "A module-scope registration at boot with process lifetime and an explicit shutdown hook intentionally outlives its owners.",
            "An effect cleanup return or matching removal in the same module pairs setup with teardown.",
            "A single registration call alone is never proof; use owner lifetime and repetition to judge accumulation.",
            "If the owner's lifetime or repetition is unclear, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "A repeated owner registers without a matching release, so registrations accumulate over the owner's lifetime",
            remedy: "Tie the release to the owner's teardown with a matching removal or cleanup return",
          },
          false: {
            what: "Setup and teardown are paired, the registration intentionally shares process lifetime, or the evidence does not establish accumulation",
          },
        },
      },
      message: "This subscription has no release tied to its owner's lifetime.",
    },

    "jev/no-unwieldy-signature": {
      scope: "function",
      question: {
        instructions: {
          question: "Must a new caller read the implementation to use this signature correctly?",
          inspect: "Count the positional slots each caller must fill correctly, including undefined placeholders and boolean flags, and compare them with the declared parameters, their types, defaults, overloads, and which slots the body actually uses.",
          focus: "Judge the contract a new caller faces: how many positions must be counted, how many flags carry meaning only by position, and how many slots exist only to be skipped or ignored.",
          decision_boundary: [
            "Undefined placeholders passed for middle slots are strong evidence the caller counts positions to reach later arguments.",
            "Positional boolean flags whose true and false meanings live only in the implementation force every caller to read it, regardless of parameter names.",
            "Parameters never referenced in the body are dead slots that expand the contract without meaning.",
            "Existing callers that supply every slot show the code compiles, not that a new caller could do so without reading the implementation.",
            "A short signature whose callers pass named variables in declared order with no placeholders and no dead slots is usable as declared; answer no for it.",
          ],
        },
        criteria: {
          true: {
            what: "The signature forces callers to memorize positions, supply placeholders, or guess boolean meanings that the declaration does not explain",
            remedy: "Introduce an options object, name the modes, or split the operation so each signature reads as its own contract",
          },
          false: {
            what: "Callers use the signature as declared, optional behavior is grouped explicitly, or the evidence does not show caller confusion",
          },
        },
      },
      message: "Callers cannot use this signature correctly without reading the implementation.",
    },
    "jev/no-inappropriate-intimacy": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this function depend on another module's internals in ways that module's interface does not advertise?",
          inspect: "Compare each member-access chain rooted at an imported binding with the owner module's exported members, the import paths used, and how other importers of the same module reach it.",
          focus: "Judge how the function reaches foreign state: through advertised entry points or by digging into unexported structure, private-marked members, or barrel-bypassing paths.",
          decision_boundary: [
            "Repeated access into underscore-prefixed or unexported members where the owner exports an accessor nobody calls is strong evidence of intimacy with internals.",
            "Deep relative imports that bypass a barrel to reach interior files suggest the interface was routed around, not used.",
            "Assertions applied specifically to reach further into a foreign value show the boundary resisting the access.",
            "Deep access into members the owner exports and documents as shared plumbing is ordinary collaboration, even when the chain is long.",
            "One member access alone is never enough. If the evidence does not establish the accessed structure as interior, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "The function reaches past the other module's advertised interface into interior or private-marked structure",
            remedy: "Use the owner's public operations, or promote the needed interior access into an advertised interface",
          },
          false: {
            what: "The function uses exported entry points, follows documented shared plumbing, or the interior character of the access is not established",
          },
        },
      },
      message: "This function depends on another module's internals past its advertised interface.",
    },
    "jev/no-anemic-type": {
      scope: "abstraction",
      question: {
        instructions: {
          question: "Does this type's behavior live entirely in its clients, so every change to what it means must be made elsewhere?",
          inspect: "Compare the type's own fields and logic-bearing methods with the external functions that read its fields, branch on its members, and call its accessors across the repository.",
          focus: "Judge from the owner's side whether behavior that belongs with the data never moved in, as shown by clients operating on bare fields.",
          decision_boundary: [
            "Public fields with no logic-bearing methods and pricing, validation, or discount branching on those fields in several other modules are strong evidence the behavior lives in clients.",
            "Getters and setters alone, or methods that only assign or return fields, do not constitute behavior.",
            "Plain data carriers at a serialization or transport boundary are expected to be read elsewhere; score only the residual domain-behavior question.",
            "Field reads alone are never enough. If the evidence does not show domain decisions made outside the type, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "The type exposes bare fields while domain decisions about its meaning are implemented across its clients",
            remedy: "Move the client-side decisions onto the type as named behavior, or narrow the type to the boundary it actually serves",
          },
          false: {
            what: "The type carries its own behavior, serves as a boundary carrier, or the evidence does not show externalized domain decisions",
          },
        },
      },
      message: "This type's behavior lives in its clients rather than in the type itself.",
    },
    "jev/no-temporary-field": {
      scope: "abstraction",
      question: {
        instructions: {
          question: "Does this field hold a value during only part of the object's lifetime, forcing readers to reconstruct when it is meaningful?",
          inspect: "Compare where each field is assigned with where it is read: constructor versus method writes, the methods that read it, presence guards before use, and which methods external callers invoke.",
          focus: "Judge lifetime scoping inside the class: whether the type declares a field as always present that is empty until some method runs.",
          decision_boundary: [
            "A field assigned in one method, read in a different method, and absent from the constructor is strong evidence of a partial-lifetime value.",
            "Optional or undefined-able declarations with presence guards before use confirm readers must handle the field's absence.",
            "Callers invoking the reading method without the writing method show the lifetime confusion reaching real use.",
            "A lazily computed cache guarded by a single accessor that recomputes on absence is an established pattern, not a temporary field.",
            "One late assignment alone is never enough. If reads always follow writes through one accessor, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "The field is meaningful only between particular method calls, so correct use depends on an unenforced order",
            remedy: "Pass the value as a parameter, compute it on demand behind one accessor, or split the lifecycle into separate types",
          },
          false: {
            what: "The field is assigned at construction, recomputed safely on absence, or the evidence does not establish a partial lifetime",
          },
        },
      },
      message: "This field is meaningful during only part of the object's lifetime.",
    },
    "jev/no-low-cohesion-class": {
      scope: "abstraction",
      question: {
        instructions: {
          question: "Does this class bundle members that share little state or purpose and would be clearer as separate units?",
          inspect: "Compare each method's field usage and import sources with the computed field-sharing clusters and the per-method caller sets in the supplied evidence.",
          focus: "Judge whether the methods serve distinct audiences over disjoint state, not whether the class is merely large.",
          decision_boundary: [
            "Clusters of methods that share no fields, use distinct collaborators, and serve disjoint caller sets are strong evidence of bundled responsibilities.",
            "A large class whose methods all operate on one shared field set is big but coherent.",
            "A constructor touching many fields, lifecycle hooks, and one coordinating facade method do not by themselves establish separate responsibilities.",
            "Two methods alone sharing nothing is weak evidence unless the caller sets also show distinct audiences.",
            "If the evidence does not establish disjoint state together with distinct collaborators or callers, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "The class serves two or more unrelated audiences over disjoint state, so each cluster could live behind its own boundary",
            remedy: "Split the class along the field-disjoint clusters so each unit owns one responsibility",
          },
          false: {
            what: "The methods share state, collaborators, or one audience, or the evidence does not establish distinct responsibilities",
          },
        },
      },
      message: "This class bundles unrelated responsibilities over disjoint state.",
    },
    "jev/no-divergent-change": {
      scope: "change",
      question: {
        instructions: {
          question: "Is this module changed for unrelated reasons, so edits that should be independent keep colliding in one file?",
          inspect: "Compare the per-hunk declaration fingerprints within each touched module, whether same-file hunks touch disjoint member sets, and the caller sets exercising the touched declarations in the supplied evidence.",
          focus: "Judge whether one change mixes independent reasons in one module, not whether the diff is large or spans files.",
          decision_boundary: [
            "Multiple hunks in one file touching disjoint members for distinct caller sets are strong evidence of unrelated reasons colliding.",
            "A multi-hunk change where every hunk serves one rename, one feature, or one fix across the module's members is one reason, not divergence.",
            "Spread across many files for one concept belongs to shotgun change, not this rule; this rule scores many concepts colliding in one file.",
            "Hunks that share declarations or serve the same callers are related edits even when they look far apart in the file.",
            "If the coverage metadata shows omitted modules or the hunks do not map to distinct declarations, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "One module absorbs edits for unrelated reasons with disjoint member sets and distinct audiences, forcing independent changes to collide",
            remedy: "Split the module so each responsibility can change independently",
          },
          false: {
            what: "The hunks serve one reason, share members or callers, spread one concept across files, or lack enough evidence of unrelated motives",
          },
        },
      },
      message: "This module is changed for unrelated reasons that should live apart.",
    },
    "jev/no-divergent-sibling-interfaces": {
      scope: "abstraction",
      question: {
        instructions: {
          question: "Do these sibling implementations expose needlessly different interfaces for the same operation, so clients must learn each one?",
          inspect: "Compare the candidate's member inventory with each sibling's, the analogous member pairs with matching arity but different names, and the shared clients calling across siblings in the supplied evidence.",
          focus: "Judge inconsistency in the caller-facing interface for the same operation, not whether bodies legitimately differ.",
          decision_boundary: [
            "Analogous members with the same arity and parameter shape but different names across siblings, called by shared clients, are strong evidence of divergence.",
            "Siblings whose analogous methods take genuinely different parameters for different cases diverge for a reason.",
            "One divergent name with no shared clients is weak evidence; clients branching on a discriminant before calling strengthen the case.",
            "Common verbs from different domains or lifecycle stages are not the same operation merely because arities match.",
            "If the evidence does not establish that the paired members perform the same operation for shared clients, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "Siblings name the same operation differently or shape it inconsistently, forcing clients to learn each variant",
            remedy: "Align the sibling interfaces so the same operation has one name and shape",
          },
          false: {
            what: "The differences reflect genuinely different cases, no shared clients pay the learning cost, or the operations are not shown to be analogous",
          },
        },
      },
      message: "These siblings expose needlessly different interfaces for the same operation.",
    },
    "jev/no-refused-inheritance": {
      scope: "abstraction",
      question: {
        instructions: {
          question: "Does this subclass discard or neutralize behavior it inherits, so the inheritance link misleads readers about what it does?",
          inspect: "Compare each override body with the inherited contract, the unused inherited members, and the instantiation and supertype-typed usage sites in the supplied evidence.",
          focus: "Judge whether the subclass keeps the extends link while rejecting the behavior, and whether callers relying on the superclass type feel the refusal.",
          decision_boundary: [
            "Overrides that only throw, return constants, or sit empty while callers hold the subclass as the superclass type are strong evidence of refused inheritance.",
            "An override that specializes one method while using the rest of the inherited surface refines the contract rather than refusing it.",
            "Super-delegating overrides and unused helpers that no caller exercises through the supertype are weak evidence on their own.",
            "Composition-friendly narrowing at construction or documented non-support with no supertype-typed callers limits the misleading surface.",
            "If the evidence does not show discarded behavior that matters to callers of the inherited contract, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "The subclass inherits a contract it neutralizes while callers can still rely on the superclass type, so the link promises behavior it does not deliver",
            remedy: "Replace the inheritance link with composition or a narrower type that states only the behavior kept",
          },
          false: {
            what: "The overrides specialize rather than discard, the unused members do not reach supertype-typed callers, or the refusal is not established",
          },
        },
      },
      message: "This subclass discards behavior its inheritance link still promises.",
    },

    "jev/no-unnamed-parameter-object": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this positional parameter list describe a coherent object the code never names, forcing every caller to keep argument order in mind?",
          inspect: "Compare the parameter names and count, shared naming affixes, body packing of parameters into one object, sibling functions taking overlapping subsets, and call sites spreading one object's properties into positional slots in the supplied evidence.",
          focus: "Judge whether callers already hold a single concept that the signature splits into positional slots, rather than a coincidental bundle of independent values.",
          decision_boundary: [
            "Callers supplying properties of one object in the same order, shared parameter affixes, and body packing into one object are strong evidence of an unnamed concept.",
            "A short list of unrelated kinds invoked with inline literals at each site is a coincidental bundle, not a missing object.",
            "Recurrence of the same group across functions belongs to data-clump territory; this rule needs only one function's own callers to reveal the object.",
            "Destructured single-object parameters and options bags already name the concept.",
            "If the evidence does not show callers holding the object or parameters forming a coherent concept, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "Positional parameters split a coherent caller-held concept that no named type captures",
            remedy: "Introduce a named parameter object and migrate call sites to pass it whole",
          },
          false: {
            what: "Parameters are independent values, already grouped in a named object, or lack evidence of a caller-held concept",
          },
        },
      },
      message: "This parameter list describes an object the code never names.",
    },
    "jev/no-predictable-token": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this weak randomness guard something an adversary can exploit, rather than providing benign variability?",
          inspect: "Compare each Math.random call and its token-assembly context, secure-alternative availability, credential-named sinks receiving the value, and caller module roles in the supplied evidence.",
          focus: "Judge whether the random output protects an adversary-facing secret such as a session, token, or reset secret, rather than jitter, sampling, UI variation, or test fixtures.",
          decision_boundary: [
            "A reset or session token minted from Math.random and persisted to a user row or credential-bearing response is strong evidence of adversary-facing weakness.",
            "Random jitter in a retry delay, sampling, UI variation, or values confined to test fixtures are benign uses.",
            "A secure alternative already imported in the module raises the reading; its absence does not by itself establish exploitability.",
            "Pure determinism or testability concerns belong elsewhere; score only adversary-facing adequacy of the generator.",
            "If the value never reaches a credential sink or adversary-observable surface, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "Weak randomness mints or guards an adversary-facing secret without adequate unpredictability",
            remedy: "Mint the value with a cryptographic generator such as crypto.getRandomValues or randomUUID",
          },
          false: {
            what: "Randomness serves jitter, sampling, display, or tests, or never reaches an adversary-observable secret",
          },
        },
      },
      message: "This weak randomness guards something an adversary can exploit.",
    },
    "jev/no-unreachable-guard": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this defensive check guard a case no caller can produce, misleading readers about the function's real contract?",
          inspect: "Compare each guard clause, its guarded parameter and fallback behavior, every same-repo call site's argument shapes, and exportedness in the supplied evidence.",
          focus: "Judge whether the guarded case can arrive through any known caller, weighing that exported boundaries admit unknown external callers.",
          decision_boundary: [
            "A private function whose every call site supplies values the guard excludes is strong evidence of a misleading check.",
            "An exported handler whose parameters arrive from request objects no same-repo caller constrains may genuinely need the guard.",
            "A guard whose fallback carries behavior readers will trust, such as a default value or error message, misleads more than a silent return.",
            "Checks that some caller can still trigger remain load-bearing regardless of how defensive they look.",
            "If caller evidence is thin or the boundary admits unknown external callers, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "A defensive check guards a case no caller can produce while presenting fallback behavior readers will trust",
            remedy: "Remove the unreachable check or narrow the contract so the guarded case is genuinely possible",
          },
          false: {
            what: "Some caller can trigger the guarded case, the boundary admits unknown callers, or the evidence does not establish unreachability",
          },
        },
      },
      message: "This defensive check guards a case no caller can produce.",
    },
    "jev/no-unaccountable-todo": {
      scope: "comment",
      question: {
        instructions: {
          question: "Does this deferred-work marker carry no accountable follow-through, leaving the deferral open-ended?",
          inspect: "Read the marker text for an owner, tracking reference, or scope bound, and the nearby code and module context for accumulation history and any interim fallback that bounds the wait.",
          focus: "Judge whether the deferral names who will honor it and when, rather than promising future work to nobody in particular.",
          decision_boundary: [
            "A bare marker such as TODO fix this later above intricate branching in a module already carrying aged markers is strong evidence of an open-ended deferral.",
            "A marker naming an issue, an owner, and the interim fallback that bounds it carries accountable follow-through.",
            "Restating nearby code is a separate concern; score only whether the deferral is accountable.",
            "A fallback or feature flag that bounds the interim weakens the reading even without a named owner.",
            "If the marker names an owner, a tracking reference, or an expiry condition, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "A deferred-work marker promises future work without naming who will do it, where it is tracked, or when it expires",
            remedy: "Name an owner and tracking reference, bound the scope, or do the work now",
          },
          false: {
            what: "The marker names an owner, tracking reference, or expiry condition, or sits behind an interim bound that contains the wait",
          },
        },
      },
      message: "This deferred-work marker carries no accountable follow-through.",
    },
    "jev/no-adversarial-regex": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this nested-quantifier pattern run against input an adversary can shape, exposing the service to disproportionate backtracking cost?",
          inspect: "Compare each pattern's nesting and alternation shape, the tested value's source traced toward request parameters or constants, length caps or timeouts, linear-engine use, and caller shapes in the supplied evidence.",
          focus: "Judge whether a small hostile input can reach the risky pattern and produce a large backtracking bill, rather than whether the pattern looks complex in isolation.",
          decision_boundary: [
            "A nested-quantifier pattern testing a route or request parameter with no length check in the module is strong evidence of adversary-reachable cost.",
            "The same pattern shape applied only to a module constant, or guarded by an explicit length cap before the test, contains the cost.",
            "A linear-engine import or timeout around the test weakens the reading even when the input is adversary-shaped.",
            "Cleverness of the pattern alone is out of scope; score only the asymmetry between hostile input size and backtracking cost.",
            "If the tested value never traces to adversary-shaped input, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "A backtracking-prone pattern tests adversary-shaped input without a length, timeout, or linear-engine bound",
            remedy: "Anchor or simplify the pattern, cap input length before testing, or test with a linear-time engine",
          },
          false: {
            what: "The pattern tests only internal constants, stays behind a length or timeout bound, runs on a linear engine, or lacks evidence of adversary reachability",
          },
        },
      },
      message: "This pattern risks disproportionate backtracking on adversary-shaped input.",
    },
    "jev/no-live-credential": {
      scope: "function",
      question: {
        instructions: {
          question: "Is this hard-coded secret a live credential rather than a test placeholder or obviously inert example?",
          inspect: "Compare each credential-named literal and its placeholder and entropy signals, the file role, whether the value reaches a real client constructor or transport call, nearby env plumbing, and callers in the supplied evidence.",
          focus: "Judge whether the literal can authenticate against a live surface, rather than whether secret-shaped text merely appears in code.",
          decision_boundary: [
            "A high-entropy token literal handed to a production client constructor in service code is strong evidence of a live credential.",
            "A placeholder such as changeme inside a test fixture with no transport use is an inert example.",
            "Env plumbing for the same key suggests the literal is a fallback or an accident, not deliberate configuration.",
            "Test, fixture, docs, and example paths lower the reading; service paths raise it.",
            "If the value never reaches a live client or is plainly a placeholder, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "A hard-coded literal can authenticate against a live surface through a real client or transport call",
            remedy: "Remove the literal, load the credential from the environment or secret store, and rotate the exposed value",
          },
          false: {
            what: "The literal is a placeholder, test fixture, or inert example that never reaches a live client",
          },
        },
      },
      message: "This hard-coded secret looks like a live credential.",
    },

    "jev/no-output-argument": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this function deliver its result by writing into a caller-supplied container instead of returning it, forcing call sites to read backwards?",
          inspect: "Compare the extracted writes into parameters, the presence or absence of value-carrying returns, the allocated-container call sites, and sibling functions in the supplied evidence.",
          focus: "Judge whether the contract shape reads backwards — allocate a container, call, then read it — not whether the mutation is surprising or undocumented.",
          decision_boundary: [
            "A function that pushes into or assigns a passed container with no value-carrying return, called from sites that each allocate a container and read it after, is strong evidence of an inside-out API.",
            "A function that both returns the result and appends to a passed collection as a documented secondary sink keeps the forward dataflow and scores low.",
            "A mutating method on the receiver itself states its contract through ownership rather than an output parameter.",
            "Sibling functions that return the same concept directly show the return-shaped alternative the call sites cannot use here.",
            "If no write into a parameter is established, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "Callers must supply a container to receive the outcome instead of composing a return value, so the dataflow reads backwards",
            remedy: "Return the computed result and let callers decide how to hold it",
          },
          false: {
            what: "The function returns its result, mutates only its own receiver, or the evidence does not establish a backwards contract",
          },
        },
      },
      message: "This function fills a caller-supplied container instead of returning its result.",
    },
    "jev/no-contextless-error": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this raised or re-raised error carry no facts about the failure, leaving handlers nothing to tell what happened?",
          inspect: "Use each extracted throw site, its message argument, interpolation, cause linkage, structured fields, bare-rethrow shape, empty rejections, sibling error sites, and caller handling in the supplied evidence.",
          focus: "Judge whether the error is born empty — identity preserved end to end yet nothing inside it — not whether a handler discards a rich error.",
          decision_boundary: [
            "A throw with no argument, an empty constructor call, a bare rethrow that adds nothing, or a static literal with no interpolated values, cause, or fields is strong evidence of a contextless error.",
            "A catch that discards the caught error to raise a fresh static message loses both identity and context.",
            "An interpolated message, a cause linkage, structured fields, or a discriminant type tag already identifies the failure and scores low.",
            "Sibling error sites for the same failure class that attach context this site omits confirm the gap.",
            "If the function raises no error, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "The raised error carries no message facts, cause, or involved values, so handlers cannot tell what happened",
            remedy: "Attach the operation, the involved values, and the caught error as cause when re-raising",
          },
          false: {
            what: "The error already identifies the failure through its message, cause, fields, or type, or the function raises nothing",
          },
        },
      },
      message: "This error carries no facts about the failure for handlers to use.",
    },
    "jev/no-unchecked-precondition": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this function assume a precondition its callers observably violate, with no assertion or guard stating the assumption?",
          inspect: "Use each extracted assumption site, its parameter and shape, the guard evidence between entry and use, sibling guards for the same assumption, and caller argument shapes in the supplied evidence.",
          focus: "Judge whether a missing guard meets a caller that demonstrably triggers the failure, not whether defensive checks are stylistically desirable.",
          decision_boundary: [
            "An index into a possibly-empty array, a division by a parameter, or a key access with no length, zero, or presence check anywhere, where callers supply the violating shape, is strong evidence of an unchecked precondition.",
            "An assertion, guard clause, or narrowing between entry and use states the assumption even when callers stay in bounds.",
            "Callers that uniformly supply satisfying arguments leave the assumption untriggered and score low.",
            "Sibling functions that guard the same assumption show the check this function omits.",
            "If no assumption site is established, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "The function assumes a non-empty input, valid divisor, or present key that callers observably violate without any stated guard",
            remedy: "Assert or guard the precondition at the routine entry so the assumption is proven, not hoped",
          },
          false: {
            what: "A guard or assertion states the assumption, callers satisfy it, or no assumption site is established",
          },
        },
      },
      message: "This function assumes a precondition it never states or checks.",
    },
    "jev/no-unenforced-warning-comment": {
      scope: "comment",
      question: {
        instructions: {
          question: "Does this comment admit a hazard that no code enforces, leaving the warning as the entire safety mechanism?",
          inspect: "Compare the matched hazard admission, the enclosing function source, the guard or assertion evidence covering the warned condition, and violating call sites in the supplied evidence.",
          focus: "Judge whether prose carries a safety obligation code never picks up, not whether the comment is well written.",
          decision_boundary: [
            "A must-call-first, assumes, not-safe-for, or caller-must admission beside an enclosing function with no guard, assertion, or type-level enforcement of the warned condition is strong evidence of an unenforced warning.",
            "A warning beside a matching assertion or guard clause that enforces it leaves no gap and scores low.",
            "A call site that violates the warned condition while the hazard stays prose-only confirms the warning is the whole mechanism.",
            "Conceptual hazards such as reentrancy, lifetime, or aliasing that state analysis cannot see still count when the prose admits them and no guard exists.",
            "If the comment admits no ordering, lifetime, or safety hazard, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "The comment admits an ordering, lifetime, or safety hazard that no guard, assertion, or type enforces",
            remedy: "Enforce the warned condition in code with a guard, assertion, or type the compiler checks",
          },
          false: {
            what: "Code enforces the warned condition, or the comment admits no hazard anyone must obey",
          },
        },
      },
      message: "This comment warns of a hazard no code enforces.",
    },

    "jev/no-table-shaped-conditional": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this conditional map inputs to outcomes as data per arm, so a lookup would state the mapping the branches only enumerate?",
          inspect: "Use each extracted arm, its tested literal, the shared discriminant, whether any arm performs behavior, any existing record or map keyed by the discriminant, other functions mapping the same discriminant, and callers in the supplied evidence.",
          focus: "Judge whether the branches enumerate a data table that a lookup could state directly, not whether branching in general is undesirable.",
          decision_boundary: [
            "Three or more arms that each return or assign only a constant or lookup value over the same discriminant are strong evidence of a table written as branches.",
            "Any arm that calls a collaborator, constructs a value with behavior, mutates state, or branches further is behavior dispatch rather than a data mapping; answer no.",
            "An existing record, map, or object literal keyed by the discriminant, or a second function mapping the same values, shows the table already wants one home.",
            "Two arms, distinct discriminants per arm, or guards over unrelated conditions are not a table shape.",
            "If the evidence does not establish that every arm carries only data over one shared discriminant, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "The conditional enumerates a data mapping across three or more arms where a keyed lookup would state the same outcomes directly",
            remedy: "Replace the branches with a record, map, or table keyed by the discriminant",
          },
          false: {
            what: "An arm performs behavior, the arms test different values or shapes, or the evidence does not establish a pure data mapping",
          },
        },
      },
      message: "This conditional enumerates a data mapping that a lookup could state directly.",
    },
    "jev/no-sequential-step-soup": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this function perform sequential phases that share no dataflow between them, so each phase is a hidden function its callers never needed together?",
          inspect: "Use each extracted phase, its statements and declared bindings, the bindings shared between phases, whether a helper already wraps any one phase, and callers in the supplied evidence.",
          focus: "Judge whether the phases are separable units bundled by sequence rather than one computation its callers need whole.",
          decision_boundary: [
            "Three or more coherent phases with no shared local bindings between them are strong evidence that each phase could stand alone.",
            "Phases that thread one accumulator or intermediate result through every block form a genuine pipeline; answer no.",
            "A helper that already wraps one phase, or callers that need only one phase's effect, shows the bundling is already straining.",
            "Two phases, or phases too small to name, are a sequence rather than soup.",
            "If the evidence does not establish three separable phases, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "The function bundles sequential phases with disjoint dataflow that callers need independently and that could be named and tested alone",
            remedy: "Extract each phase into its own function and let callers compose only the phases they need",
          },
          false: {
            what: "The phases share dataflow as one pipeline, the sequence is too small to separate, or the evidence does not establish separable phases",
          },
        },
      },
      message: "This function bundles sequential phases that share no dataflow.",
    },
    "jev/no-mirrored-derived-state": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this value duplicate state owned elsewhere and stay in sync only through manual sync code, so the copies can disagree silently?",
          inspect: "Use the extracted sync shape, the source and its ownership, the count of independent writes to the copy, reads of the copy where the source is also in scope, and other readers in the supplied evidence.",
          focus: "Judge whether two homes for one piece of knowledge can drift apart, not whether copying data is ever convenient.",
          decision_boundary: [
            "An effect or refresh block copying a source into a second binding, plus independent writes to the copy or readers mixing both homes, is strong evidence of drift surface.",
            "A memoized derivation or selector recomputed from the source with no independent writes to the copy has a single representation; answer no.",
            "One-shot initialization copies that are never re-synced or re-written locally do not create an ongoing drift surface.",
            "If the evidence does not establish a persistent second home with its own write paths, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "The copy persists as a second home for source-owned knowledge with manual sync and independent writes or mixed readers that let the copies disagree",
            remedy: "Derive the value from the source at read time or move ownership so only one home can change",
          },
          false: {
            what: "The value is derived without independent writes, copied once and never re-synced, or lacks evidence of a persistent second home",
          },
        },
      },
      message: "This value mirrors source-owned state through manual sync code that can drift.",
    },
    "jev/no-construction-in-use": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this business-logic function build its own concrete collaborators instead of receiving them, so tests and new callers inherit its wiring choices?",
          inspect: "Use each extracted construction, its concrete class or factory, the import source, the assigned binding and how it is used for behavior, whether sibling functions receive the same collaborator as a parameter, and callers in the supplied evidence.",
          focus: "Judge whether the function hard-codes wiring decisions its callers cannot change, not whether constructing objects is ever acceptable.",
          decision_boundary: [
            "Constructing a concrete store, client, or service inline and invoking behavior on it, while siblings receive the same collaborator as a parameter, is strong evidence of hard-coded wiring.",
            "Construction of value objects with no behavior, or assembly undisputedly private to the function, does not constrain callers; answer no.",
            "Functions whose declared role is construction, such as factories, builders, providers, and composition roots, build by contract rather than by surprise.",
            "Callers that already hold an equivalent instance they cannot supply show the wiring choice propagating outward.",
            "If the evidence does not establish a behavior-bearing collaborator built inside domain logic, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "The function builds a concrete behavior-bearing collaborator inline where callers and tests cannot substitute or reuse their own instance",
            remedy: "Receive the collaborator as a parameter and move construction to the composition root or caller",
          },
          false: {
            what: "The construction is a value object, private assembly, the function's declared role, or lacks evidence of a behavior-bearing collaborator",
          },
        },
      },
      message: "This function builds its own concrete collaborators instead of receiving them.",
    },

    "jev/no-retry-storm-shape": {
      scope: "function",
      question: {
        instructions: {
          question: "Do these sibling callers retry the same dependency without spread or bounds, so one slow dependency synchronizes their retries into a storm?",
          inspect: "Use the function's own retry shape and timing, the resolved shared dependency, each sibling retry site with its timing and attempt budget, and the repository callers in the supplied evidence.",
          focus: "Judge the aggregate stampede risk across callers, not whether one retry site looks safe alone.",
          decision_boundary: [
            "Several sibling call sites retrying one shared dependency immediately or with identical fixed delays and no attempt budget is strong evidence of a retry storm shape.",
            "Sibling sites with exponential backoff, jitter, or a shared retry budget spread load even when each site retries.",
            "jev/no-unsafe-retry scores one retry site repeating failures unsafely; this rule scores synchronized retries across siblings even when each site alone looks bounded.",
            "A single retry site with no retrying siblings is not a storm shape; answer no.",
            "If the shared dependency or the sibling retry timing is unclear, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "Sibling callers retry the same dependency with synchronized timing and no spread or aggregate bound, so a slow dependency multiplies aligned retries",
            remedy: "Add backoff with jitter, a shared retry budget, or a bulkhead so sibling retries spread instead of stampeding",
          },
          false: {
            what: "Retries are spread by backoff or jitter, bounded by a shared budget, confined to one site, or lack enough evidence of synchronized siblings",
          },
        },
      },
      message: "These sibling callers retry the same dependency without spread or bounds.",
    },
    "jev/no-unbounded-accumulation": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this collection grow with input or time and have no eviction or size bound, so a long-lived process exhausts memory?",
          inspect: "Use the container lifetime, each growth site, the extracted eviction signals, whether growth is keyed by caller input, and the repository callers in the supplied evidence.",
          focus: "Judge growth without bound in a long-lived container, not whether appends happen at all.",
          decision_boundary: [
            "Appends into a module- or closure-lived collection keyed by request input with no delete, TTL, LRU, or length guard on any path is strong evidence of unbounded accumulation.",
            "A request-scoped collection fully consumed before return is bounded by the request lifetime.",
            "A documented cache with eviction, TTL, LRU, or an explicit size bound manages growth even when the bound lives beside the growth site.",
            "jev/no-shared-mutable-module-state scores hidden coupling through shared bindings; this rule scores growth without bound even in a fully documented single-writer cache.",
            "If the container lifetime or the absence of eviction is unclear, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "A long-lived collection grows with input or time while no eviction, expiry, or size bound removes entries",
            remedy: "Bound the collection with eviction, TTL, LRU, or an explicit size policy, or scope it to the request lifetime",
          },
          false: {
            what: "Growth is scoped to a short lifetime, managed by eviction or a size bound, or lacks enough evidence of unbounded lifetime",
          },
        },
      },
      message: "This collection grows without eviction or size bound.",
    },
    "jev/no-call-in-loop-persistence": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this loop perform one persistence round-trip per item, so cost grows with input size where a single set operation would do?",
          inspect: "Use each loop's awaited persistence call, its resolved ownership and persistence signals, the unused batch entry point, the input-size provenance, and the repository callers in the supplied evidence.",
          focus: "Judge per-item round-trips against a persistence boundary with a mandatory ownership trail, not loop-await shape alone.",
          decision_boundary: [
            "Awaited per-item saves, inserts, or updates through a resolved repository or persistence client over a caller-supplied collection are strong evidence of per-item round-trips.",
            "An unused batch entry point on the same dependency shows one set operation was available.",
            "Per-item calls over a tiny closed constant, or through a callee with no batch entry point, carry bounded cost.",
            "jev/no-avoidable-orchestration scores sequential orchestration in general; this rule requires a resolved persistence boundary and abstains without one.",
            "jev/no-accidental-serialization scores whether loop awaits are independent; this rule scores the per-item persistence round-trip cost with ownership evidence, and both can hold with different remedies.",
            "If callee ownership cannot be resolved to a persistence layer, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "The loop pays one persistence round-trip per item over an unbounded input while the dependency offers or could offer a set operation",
            remedy: "Replace per-item round-trips with the dependency's batch entry point or a single set operation",
          },
          false: {
            what: "The loop is bounded, the callee is not a persistence boundary, no batch alternative exists, or ownership evidence is missing",
          },
        },
      },
      message: "This loop performs one persistence round-trip per item.",
    },
    "jev/no-unbounded-parallel-fanout": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this fan-out launch one concurrent unit per input item with no concurrency bound, so a large input exhausts connections, memory, or downstream quota?",
          inspect: "Use each fan-out's combinator, collection provenance, leg cost, the limiter evidence, the downstream callee identity, and the repository callers in the supplied evidence.",
          focus: "Judge aggregate width against the input's provenance, not whether one leg looks safe alone.",
          decision_boundary: [
            "Promise.all over a caller-supplied collection with an I/O or heavy leg and no limiter import is strong evidence of unbounded fan-out.",
            "Fan-out over a small closed constant of pure computations carries bounded width.",
            "A limiter, worker pool, semaphore, or bounded queue makes width explicit even when the input is unbounded.",
            "jev/no-unbounded-wait scores a single attempt with no deadline; this rule scores aggregate width even when every leg carries a perfect deadline.",
            "If the collection provenance or the absence of a limiter is unclear, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "One concurrent unit launches per input item over an unbounded collection with no concurrency bound while legs consume shared resources",
            remedy: "Bound the fan-out with a limiter, worker pool, or chunked concurrency",
          },
          false: {
            what: "Width is bounded by a closed input, a limiter or pool, trivially cheap legs, or lacks enough evidence of unbounded input",
          },
        },
      },
      message: "This fan-out launches unbounded concurrent work per input item.",
    },
    "jev/no-concurrent-shared-mutation": {
      scope: "function",
      question: {
        instructions: {
          question: "Is this binding read, modified, and written back from concurrent callbacks with no coordination, so interleavings silently win or lose updates?",
          inspect: "Use the scheduling shapes and leg count, each binding's mutations per leg, check-then-act pairs, the coordination signals, and the repository callers in the supplied evidence.",
          focus: "Judge lost updates between concurrent legs, not missing compensation after them.",
          decision_boundary: [
            "Two or more concurrent legs pushing into one closed-over array, or a check-then-act pair across legs with no lock or aggregation, is strong evidence of uncoordinated shared mutation.",
            "Legs writing disjoint keys merged after settle, or results combined with reduce or Map merge, coordinate the outcome.",
            "jev/no-implicit-atomicity scores domain all-or-nothing operations lacking a transaction or recovery policy; this rule scores in-memory interleaving where no transaction concept applies.",
            "jev/no-shared-mutable-module-state scores shared scope across functions; this rule requires concurrent scheduling and scores interleaving, not scope.",
            "If concurrent scheduling or shared mutation across legs is not established, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "Concurrent callbacks read, modify, and write back shared state with no lock, atomic, or post-settle coordination, so interleavings lose updates",
            remedy: "Coordinate the legs with aggregation after settle, disjoint ownership, or an explicit lock or atomic",
          },
          false: {
            what: "Legs own disjoint state, coordinate through aggregation or locking, run sequentially, or lack enough evidence of concurrent interleaving",
          },
        },
      },
      message: "This shared binding is mutated from concurrent callbacks without coordination.",

    },
    "jev/no-sensitive-data-in-log": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this logging or telemetry call record secrets or personal data that outlive the request in log storage?",
          inspect: "Compare each logged call with the sensitive fields and whole-record spreads it carries, any redaction helper on the path, the logger import source, and the repository callers in the supplied evidence.",
          focus: "Judge what persists in log storage, not whether logging itself is appropriate. CWE-532 / CWE-200; OWASP Top 10 A09 Security Logging Failures.",
          decision_boundary: [
            "Logging a whole request or user record whose resolved shape carries secrets, or logging a secret-named field directly, is strong evidence of sensitive data in log storage.",
            "An explicit field pick of non-sensitive identifiers, or a redaction helper between the record and the log call, weighs against a leak.",
            "A structured logger with redaction configuration still leaks when the logged payload bypasses that configuration.",
            "Deterministic secret-scanning lints may flag the same literal; score the residual risk that the logged value exposes secrets or personal data.",
            "If the evidence does not establish a secret or personal field reaching stored logs, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "The log call persists secrets or personal data beyond the request without redaction",
            remedy: "Log explicit non-sensitive fields and pass records through a redaction helper before they reach storage",
          },
          false: {
            what: "The logged payload carries no secret or personal data, redaction stands between the record and storage, or the evidence does not establish exposure",
          },
        },
      },
      message: "This log call records secrets or personal data.",
    },
    "jev/no-unsafe-redirect-target": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this navigation target come from caller-controlled input with no allow-check, so the application can be steered to an attacker-chosen destination?",
          inspect: "Compare each redirect target with its source, whether the value is caller-controlled, any allow-list comparison or same-origin construction, and the repository callers in the supplied evidence.",
          focus: "Judge steering: whether an attacker can choose the destination, not whether the URL is well-formed. CWE-601; OWASP Top 10 A01 Broken Access Control.",
          decision_boundary: [
            "A redirect, location assignment, or router navigation over a request-derived target with no allow-list, origin check, or closed dispatch is strong evidence of open steering.",
            "An allow-list comparison, same-origin URL construction with an origin check, or dispatch over a closed enum of internal paths confines the destination.",
            "A constant or module-local target cannot be steered; such cases abstain before reaching judgment.",
            "If the evidence does not establish caller control of the destination or the absence of confinement, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "A caller-controlled value decides the navigation destination without an allow-check confining it",
            remedy: "Validate the target against an allow-list of internal destinations or construct it same-origin before navigating",
          },
          false: {
            what: "The destination is constant, confined by an allow-check or closed dispatch, or the evidence does not establish attacker steering",
          },
        },
      },
      message: "This navigation target can be steered to an attacker-chosen destination.",
    },
    "jev/no-overbroad-origin-trust": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this cross-origin grant trust any origin rather than a named set, so any site can claim the privilege?",
          inspect: "Compare each grant with its wildcard or reflective shape, whether credentials ride alongside, any origin comparison before the grant, and the repository callers in the supplied evidence.",
          focus: "Judge the absence of any check: a wildcard grant has no matcher to anchor. CWE-639 / CWE-942; OWASP Top 10 A01 Broken Access Control.",
          decision_boundary: [
            "An Access-Control-Allow-Origin wildcard combined with credentials, a postMessage to any origin carrying a token, or a CORS origin of * or true is strong evidence of overbroad trust.",
            "A wildcard on a public, unauthenticated asset response with no credential surface is a weaker shape.",
            "An origin comparison or allow-list membership check before the grant confines the privilege to named origins.",
            "If the evidence does not establish a wildcard or reflective grant, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "The grant extends a credentialed or privileged capability to any origin without a named check",
            remedy: "Grant the capability only to explicitly listed origins checked before each grant",
          },
          false: {
            what: "The grant is confined to named origins, carries no credentialed surface, or the evidence does not establish overbroad trust",
          },
        },
      },
      message: "This cross-origin grant trusts any origin.",
    },
    "jev/no-path-traversal-join": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this filesystem path incorporate an unvalidated segment that can escape its intended directory?",
          inspect: "Compare each path join or filesystem call with the caller-supplied segment it carries, any normalize-and-contain or basename confinement between input and use, the import source, and the repository callers in the supplied evidence.",
          focus: "Judge containment: a well-formed string can still carry ../ and leave the directory. CWE-22; OWASP Top 10 A01 / A03.",
          decision_boundary: [
            "A path join or filesystem call over a request-derived segment with no normalize-and-startsWith confinement or basename restriction is strong evidence of traversal risk.",
            "A normalize-plus-containment comparison or basename confinement between the input and the filesystem use contains the segment.",
            "Constant or module-local segments cannot traverse; such cases abstain before reaching judgment.",
            "Deterministic traversal lints may flag the same join; score the residual risk that the segment escapes its directory.",
            "If the evidence does not establish a caller-supplied segment reaching the filesystem, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "A caller-supplied segment reaches the filesystem without confinement to its intended directory",
            remedy: "Normalize the segment and verify containment within the base directory, or restrict it with basename confinement",
          },
          false: {
            what: "The segment is confined, constant, or the evidence does not establish an unvalidated escape from the directory",
          },
        },
      },
      message: "This filesystem path can escape its intended directory.",
    },

    "jev/no-phantom-member-access": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this member access name something the owning module never defines, so the call can only fail at compile or runtime?",
          inspect: "Compare each accessed member path with the resolved owner module surface, sibling uses of neighboring members, and the repository callers in the supplied evidence.",
          focus: "Judge whether the named member exists anywhere in the owner's exports, declared members, or re-export chain, or whether the access pattern matches a registry or dynamic convention the repo uses elsewhere.",
          decision_boundary: [
            "A member path absent from the owner's exports and source, with no sibling precedent, is strong evidence of a hallucinated access.",
            "Accesses into owners with re-export chains or dynamic registration that siblings also use may resolve outside the visible surface.",
            "An owner that cannot be resolved to a project module leaves existence genuinely uncertain.",
            "A near-miss sibling name that does exist points at a wrong pick, not a phantom member.",
            "If the owner surface establishes the member or the evidence cannot settle existence, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "The function calls a member that appears nowhere in the owning module's surface while no repo convention explains the indirection",
            remedy: "Call a member the owner actually defines or add the missing member to the owner",
          },
          false: {
            what: "The member exists in the owner surface, resolves through a re-export or registry pattern with precedent, or existence cannot be settled from the evidence",
          },
        },
      },
      message: "This member access names something the owning module never defines.",
    },
    "jev/no-laundered-absence": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this fallback convert a contract breach into an ordinary empty value, so callers can no longer distinguish none from broken?",
          inspect: "Compare each default and catch return with the producer contract, whether the defaulted value flows into a success-typed return, and how callers handle emptiness in the supplied evidence.",
          focus: "Judge whether emptiness is a legitimate domain state the callers handle deliberately or a laundered breach the callers can no longer detect.",
          decision_boundary: [
            "A default over a producer-guaranteed field, or a catch returning an empty collection while discarding the error, is strong evidence of laundering.",
            "Defaults over explicitly optional display fields whose callers render emptiness deliberately are legitimate absence handling.",
            "A fallback that preserves failure identity or branches distinctly on the empty case does not launder.",
            "Correct falsy handling elsewhere does not by itself justify turning genuine absence into valid emptiness.",
            "If the producer guarantees nothing or callers treat emptiness as meaningful, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "The function turns missing data or a failed load into a success-shaped empty value that callers cannot distinguish from genuine emptiness",
            remedy: "Propagate the absence explicitly so callers can tell none from broken",
          },
          false: {
            what: "The fallback covers an explicitly optional value, preserves failure identity, or matches how callers deliberately handle emptiness",
          },
        },
      },
      message: "This fallback launders a contract breach into ordinary emptiness.",
    },
    "jev/no-unverified-claim": {
      scope: "comment",
      question: {
        instructions: {
          question: "Does this comment assert behavior about nearby code that no test or caller pins, so readers cannot tell confidence from knowledge?",
          inspect: "Read the claimed behavior against the adjoined code, then weigh the claim-specificity, test and caller pinning, tracked-work pointer, and tone signals in the supplied evidence.",
          focus: "Judge whether the prose claims knowledge no test, caller, or tracked issue backs, rather than whether the wording sounds hedged.",
          decision_boundary: [
            "A comment naming exact behavior, such as backoff or edge-case handling, above code with no such mechanism and no pinning test or caller is strong evidence of an unverified claim, whether the wording is hedged or confident.",
            "Confident vagueness without hedge words, such as handles edge cases gracefully, counts the same as hedged doubt when nothing pins the claimed behavior.",
            "A hedge naming a concrete upstream uncertainty beside tests pinning current behavior records a real open question.",
            "Hedge or reassurance tone breaks ties only and is never sufficient on its own.",
            "If the comment states a verifiable contract, points at tracked work with pinned behavior, or states intent, constraints, or tradeoffs rather than behavior, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "The comment performs uncertainty or reassurance in prose while the adjoined code stays unverified and unpinned",
            remedy: "Verify the behavior and state the contract, or track the open question with tests pinning current behavior",
          },
          false: {
            what: "The comment records a concrete tracked uncertainty beside pinned behavior, or states intent, constraints, or tradeoffs",
          },
        },
      },
      message: "This comment asserts behavior no test or caller pins.",
    },
    "jev/no-convention-breaking-addition": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this added code follow a different local convention than its owning module, so readers must hold two conventions for one file?",
          inspect: "Compare the candidate's async style, error signaling, module system, and quote style against the owning module's dominant signals outside the candidate in the supplied evidence.",
          focus: "Judge whether the divergence is a justified migration or an isolated hunk disagreeing with the module it lands in.",
          decision_boundary: [
            "One hunk using promise chains, require, or error returns inside a module otherwise uniformly async, ESM, and throwing is strong evidence of drift.",
            "A change converting every hunk and its imports to the new convention at once is a migration, not drift.",
            "A single differing signal with no measurable module norm is insufficient to establish a break.",
            "File-level formatter choices the repo does not enforce carry less weight than async and error-signaling conventions.",
            "If the candidate agrees with the module norm or migrates the module coherently, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "The added function follows async, error, module, or style conventions that disagree with the owning module's established norm",
            remedy: "Rewrite the addition in the module's convention or migrate the whole module coherently",
          },
          false: {
            what: "The addition matches the module norm, migrates the module as a whole, or the module establishes no measurable norm",
          },
        },
      },
      message: "This addition follows a different convention than its owning module.",
    },
    "jev/no-repeated-handler-preamble": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this guard preamble or handler repeat failure handling the module already owns in one place, instead of sharing it?",
          inspect: "Compare the extracted preamble fingerprint with sibling preambles in the same module and whether a shared helper already performs the same handling in the supplied evidence.",
          focus: "Judge whether the repetition is copy-pasted ceremony that could live once at the boundary or deliberate per-site handling that translates distinct errors.",
          decision_boundary: [
            "Several siblings opening with the identical guard or catch shape while a shared helper one hop away already does it for some of them is strong evidence of ceremony.",
            "Similar-looking guards that translate distinct domain errors per site are deliberate handling, not repetition.",
            "A preamble with no sibling match and no shared helper is a local choice, not duplication.",
            "Uniform caller handling suggests the preamble could live once at the boundary.",
            "If each site owns a distinct error decision or nothing is shared, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "The function repeats a guard preamble or handler shape that siblings share and a common helper already owns",
            remedy: "Route the handling through the shared helper or boundary instead of repeating it per function",
          },
          false: {
            what: "Each site translates distinct errors, no shared helper exists, or the preamble is unique to this function",
          },
        },
      },
      message: "This handler repeats failure handling the module already owns once.",
    },
    "jev/no-non-narrowing-guard": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this defensive check change no path's assumptions, so it performs care without providing any?",
          inspect: "Compare each guard with the settling statements earlier in the same function, whether the value is reassigned between settling and guard, and the repository callers in the supplied evidence.",
          focus: "Judge whether the guard narrows any path the function's own preceding flow had not already settled.",
          decision_boundary: [
            "Re-checking a parameter narrowed lines earlier, or chaining optional access over a value the flow already established, without any reassignment between, is strong evidence of theater.",
            "A guard is genuine when the value can change between settling and guard, or when callers can produce the unguarded case on paths the flow never settled.",
            "Nearby type-system escapes change the question toward unchecked assumptions rather than redundant care.",
            "Guards that document a boundary the function's own flow cannot settle still narrow caller paths.",
            "If any path reaches the guard with the question genuinely open, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "The guard re-checks a value the function's own preceding flow already settled, with no reassignment reopening the question",
            remedy: "Delete the redundant check and let the earlier narrowing carry the path",
          },
          false: {
            what: "The guard settles a path the preceding flow left open, the value can change before the guard, or callers reach it unsettled",
          },
        },
      },
      message: "This guard narrows nothing the flow had not already settled.",
    },

    "jev/no-excess-context-parameter": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this parameter carry a wider object than the function uses, so every caller assembles context the callee never reads?",
          inspect: "Compare the parameter's declared or destructured shape with the member paths the body actually reads, whether the parameter is forwarded whole to another callee, and whether sibling functions consume the wider remainder in the supplied evidence.",
          focus: "Judge whether callers are coupled to a full shape for the sake of one member, not whether the object itself is large.",
          decision_boundary: [
            "A parameter read through one member path while its declared type or destructuring exposes many more members is strong evidence of excess context, especially when callers build or fetch the whole object for that one read.",
            "Forwarding the parameter whole to another callee that expects it justifies the width.",
            "A parameter whose several members are each read, or that is returned whole for callers to keep using, does not carry excess context.",
            "Sibling functions taking the same type show the width belongs to the family of callers, which weakens the claim against any one member.",
            "If the declared shape, the used members, or the caller construction sites are insufficient to judge, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "The function reads a small part of a wide parameter while callers must still supply the whole object, and no forwarding or family use justifies the width",
            remedy: "Narrow the parameter to the members the function reads, or pass the whole object only where several members are genuinely needed",
          },
          false: {
            what: "The width is used, forwarded whole to a collaborator expecting it, shared across a family of consumers, or not established by the supplied evidence",
          },
        },
      },
      message: "This parameter carries a wider object than the function uses.",
    },
    "jev/no-shallow-convenience-layer": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this layer add an interface over a collaborator without adding meaning, so readers learn two APIs for one capability?",
          inspect: "Compare the layer's method set with the wrapped collaborator: per-method forwarding, arity and naming changes, branching or policy per method, module ownership, and whether callers also use the collaborator directly in the supplied evidence.",
          focus: "Judge the layer as a whole: one meaningful method among forwarders changes the reading, and a single forwarder is a per-function question, not a layer question.",
          decision_boundary: [
            "Several methods each forwarding one call to the same collaborator with near-identical signatures and no branching, error mapping, defaulting, or policy is strong evidence of a shallow layer.",
            "A layer whose methods encode retry policy, batching, error mapping, defaults, or insulation across a dependency boundary adds meaning even when individual bodies are short.",
            "Direct callers of the wrapped collaborator alongside callers of the layer show the insulation leaks and strengthen the claim.",
            "A domain-owned layer over an external package is a useful boundary even when the forwarding is thin.",
            "If the collaborator, the method set, or the caller split is insufficient to judge, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "The layer mirrors the collaborator one-to-one with no policy, simplification, or insulation, so deleting it would cost readers nothing",
            remedy: "Remove the layer and have callers use the collaborator directly, or give the layer a policy worth its interface",
          },
          false: {
            what: "The layer encodes policy, simplifies or insulates a boundary, or the supplied method set and ownership do not establish mirroring",
          },
        },
      },
      message: "This layer mirrors its collaborator without adding meaning.",
    },
    "jev/no-prototype-in-production": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this code carry prototype-maturity markers yet serve production callers, so readers cannot tell which corners were never finished?",
          inspect: "Compare the maturity markers and provisional control flow in the changed span with the actual callers, sibling functions, and module context in the supplied evidence.",
          focus: "Judge the mismatch between disclaimed maturity and real use, not whether the markers are accountable or tracked.",
          decision_boundary: [
            "Prototype, spike, experimental, hack, temporary, or workaround markers on code called from shipped paths or handlers with no hardened sibling is strong evidence of prototype in production.",
            "An accountable marker with an owner and tracking issue still leaves the maturity mismatch unresolved; accountability alone does not harden the code.",
            "Markers on code called only from behind a feature flag, a test harness, or an isolated spike with no production callers weaken the claim.",
            "Literal conditions, empty branches, and hardcoded arms corroborate that the code was never finished.",
            "If the callers or the production reach of the marked code cannot be established, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "Marked-as-provisional code serves real callers while no finished alternative exists for them to use",
            remedy: "Finish and harden the code and remove the markers, or route production callers to a hardened implementation",
          },
          false: {
            what: "The markers guard genuinely isolated, flagged, or non-production use, or the supplied callers do not establish production reach",
          },
        },
      },
      message: "This code carries prototype markers yet serves production callers.",
    },
    "jev/no-hidden-loop-exit": {
      scope: "function",
      question: {
        instructions: {
          question: "Is this loop's exit decided mid-body by a conditional break, continue, or return, so readers cannot tell the iteration shape from the loop header?",
          inspect: "Compare each loop header with its mid-body exits: the guard condition, whether it duplicates the header's own condition or introduces a new predicate, whether the predicate is a named query or an inline compound, and the loop bound shape in the supplied evidence.",
          focus: "Judge whether the exit hides the iteration contract, not whether the loop contains any branch at all.",
          decision_boundary: [
            "An unbounded header such as for(;;) or while(true) with a compound conditional exit buried mid-body is strong evidence of a hidden exit.",
            "An exit whose condition restates the header's own condition is first-class iteration control, not a hidden exit.",
            "A single search-and-stop exit in a bounded loop, especially behind a named predicate a reader can look up, weakens the claim.",
            "Unconditional mid-body exits and exits duplicated across several new predicates each hide the iteration shape in proportion to their distance from the header.",
            "If the loop bound or the exit guard cannot be established from the supplied evidence, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "The loop header misstates the iteration shape because the real exit decision lives mid-body behind a new predicate",
            remedy: "Make the exit first-class in the loop header or extract the exit predicate into a named query at the loop's level",
          },
          false: {
            what: "The exits restate the header, implement an explicit search-and-stop the header already suggests, or lack enough evidence to establish hiding",
          },
        },
      },
      message: "This loop's exit is decided mid-body where the header does not state it.",

    },
    "jev/no-inconsistent-error-contract": {
      scope: "function",
      question: {
        instructions: {
          question: "Do sibling operations report the same failure class in incompatible ways, so callers cannot handle the failure once?",
          inspect: "Compare the candidate's failure-reporting style with each sibling's style, return annotation, shared contract type, and caller samples in the supplied evidence.",
          focus: "Judge cross-sibling handling cost for one failure class, not whether a single translation discards information.",
          decision_boundary: [
            "Sibling operations reporting the same absence as throw, null, and an envelope while callers use a different handling style per sibling is strong evidence of an inconsistent contract.",
            "Styles that differ only where the failure classes genuinely differ, such as absence versus invalid input, preserve a coherent contract.",
            "A shared Result or error type that every sibling follows weakens the claim even when the spelling looks unfamiliar.",
            "One consistent convention module-wide with a single adapted legacy exception is not an inconsistent contract.",
            "If the siblings' failure classes or the callers' handling needs are unclear, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "Sibling operations report the same failure class through different channels that force callers to handle each sibling differently",
            remedy: "Adopt one failure-reporting channel per failure class across sibling operations, ideally behind a shared Result or error type",
          },
          false: {
            what: "The siblings share one reporting channel, differ only across genuinely different failures, follow a shared contract type, or lack enough evidence to establish handling cost",
          },
        },
      },
      message: "Sibling operations report the same failure in incompatible ways.",
    },
    "jev/no-breaking-export-reshape": {
      scope: "change",
      question: {
        instructions: {
          question: "Does this change reshape a contract existing consumers rely on, so current callers break without a migration path?",
          inspect: "Compare each reshaped export's before and after signature, whether a shim or overload preserves the old call, and whether in-repo callers still use the old shape in the supplied evidence.",
          focus: "Judge breakage of the previous release contract, not disagreement between implementation and declaration.",
          decision_boundary: [
            "A removed export or a newly required parameter with in-repo callers still using the old shape and no alias, overload, or deprecation shim is strong evidence of a breaking reshape.",
            "A reshape accompanied by a same-module alias, overload, or deprecation shim preserving the old call, with updated call sites, preserves the migration path.",
            "A narrowed annotation that only restates what callers already provide does not break consumers even when the text differs.",
            "Internal-only exports with no in-repo or external callers carry little breakage cost.",
            "If caller reach or the availability of a migration path is unclear, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "The change removes or reshapes a relied-upon export while existing callers still use the old shape and no shim preserves it",
            remedy: "Keep the old export as an alias or overload, update every caller, and document the migration path",
          },
          false: {
            what: "The old call still works through a shim, every caller moved with the change, or the evidence cannot establish relied-upon breakage",
          },
        },
      },
      message: "This change reshapes a relied-upon export without a migration path.",
    },
    "jev/no-positional-extension-drift": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this function grow by positional optional parameters while its neighbors already extend through an options bag, so the module's extension direction is inconsistent?",
          inspect: "Compare the candidate's trailing optional, defaulted, and boolean parameters with the sibling options-bag conventions, caller placeholder use, and distinct arities in the supplied evidence.",
          focus: "Judge the cross-sibling growth-direction inconsistency, not the raw size of any one signature.",
          decision_boundary: [
            "Several trailing positional optionals beside siblings taking a named options object, with callers passing undefined placeholders, is strong evidence of extension drift.",
            "A first optional parameter on a module with no options-bag convention anywhere is ordinary growth, not drift.",
            "A boolean mode flag alone belongs to mode-flag-parameter; drift requires positional growth against a nominal neighbor convention.",
            "Callers that never pass placeholders and stable arities weaken the claim that two conventions burden callers.",
            "If the sibling convention or the caller's growth burden is unclear, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "The function extends positionally while same-module siblings extend nominally, forcing callers to learn two growth conventions",
            remedy: "Route new options through an options bag matching the sibling convention",
          },
          false: {
            what: "The module shares one growth direction, the parameter is the first of its kind, or the evidence cannot establish a competing convention",
          },
        },
      },
      message: "This function extends positionally while its neighbors extend through an options bag.",
    },
    "jev/no-mixed-absence-convention": {
      scope: "function",
      question: {
        instructions: {
          question: "Do sibling operations spell the same absence differently, so callers checking one convention mishandle the other?",
          inspect: "Compare the candidate's absence spelling and return annotation with each sibling's spelling, annotation, shared convention type, and caller samples in the supplied evidence.",
          focus: "Judge production inconsistency across siblings, not whether any one consumer uses truthiness.",
          decision_boundary: [
            "Sibling lookups returning null and undefined for identical absence, with callers using one strict check for both, is strong evidence of a mixed convention.",
            "One convention module-wide with a single legacy exception already adapted at every call site is a contained exception, not a mixed convention.",
            "A shared Option, Maybe, or Result type that every sibling follows weakens the claim even when spellings look terse.",
            "Envelope returns such as { ok: false } against bare null for different failure classes may reflect distinct contracts rather than mixed absence.",
            "If the absence meanings differ across siblings or the caller risk is unclear, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "Sibling operations produce the same absence in different spellings that a single caller check cannot handle uniformly",
            remedy: "Adopt one absence spelling per module, declared in return annotations and ideally a shared absence type",
          },
          false: {
            what: "The siblings share one spelling, the exception is contained and adapted, a shared type governs absence, or the evidence cannot establish caller risk",
          },
        },
      },
      message: "Sibling operations spell the same absence in different ways.",
    },
    "jev/no-shared-mutable-default": {
      scope: "function",
      question: {
        instructions: {
          question: "Is this default parameter value created once and mutated per call, so one caller's state leaks into the next call?",
          inspect: "Compare each defaulted parameter's shared shape with the extracted per-call writes, whether the body clones before writing, and how many callers omit the argument in the supplied evidence.",
          focus: "Judge leakage through the shared default nobody passed, not mutation of caller-passed inputs.",
          decision_boundary: [
            "An object or array default with member writes, pushes, or Object.assign into the parameter, reached by callers that omit the argument, is strong evidence of a leaking default.",
            "A default that is only read, or cloned via spread, slice, Array.from, or structuredClone before any write, does not leak across calls.",
            "Callers that always pass the argument leave the shared default unreached, which weakens the claim even when writes exist.",
            "Primitive defaults and freshly constructed per-call values cannot carry state between calls.",
            "If the writes cannot reach the default or the omission pattern is unclear, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "A shared default object is written per call without a defensive copy while callers rely on the default by omitting the argument",
            remedy: "Clone the default before writing or construct a fresh value per call",
          },
          false: {
            what: "The default is only read, cloned before writing, never reached by omitting callers, or lacks enough evidence to establish leakage",
          },
        },
      },
      message: "This default value is shared across calls and mutated per call.",
    },

    "jev/no-blocking-event-loop-call": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this call block the single event loop inside a serving path, stalling every concurrent request for its duration?",
          inspect: "Compare each synchronous sink call with the function's serving context, the module's mitigation evidence, and the repository callers in the supplied evidence.",
          focus: "Judge whether the blocking call runs where concurrent requests are served, not whether a synchronous API appears at all.",
          decision_boundary: [
            "A synchronous I/O, crypto, or process call such as readFileSync or execSync inside a route handler or server callback is strong evidence of loop blocking.",
            "The same call inside a build script, CLI, migration, or test setup with no serving callers weakens the claim.",
            "An async variant, worker offload, or size cap already used for the same work weakens the claim.",
            "JSON parsing of a small closed literal and regex tests over bounded constants are not loop-blocking sinks.",
            "If the serving context or the blocking shape of the call cannot be established, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "A synchronous sink runs inside a serving path with no worker, async variant, or bound keeping it off the event loop",
            remedy: "Use the async variant, move the work to a worker, or bound the input so serving never blocks",
          },
          false: {
            what: "The call runs in a script or offline context, mitigation already keeps it off the loop, or the evidence does not establish serving reach",
          },
        },
      },
      message: "This call blocks the event loop inside a serving path.",
    },
    "jev/no-unguarded-async-init": {
      scope: "function",
      question: {
        instructions: {
          question: "Can this lazily initialized value be initialized twice under concurrent first use, because the in-flight attempt is not shared?",
          inspect: "Compare each memoize-on-empty guard and its awaited initialization with the in-flight sharing evidence, the binding scope, and the concurrent-entry callers in the supplied evidence.",
          focus: "Judge whether two concurrent first entries can both run the initializer, not whether lazy initialization appears at all.",
          decision_boundary: [
            "A memoize guard such as if (!conn) conn = await connect() reachable from concurrent handlers with no shared pending slot is strong evidence of double initialization.",
            "An in-flight promise slot that concurrent entries await before building weakens the claim.",
            "A pure, idempotent initializer with no observable side effects weakens the claim even when the guard shape matches.",
            "A function-local binding recreated on every entry cannot be shared and is not a single-flight smell.",
            "If concurrent first entry or the absence of sharing cannot be established, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "Concurrent first use can run the initializer twice because only the settled value is memoized and the pending attempt is not shared",
            remedy: "Store the in-flight promise and share it across concurrent entries until it settles",
          },
          false: {
            what: "The pending attempt is already shared, the initializer is side-effect free, the binding is per-entry, or concurrency is not established",
          },
        },
      },
      message: "This lazy initializer can run twice under concurrent first use.",
    },
    "jev/no-promise-combinator-mismatch": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this promise combinator discard work or failures the surrounding flow needs: fail-fast over legs whose partial results matter, or first-settled over legs needing cleanup?",
          inspect: "Compare the combinator choice with leg heterogeneity, per-leg capture, how the result is consumed downstream, and the cleanup evidence in the supplied evidence.",
          focus: "Judge whether the fail-fast or first-settled choice itself loses needed work, not whether a leg can fail.",
          decision_boundary: [
            "Promise.all over heterogeneous legs whose outcomes are consumed per leg, or over legs holding connections or locks, is strong evidence of a mismatch.",
            "Promise.race without cancellation or release of the losing legs is strong evidence of a mismatch when losers hold resources.",
            "Homogeneous reads consumed only as a complete tuple weaken the claim.",
            "Per-leg catch handlers, allSettled with status consumption, and abort or cleanup of losers weaken the claim.",
            "If downstream consumption or resource holding cannot be established, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "The combinator discards completed legs, per-leg outcomes, or losing legs that the flow still needs or must release",
            remedy: "Capture per-leg outcomes with allSettled or per-leg handlers, or cancel and release legs the winner does not need",
          },
          false: {
            what: "The legs are homogeneous, consumed only together, already captured per leg, or cleaned up on settle",
          },
        },
      },
      message: "This combinator discards leg work or failures the flow needs.",
    },
    "jev/no-orphaned-timer": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this timer keep firing or holding resources after its owning lifecycle ends, because no teardown releases it?",
          inspect: "Compare each timer creation with its stored handle, the clear or unref evidence, the module teardown, and the owner-creation callers in the supplied evidence.",
          focus: "Judge whether the schedule itself outlives its owner, not whether the callback is awaited or handled.",
          decision_boundary: [
            "A repeating timer created per request, connection, or render with no clearInterval in any teardown path is strong evidence of an orphaned timer.",
            "A stored handle cleared in dispose, close, unmount, or an effect cleanup weakens the claim.",
            "A one-shot timeout with unref in a short-lived script weakens the claim.",
            "An unstored handle that no teardown can reach strengthens the claim for repeating timers.",
            "If the owner lifecycle or the absence of teardown cannot be established, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "The timer schedule outlives its owner because no teardown path clears or unrefs its handle",
            remedy: "Store the handle and clear or unref it in the owner's dispose, close, or cleanup path",
          },
          false: {
            what: "A teardown path releases the handle, the timer is one-shot and unrefed, or the lifecycle evidence does not establish orphaning",
          },
        },
      },
      message: "This timer outlives its owner because no teardown releases it.",
    },
    "jev/no-unsynchronized-shared-memory": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this code share memory between workers without atomic access, so readers can observe torn or stale writes?",
          inspect: "Compare each shared-buffer view and its plain accesses with the Atomics evidence, the worker-sharing sites, and the message-passing alternative in the supplied evidence.",
          focus: "Judge cross-worker memory visibility, not single-thread module sharing.",
          decision_boundary: [
            "Plain indexed writes such as view[0] += 1 on a buffer posted to workers with no Atomics calls is strong evidence of unsynchronized sharing.",
            "Atomics load, store, wait, or notify on the shared view weakens the claim.",
            "A buffer written once during setup then used read-only weakens the claim.",
            "A message-passing alternative already coordinating the same data weakens the claim.",
            "If worker sharing or the absence of atomic access cannot be established, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "Workers share memory through plain reads and writes with no atomic coordination, exposing torn or stale values",
            remedy: "Access the shared view only through Atomics operations or coordinate the data with message passing",
          },
          false: {
            what: "Access is atomic, read-only after setup, confined to one thread, coordinated by messages, or worker sharing is not established",
          },
        },
      },
      message: "This shared memory is accessed across workers without atomic coordination.",

    },
    "jev/no-timezone-naive-arithmetic": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this date computation assume fixed-length days or local fields that shift under daylight saving and zone changes?",
          inspect: "Compare the naive date shapes, fixed day-step literals, ambiguous parses, and locale round-trips with the timezone-aware imports, sibling aware arithmetic, and repository callers in the supplied evidence.",
          focus: "Judge calendar semantics, not naming: a well-named constant can still be wrong across a DST boundary.",
          decision_boundary: [
            "Daily scheduling via date + 86400000 with user-facing times and no timezone-aware library on the path is strong evidence of drift.",
            "Millisecond arithmetic on monotonic durations never rendered as wall time weakens the claim.",
            "Temporal, luxon, or date-fns-tz arithmetic on the path weakens the claim.",
            "If no naive field access, fixed day step, ambiguous parse, or locale round-trip is established, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "The function shifts calendar dates with fixed-length steps or local-field arithmetic that drifts across DST and zone changes",
            remedy: "Compute the shift with a timezone-aware calendar API over the IANA zone of the rendered wall time",
          },
          false: {
            what: "Durations stay monotonic, a timezone-aware library covers the path, or no naive date shape is established",
          },
        },
      },
      message: "This date computation assumes fixed-length days that shift under daylight saving and zone changes.",
    },
    "jev/no-floating-money-arithmetic": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this monetary amount pass through binary floating arithmetic that accumulates representational error?",
          inspect: "Compare the money-named float operations and toFixed comparisons with the decimal-library import, minor-unit handling, sibling integer-cents usage, and repository callers in the supplied evidence.",
          focus: "Judge precision within one monetary identity, not whether distinct identities share a primitive.",
          decision_boundary: [
            "Accumulating total += price * qty over floats while sibling code carries integer cents is strong evidence of drift.",
            "Float arithmetic on already-rounded display values never fed back into balances weakens the claim.",
            "A decimal library or integer minor-unit arithmetic on the path weakens the claim.",
            "If no money-named floating operation is established, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "A monetary amount flows through binary floating operations whose representational error accumulates into balances",
            remedy: "Carry the amount in integer minor units or a decimal type and round only at display",
          },
          false: {
            what: "Amounts use integer minor units or a decimal type, floats stay display-only, or no money arithmetic is established",
          },
        },
      },
      message: "This monetary amount passes through binary floating arithmetic that accumulates error.",
    },
    "jev/no-offset-pagination-drift": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this listing paginate by offset over data that changes between pages, so items shift, repeat, or vanish?",
          inspect: "Compare the offset and limit parameters with the stable-ordering evidence, the unused cursor parameter, sibling cursor pagination, and writer callers in the supplied evidence.",
          focus: "Judge pagination stability across requests, not whether any single page validates.",
          decision_boundary: [
            "skip and take without orderBy over a table with concurrent writer callers is strong evidence of drift.",
            "Offset paging over an append-only, insertion-ordered log consumed once weakens the claim.",
            "A stable ordering key or cursor pagination on the path weakens the claim.",
            "If no offset-style pagination parameters are established, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "The listing windows mutable data by offset with no stable ordering key, so rows shift between fetches",
            remedy: "Page by a stable keyset cursor over a unique ordering column",
          },
          false: {
            what: "Pagination is cursor-based, the collection is append-only and consumed once, or no offset paging is established",
          },
        },
      },
      message: "This listing paginates by offset over changing data, so pages drift.",
    },
    "jev/no-unit-scale-mismatch": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this call mix unit scales the surrounding convention distinguishes, so the value is off by orders of magnitude?",
          inspect: "Compare the scale-factor conversions and unit-suffixed names with the named-conversion evidence and the sibling call-site arguments in the supplied evidence.",
          focus: "Judge scale against the callee convention, not identifier choice: the right binding in the wrong unit still drifts.",
          decision_boundary: [
            "Passing seconds to a timeoutMs parameter while sibling call sites pass milliseconds is strong evidence of mismatch.",
            "An explicit named conversion at the boundary weakens the claim.",
            "Scale factors applied consistently with the callee unit weaken the claim.",
            "If no scale conversion or unit-carrying argument is established, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "A value crosses a call boundary in a unit scale the callee convention does not expect, shifting it by orders of magnitude",
            remedy: "Convert explicitly at the boundary with a named helper and suffix the unit on the binding",
          },
          false: {
            what: "Units match the callee convention, a named conversion guards the boundary, or no scale mixing is established",
          },
        },
      },
      message: "This call mixes unit scales the surrounding convention distinguishes.",
    },
    "jev/no-truncating-numeric-parse": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this parse silently truncate or coerce input at the edges, so malformed input looks valid?",
          inspect: "Compare the parse shapes and radix evidence with the NaN and range guards, the external-input provenance, and sibling validated parsing in the supplied evidence.",
          focus: "Judge what the parse manufactures before any check runs, not whether a later check exists downstream.",
          decision_boundary: [
            "parseInt on request input compared numerically with no NaN guard is strong evidence of silent truncation.",
            "Parsing beside an explicit finite-and-range validation weakens the claim.",
            "Parsing closed constants with no external provenance weakens the claim.",
            "If no truncating parse shape is established, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "The parse cuts decimals, drops the radix, or coerces empty input to zero, manufacturing a valid-looking number",
            remedy: "Parse with an explicit radix and reject non-finite and out-of-range input before use",
          },
          false: {
            what: "The parse carries a radix with NaN and range validation, or the input is a closed constant rather than external",
          },
        },
      },
      message: "This parse silently truncates input at the edges, so malformed values look valid.",
    },
    "jev/no-locale-date-serialization": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this date cross a persistence or wire boundary in a locale-rendered form that cannot round-trip outside the writer locale?",
          inspect: "Compare the locale-rendered date forms with the boundary-sink evidence, the ISO-form presence, sibling ISO serialization, and repository callers in the supplied evidence.",
          focus: "Judge representation fidelity at the boundary, not model layering: perfect layering still loses the instant in a locale string.",
          decision_boundary: [
            "toLocaleString persisted to a timestamp column read by another service is strong evidence of a broken round-trip.",
            "Locale rendering at the final display component with ISO kept underneath weakens the claim.",
            "toISOString, epoch, or an explicit interchange format on the path weakens the claim.",
            "If no locale-rendered date form is established, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "A date reaches storage, a response, or a message payload as a locale-rendered string that loses the instant",
            remedy: "Serialize the instant as ISO 8601 or epoch at the boundary and render locale forms only for display",
          },
          false: {
            what: "The boundary carries ISO or epoch form, locale rendering stays display-only, or no locale date form is established",
          },
        },
      },
      message: "This date crosses a boundary in locale-rendered form and cannot round-trip.",
    },

    "jev/no-overload-resolution-ambiguity": {
      scope: "function",
      question: {
        instructions: {
          question: "Do these overload signatures admit the same call shape for different meanings, so callers cannot tell which behavior they get?",
          inspect: "Compare each overload's arity and parameter types, the ambiguous pairs and their overlapping positions, whether the implementation accepts every shape, separately named variants, and callers whose argument counts match more than one overload in the supplied evidence.",
          focus: "Judge whether one call shape can resolve to overloads with different meanings, not whether any single signature is long or complex.",
          decision_boundary: [
            "Overloads with the same arity and overlapping middle-parameter types, with callers matching two of them, are strong evidence of ambiguous resolution.",
            "Overloads distinguished by arity with every call site matching exactly one weaken the claim.",
            "Overloads differing only in return type while accepting identical arguments strengthen the claim.",
            "An implementation signature wider than every overload suggests callers already rely on unadvertised shapes.",
            "If callers consistently match exactly one overload or the set separates cleanly by arity, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "One call shape resolves to overloads with different meanings, leaving callers unable to tell which behavior runs",
            remedy: "Separate the variants into distinctly named functions or narrow the overload types so each call shape matches exactly one",
          },
          false: {
            what: "Each call shape matches exactly one overload, the set separates by arity, or no caller evidence shows dual matching",
          },
        },
      },
      message: "These overloads admit the same call shape for different meanings.",
    },
    "jev/no-sync-async-sibling-ambiguity": {
      scope: "function",
      question: {
        instructions: {
          question: "Do these same-stem siblings mix blocking and asynchronous behavior without naming the difference, so callers await what never suspends or block on what never resolves inline?",
          inspect: "Compare the candidate's async shape and suffix with each same-stem sibling's async shape, suffix, sync-I/O use, awaited versus bare uses, excerpts, and callers in the supplied evidence.",
          focus: "Judge whether the pair convention hides which member suspends, not whether one name alone reads well.",
          decision_boundary: [
            "An async member beside a synchronous same-stem member over disk or process I/O, used inconsistently by callers, is strong evidence of a hidden suspension difference.",
            "A consistently suffixed pair following the platform Sync and Async convention weakens the claim.",
            "A suffix that contradicts the behavior, such as an async member carrying Sync or a sync member carrying Async, strengthens the claim.",
            "Sync I/O inside the synchronous member of a serving path raises the cost of the confusion.",
            "If the pair follows a consistent suffix convention and callers handle each member accordingly, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "Same-stem siblings mix blocking and asynchronous behavior while the names hide which member suspends",
            remedy: "Name the difference explicitly with Sync and Async suffixes following the platform convention",
          },
          false: {
            what: "The pair follows a consistent suffix convention, both members share timing behavior, or callers handle each member accordingly",
          },
        },
      },
      message: "These same-stem siblings hide which member suspends.",
    },
    "jev/no-leaky-internal-export": {
      scope: "abstraction",
      question: {
        instructions: {
          question: "Does this barrel or index re-export internals its clients were never meant to depend on, widening the supported surface by accident?",
          inspect: "Compare each barrel re-export and its internal path or symbol markers with the owner module's internal documentation, which outside modules import the leaked symbols through the barrel, and the anchoring abstraction in the supplied evidence.",
          focus: "Judge whether the re-exported surface was meant for external dependence, not whether the barrel abstraction itself earns its keep.",
          decision_boundary: [
            "An export-all of an internal engine module with outside importers reaching engine helpers through the package root is strong evidence of a leak.",
            "A barrel re-exporting one documented utility alongside the public API with no internal markers weakens the claim.",
            "An owner module marked internal or private while the barrel still exposes it strengthens the claim.",
            "Test helpers, fixtures, or mocks reachable through the shipping barrel strengthen the claim.",
            "If no re-export carries internal markers or no outside importer reaches the symbols through the barrel, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "A barrel re-exports internal helpers its clients were never meant to depend on, freezing future refactors",
            remedy: "Remove the internal re-export from the barrel and import the helpers directly where they belong",
          },
          false: {
            what: "The re-exported surface is documented public API, carries no internal markers, or never reaches outside importers through the barrel",
          },
        },
      },
      message: "This barrel re-exports internals its clients were never meant to depend on.",
    },
    "jev/no-weak-crypto-primitive": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this code protect data with a hash or cipher the industry no longer accepts for that purpose?",
          inspect: "Compare each weak hash, HMAC, cipher, digest, or fallback-import call with its algorithm, the position it guards, whether the output feeds a stored comparison, the crypto import source, a stronger primitive nearby, and callers in the supplied evidence.",
          focus: "Judge the algorithm choice at an acknowledged crypto call for the purpose it serves, not the quality of the input sourcing.",
          decision_boundary: [
            "A password or token digest built with MD5 or SHA-1 and compared against a stored value is strong evidence of an unacceptable primitive.",
            "The same weak digest over a cache key or checksum that never guards a security decision weakens the claim.",
            "A pure-JavaScript MD5 or SHA-1 fallback import used where the platform crypto module is available strengthens the claim.",
            "A stronger primitive already used nearby for the same concept suggests the weak call is legacy rather than deliberate.",
            "If the digest never guards a security decision, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "Data is protected with a hash or cipher the industry no longer accepts for that purpose",
            remedy: "Replace the primitive with a currently accepted one such as SHA-256 or bcrypt for passwords and an authenticated cipher for encryption",
          },
          false: {
            what: "The digest serves a non-security checksum or cache key, the primitive is currently accepted, or no security decision depends on the output",
          },
        },
      },
      message: "This code protects data with a hash or cipher the industry no longer accepts.",

    },
    "jev/no-disabled-tls-verification": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this connection disable the identity check that makes the encrypted channel trustworthy?",
          inspect: "Compare each TLS bypass shape and its scope, the client imports, whether the option sits in test-only setup or a shipped request path, and the caller context in the supplied evidence.",
          focus: "Judge whether the flag voids transport trust on a real connection, not whether TLS options are configured at all.",
          decision_boundary: [
            "A rejectUnauthorized false flag on a client used from production handlers is strong evidence of disabled verification.",
            "The same flag inside a local-development-only harness never imported by shipped code weakens the claim.",
            "A process-wide TLS-reject override weakens further because it disables verification for every connection in the process.",
            "A checkServerIdentity override that skips verification voids the same guarantee as the boolean.",
            "If no bypass shape reaches a real connection, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "A connection disables certificate identity verification through a flag, an environment override, or an identity-check stub",
            remedy: "Remove the bypass, pin the expected certificate or CA in test harnesses, and scope any insecure flag to local-only setup",
          },
          false: {
            what: "Verification stays enabled, or the bypass lives only in test-only setup that shipped code never imports",
          },
        },
      },
      message: "This connection disables TLS identity verification.",
    },
    "jev/no-dynamic-code-execution": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this code compile text into behavior at runtime from a source no static reader can audit?",
          inspect: "Compare each eval, Function, or vm sink with the compiled text's source traced toward caller input or module constants, the literal-versus-flowing shape, and any fixed-function dispatch map in the supplied evidence.",
          focus: "Judge whether runtime compilation defeats static reading, not whether the surrounding code looks clever.",
          decision_boundary: [
            "An eval of a parameter arriving from a network handler is strong evidence of unauditable compilation.",
            "A Function constructor over string literals in a test helper keeps every behavior on the page and scores low.",
            "A closed template with no holes weakens the claim; a flowing identifier traced to request input strengthens it.",
            "A same-module registry of fixed functions that callers could use instead confirms the sink was a choice.",
            "If no eval, Function, or vm sink compiles text, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "Runtime text is compiled into behavior from a source callers can shape",
            remedy: "Replace the sink with a registry of fixed functions or a parser that never compiles caller text",
          },
          false: {
            what: "The compiled text is a closed constant, or no compilation sink is present",
          },
        },
      },
      message: "This code compiles runtime text into behavior.",
    },
    "jev/no-locale-blind-ordering": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this ordering use code-unit comparison for human-visible text, so sort order is wrong across locales?",
          inspect: "Compare each sort call and its comparator kind, the locale-awareness signals, the compared values' path toward user-visible surfaces, and sibling collator use in the supplied evidence.",
          focus: "Judge whether human-visible ordering ignores locale, not whether a comparator exists.",
          decision_boundary: [
            "A bare sort over user display names rendered in a list is strong evidence of locale-blind ordering.",
            "A collator or localeCompare with an explicit locale weakens the claim.",
            "A bare sort over ASCII identifiers used only for deterministic snapshot output scores low.",
            "A subtraction comparator orders numbers, not text; on string values it still ignores locale.",
            "If every ordering path uses a locale-aware comparator, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "Human-visible values are ordered by code-unit comparison without locale awareness",
            remedy: "Sort display text with Intl.Collator or localeCompare using the user's locale",
          },
          false: {
            what: "Ordering is locale-aware, numeric-only, or confined to internal deterministic output",
          },
        },
      },
      message: "This ordering compares human-visible text without locale awareness.",
    },

    "jev/no-cascading-fallback": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this fallback path depend on the same failing capability it replaces, so the failure cascades instead of degrading?",
          inspect: "Compare each primary call with the fallback calls in the same handler, their shared import roots, any static or cached return beside the fallback, and the repository callers in the supplied evidence.",
          focus: "Judge recovery topology: whether the fallback re-enters the same outage, not whether the error is described well.",
          decision_boundary: [
            "A catch block querying the same client, host, or pool the primary path just failed on is strong evidence of a cascading fallback.",
            "A fallback serving a cached, static, or reduced-scope result with no live dependency on the failed capability answers the question negatively.",
            "A fallback calling a genuinely independent replica or provider weakens the claim even when the call shape looks similar.",
            "If the primary and fallback capabilities cannot be shown to share a root, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "The fallback re-enters the same failing capability, turning one outage into a longer one",
            remedy: "Degrade to a cached or static result, or fail over to an independent capability with its own failure domain",
          },
          false: {
            what: "The fallback degrades without the failed capability or fails over to an independent one",
          },
        },
      },
      message: "This fallback depends on the same failing capability it replaces.",
    },
    "jev/no-silent-queue-drop": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this producer enqueue work with no handling for a full or unavailable queue, so load-shedding happens by accident?",
          inspect: "Compare each producer call with whether its pressure signal is awaited, consumed, or guarded, the drain and overflow policy in the module, the queue client source, and the repository callers in the supplied evidence.",
          focus: "Judge whether a bounded queue can refuse work silently, not whether enqueueing itself is appropriate.",
          decision_boundary: [
            "A fire-and-forget publish from a request path onto a bounded queue whose pressure return is never checked is strong evidence of a silent drop.",
            "An explicit overflow policy beside the call, such as blocking, dropping the oldest with a metric, or waiting for drain, answers the question negatively.",
            "An unbounded in-memory queue with no high-water policy still drops under memory pressure; name the missing bound when judging it.",
            "If the queue is unbounded by client semantics and the module bounds it elsewhere, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "Enqueued work can be refused or dropped with no signal the producer observes",
            remedy: "Observe the pressure signal: await it, branch on it, wait for drain, or declare an explicit overflow policy",
          },
          false: {
            what: "Pressure signals are observed, the queue is bounded with a stated policy, or drops cannot occur silently",
          },
        },
      },
      message: "This producer ignores queue pressure, so work can drop silently.",
    },
    "jev/no-missing-shutdown-drain": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this server start accepting work with no graceful shutdown path, so deploys cut in-flight requests mid-handling?",
          inspect: "Compare each bootstrap call with the close calls, signal handlers, drain waits, and connection tracking in the module, the orchestrator descriptor, sibling drain handlers, and the repository callers in the supplied evidence.",
          focus: "Judge whether the process can stop without abandoning work it already accepted, not whether startup is ordered well.",
          decision_boundary: [
            "A listen call in an orchestrator-managed service with no signal handler, close call, or drain wait in the module is strong evidence of a missing drain.",
            "A SIGTERM or SIGINT handler that marks unready, waits for tracked connections, then closes answers the question negatively.",
            "A one-shot script that never accepts external work abstains before reaching judgment; only serving bootstraps qualify.",
            "Sibling services owning drain handlers show the pattern is available; their absence next to a serving bootstrap strengthens the claim.",
          ],
        },
        criteria: {
          true: {
            what: "The server accepts work it cannot finish draining before the process exits",
            remedy: "Handle SIGTERM and SIGINT: mark unready, wait for tracked in-flight work, then close the server",
          },
          false: {
            what: "A signal handler drains tracked in-flight work before close, or the process accepts no external work to drain",
          },
        },
      },
      message: "This server accepts work with no graceful shutdown path.",
    },
    "jev/no-missing-health-signal": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this serving entry expose traffic endpoints but no health or readiness signal, so orchestrators cannot tell serving from stuck?",
          inspect: "Compare the serving surface with the health signals in the module, the readiness gate before serving, the probe path the deployment descriptor expects, sibling health signals, and the repository callers in the supplied evidence.",
          focus: "Judge the operational contract: a servable probe the orchestrator can call, not prose docs about the service.",
          decision_boundary: [
            "Traffic routes plus a bootstrap with async initialization, a descriptor expecting a probe path, and no such route in the module is strong evidence of a missing signal.",
            "A servable liveness or readiness endpoint, or an exported status function the platform invokes, answers the question negatively.",
            "A library module with no serving surface abstains before reaching judgment; only serving entries qualify.",
            "Readiness that depends on async init with no gate strengthens the claim; a gate that holds traffic until init completes weakens it.",
          ],
        },
        criteria: {
          true: {
            what: "Traffic is served with no probe telling the orchestrator whether the process is ready or stuck",
            remedy: "Serve liveness and readiness endpoints covering async initialization, matching the probe path the platform expects",
          },
          false: {
            what: "A servable health or readiness signal covers the serving surface, or the module serves no traffic",
          },
        },
      },
      message: "This serving entry exposes traffic but no health or readiness signal.",
    },
    "jev/no-deployment-coupled-assumption": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this code assume its deployment environment instead of receiving it, so it breaks outside the machine it was written on?",
          inspect: "Compare each environment assumption with the config reads in the module, the config sources in the repository, and the repository callers in the supplied evidence.",
          focus: "Judge whether the environment is baked into behavior, not whether a literal duplicates a config value the repository owns.",
          decision_boundary: [
            "A localhost URL, hardcoded port, absolute path, or environment-name branch with no config read for the same value is strong evidence of a coupled assumption.",
            "A documented local-dev fallback behind a config or environment read answers the question negatively.",
            "A value the deployment descriptor contradicts deserves suspicion; a value the descriptor confirms is still coupled but less likely to break.",
            "Test fixtures and local-only scripts may own their environment legitimately; judge whether shipped code carries the assumption.",
          ],
        },
        criteria: {
          true: {
            what: "Host, port, scheme, path, or environment identity is baked into shipped behavior instead of arriving through config",
            remedy: "Receive the value from the environment or config source, keeping any machine-specific literal as a documented local fallback",
          },
          false: {
            what: "The value arrives through config or the environment, or the literal is a documented fallback that shipped config overrides",
          },
        },
      },
      message: "This code assumes its deployment environment instead of receiving it.",

    },
    "jev/no-assertion-free-test": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this test exercise its subject without stating any expectation, so it cannot distinguish working from broken behavior?",
          inspect: "Use the extracted subject calls, the absence of assertion calls, whether the test name promises behavior no assertion covers, and the sibling assertion norm in the supplied evidence.",
          focus: "Judge whether the test pins any behavior of its subject, not whether the subject itself is documented or correct.",
          decision_boundary: [
            "A test that calls into its subject and ends, beside sibling tests asserting outcomes on the same subject, is strong evidence of an assertion-free test.",
            "A smoke test whose documented purpose is import-time crash detection states its only expectation implicitly; weigh the smoke shape against the missing assertion.",
            "Any expect, assert, matcher, or snapshot call on any path states an expectation even when the assertion is weak.",
            "A test with no subject call at all is not an assertion-free exercise of behavior; answer no.",
            "If the evidence cannot establish that the candidate is a test, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "The test exercises its subject but states no expectation, so passing proves only that nothing threw",
            remedy: "Assert the observable outcome the test name promises, following the sibling tests that pin the same subject",
          },
          false: {
            what: "The test states an expectation through an assertion, snapshot, or intentional smoke contract, or it exercises no subject",
          },
        },
      },
      message: "This test exercises its subject without stating any expectation.",
    },
    "jev/no-sleep-in-test": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this test wait a fixed duration for asynchronous work instead of awaiting a condition, making it slow when generous and flaky when tight?",
          inspect: "Use the extracted sleep calls with their literal durations, the polling helpers present in the test, whether the delay is itself the subject under test, and the sibling polling-helper files in the supplied evidence.",
          focus: "Judge whether the wait synchronizes on time rather than on the awaited condition, not whether the test touches async code at all.",
          decision_boundary: [
            "A fixed sleep before asserting an eventually-consistent outcome, with polling helpers used by sibling tests for the same condition, is strong evidence of a sleepy test.",
            "A small delay testing an actual debounce or throttle duration as the subject behavior is the behavior under test, not a synchronization sleep.",
            "A waitFor, eventually, or polling helper awaiting the condition bounds the wait even when a literal duration appears nearby as a timeout cap.",
            "A sleep with no literal duration or no assertion on async work after it deserves suspicion but is weaker evidence.",
            "If the evidence cannot establish a fixed-duration wait, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "The test synchronizes on elapsed time rather than on the awaited condition, so timing variance decides its outcome",
            remedy: "Await the condition with the polling helper the sibling tests use instead of sleeping a fixed duration",
          },
          false: {
            what: "The test awaits a condition, the delay is itself the asserted behavior, or no fixed-duration wait is established",
          },
        },
      },
      message: "This test waits a fixed duration instead of awaiting a condition.",
    },
    "jev/no-logic-in-test": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this test contain branches or loops that decide what to check, so the test can be wrong in the same way as the code it checks?",
          inspect: "Use the extracted branches and loops, whether assertions sit inside loop bodies or conditional arms, whether a data table enumerates independent cases, and the subject-predicate overlap in the supplied evidence.",
          focus: "Judge whether the test reimplements decisions instead of stating expectations, not whether the subject itself branches.",
          decision_boundary: [
            "A test branching on the same predicate as its subject before asserting is strong evidence of logic in the test.",
            "A data-driven table enumerating independent input and expected pairs with one assertion shape states cases linearly even when iteration runs them.",
            "Assertions inside loop bodies or conditional arms mean the check itself is conditional; weigh how much of the verdict the branch decides.",
            "A single guard that skips an environment-dependent test narrows but does not remove the branching; judge what remains.",
            "If the evidence cannot establish a branch or loop in the test, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "Branches or loops in the test decide what gets checked, so a defect in the shared decision hides in both",
            remedy: "Split the branches into linear tests or a data table with one assertion shape per enumerated case",
          },
          false: {
            what: "The test states each case linearly, the iteration only enumerates independent cases, or no test logic is established",
          },
        },
      },
      message: "This test decides what to check with branches or loops.",
    },
    "jev/no-mock-everything": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this test replace every collaborator including the behavior under test, so it verifies its own doubles rather than the subject?",
          inspect: "Use the extracted doubles with their targets, whether assertions check only mock interactions, whether any assertion checks real state or return values, and whether the doubles stay at true boundaries in the supplied evidence.",
          focus: "Judge whether real subject behavior survives under the doubles, not whether mocks exist at all.",
          decision_boundary: [
            "A test mocking the parser, the store, and the formatter, then asserting mock call order only, is strong evidence of a mock-everything test.",
            "One boundary mock for a clock, network, or filesystem with real logic asserted keeps the subject under test.",
            "An assertion on a return value or observable state computed by real code weighs against the proposition even when several doubles are present.",
            "A shared in-memory fake the repository owns is a seam, not a double that bypasses behavior; judge what the test still executes for real.",
            "If the evidence cannot establish any test double, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "Doubles stand in for the behavior under test and the assertions check only the scaffolding",
            remedy: "Keep doubles at true boundaries and assert on real state or return values the subject computes",
          },
          false: {
            what: "Real subject behavior is asserted, doubles stay at true boundaries, or no test double is established",
          },
        },
      },
      message: "This test verifies its own doubles rather than the subject.",
    },
    "jev/no-owned-module-mock": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this test replace a module the repository itself owns with a mock, rather than mocking at a genuine system boundary?",
          inspect: "Use the extracted module mocks with their specifiers, whether each target resolves to a repository file, whether the resolved file looks like a thin system-boundary adapter, and whether the remaining mocks stay at true boundaries in the supplied evidence.",
          focus: "Judge whether the mocked seam is owned behavior the test should execute for real, not whether mocks exist at all.",
          decision_boundary: [
            "A mock whose target resolves to a repository file holding behavior the test could execute is strong evidence of mocking an owned module.",
            "Mocks of bare specifiers, node builtins, clocks, network, or filesystem stay at genuine system boundaries and weigh against the proposition.",
            "An owned mock whose resolved file is a thin boundary adapter (network, clock, or storage names) is the correct seam; weigh it against the proposition.",
            "A mock whose target cannot be resolved against the repository cannot establish ownership; answer no on unknown targets alone.",
            "If the evidence cannot establish any static module-mock target, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "A double stands in for a module the repository owns, bypassing behavior the test should execute",
            remedy: "Mock at genuine system boundaries and let owned modules run for real, or promote the seam to an explicit boundary adapter",
          },
          false: {
            what: "Mocks stay at system boundaries, the owned target is a thin adapter, or no owned module mock is established",
          },
        },
      },
      message: "This test mocks a module the repository owns instead of mocking at a system boundary.",
    },
    "jev/no-duplicated-fixture-drift": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this test setup duplicate a fixture block maintained separately elsewhere, where the copies already disagree about what a valid fixture is?",
          inspect: "Use the extracted setup fingerprint, the matching copies with their locations, the field-level divergence points, and whether a shared factory exists in the supplied evidence.",
          focus: "Judge whether parallel copies encode different versions of the same fixture, not whether similar setups exist at all.",
          decision_boundary: [
            "Several setup blocks building the same entity with diverging required fields is strong evidence of fixture drift.",
            "Similar setups that intentionally vary the one field under test state distinct cases rather than drifting copies.",
            "A shared factory that some copies already use shows the seam exists; weigh whether this copy bypasses it.",
            "A single setup block with no matching copy elsewhere cannot drift; answer no.",
            "If the evidence cannot establish a duplicated fixture block, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "Parallel fixture copies encode different versions of the same valid entity and already disagree on its fields",
            remedy: "Route the setups through the shared factory, parameterizing only the field each test varies",
          },
          false: {
            what: "The setups intentionally vary the field under test, share one factory, or no duplicated fixture is established",
          },
        },
      },
      message: "This fixture duplicates a setup maintained elsewhere and the copies disagree.",
    },
    "jev/no-stale-feature-flag": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this feature flag no longer gate live behavior, so every reader still reasons through a dead arm?",
          inspect: "Compare each flag check with its arm shapes, the flag source hint and detail, the repository callers in the supplied evidence.",
          focus: "Judge whether the flag still selects live behavior per call or release, not whether a boolean parameter exists.",
          decision_boundary: [
            "A flag check with an empty arm, a constant return, or a removed-page arm while the flag source is bound to a constant is strong evidence of a stale flag.",
            "A flag read from live config or the environment with both arms carrying real behavior answers the question negatively.",
            "A boolean parameter selecting behavior per call belongs to mode-flag selection, not flag fossilization; answer no when the branch varies by argument.",
            "If neither arm is dead and the flag source still varies, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "A persistent flag gates behavior that no longer varies, yet every reader still pays for both arms",
            remedy: "Remove the dead arm and the flag check, keeping the live path as straight-line code",
          },
          false: {
            what: "The flag still selects live behavior, varies per call or release, or the evidence does not show a dead arm",
          },
        },
      },
      message: "This feature flag no longer gates live behavior, yet every reader still reasons through both arms.",
    },
    "jev/no-unlabeled-interactive-element": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this interactive element expose no accessible name, so assistive technology announces an unlabeled control?",
          inspect: "Compare each unlabeled element with its trigger kind, dynamic-children and title signals, the associated labels and design-system components in the module, and the repository callers in the supplied evidence.",
          focus: "Judge whether the control needs a name in context, not whether an icon-only shape merely looks suspicious.",
          decision_boundary: [
            "An icon-only button with an onClick handler in a shipped dialog and no label props is strong evidence of an unlabeled control.",
            "A hidden input, an aria-hidden control, or an input carrying a programmatic label from its associated control answers the question negatively.",
            "Dynamic children such as an icon component may still leave the announced name empty; judge the announced contract, not the visual one.",
            "If every interactive element carries an accessible name or is hidden from assistive technology, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "An exposed interactive control announces nothing while sighted users see its purpose",
            remedy: "Give the control an accessible name with visible text, aria-label, an associated label, or a design-system labeled component",
          },
          false: {
            what: "Controls are labeled, hidden from assistive technology, or carry programmatic labels from associated controls",
          },
        },
      },
      message: "This interactive element exposes no accessible name to assistive technology.",
    },
    "jev/no-unlocalized-user-string": {
      scope: "function",
      question: {
        instructions: {
          question: "Is this user-visible string baked into code with no internationalization path, so every new locale needs a code change?",
          inspect: "Compare each surfaced string and hand-rolled plural with the i18n signals in the function, the project i18n frameworks, and the repository callers in the supplied evidence.",
          focus: "Judge locale readiness of user-visible text, not whether a name reads well in one language.",
          decision_boundary: [
            "Hand-rolled plural logic or JSX copy in a checkout flow while the project already ships an i18n framework used by siblings is strong evidence of a locked-out locale.",
            "A developer-only assertion message in a project with no i18n surface answers the question negatively.",
            "A string already routed through t, formatMessage, or Intl weakens the claim even when sibling strings stay hard-coded.",
            "If no user-visible string reaches a surface, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "User-visible text is baked into code with no path to translation",
            remedy: "Route the string through the project's i18n framework with locale-aware plural and select formatting",
          },
          false: {
            what: "Surfaced text already passes through i18n, the strings are developer-only, or the project has no user-facing locale surface",
          },
        },
      },
      message: "This user-visible string is baked into code with no internationalization path.",
    },
    "jev/no-console-residue": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this debugging output sit in a shipped path, where it leaks internals to consoles and costs I/O per call?",
          inspect: "Compare each console call and debugger statement with the logger imports in the module, the debug comments beside the change, and the repository callers in the supplied evidence.",
          focus: "Judge whether the output belongs in the shipped path, not whether console output is ever legitimate.",
          decision_boundary: [
            "A console.log of a user record in a request handler where the module already imports a structured logger is strong evidence of residue.",
            "A console.error in a CLI entry reporting fatal startup failure answers the question negatively.",
            "Warn and error calls report operational failures; log, debug, info, and trace in shipped code deserve suspicion.",
            "Test files own their console output legitimately and never reach this judgment.",
          ],
        },
        criteria: {
          true: {
            what: "Debugging output rides the shipped path, leaking internals and spending I/O per call",
            remedy: "Remove the debugging output or route it through the module's structured logger at an appropriate level",
          },
          false: {
            what: "The output reports a genuine operational failure through the right channel, or the path is a CLI, script, or test that owns its console",
          },
        },
      },
      message: "This debugging output sits in a shipped path instead of a logger or nowhere.",
    },
    "jev/no-deep-happy-path-nesting": {
      scope: "function",
      question: {
        instructions: {
          question: "Is this function's nominal path buried under layers of nesting, so readers must simulate the whole staircase to find the normal outcome?",
          inspect: "Compare each return with its nesting depth and early-return marking, the else-chain count, the switch-dispatch signal, and the repository callers in the supplied evidence.",
          focus: "Judge whether the depth buries the nominal outcome or structures genuine alternatives, not whether the raw depth number is large.",
          decision_boundary: [
            "A main result computed inside nested elses with no early return, beside flattened siblings, is strong evidence of a buried nominal path.",
            "Deep nesting where each level genuinely scopes the alternatives, such as state-machine dispatch, answers the question negatively.",
            "Guard clauses that return early at shallow depth weaken the claim even when one deep path remains.",
            "If the nominal return sits at shallow depth, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "The normal outcome hides at the bottom of nested conditions while readers simulate every level",
            remedy: "Return early from guard clauses so the nominal path reads at shallow depth",
          },
          false: {
            what: "Nesting scopes genuine alternatives, guards already flatten the path, or the nominal outcome stays visible",
          },
        },
      },
      message: "This function's nominal path is buried under layers of nesting.",
    },
    "jev/no-drilled-prop": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this prop pass unchanged through components that never read it while the repository already provides a nearer state channel for the same value?",
          inspect: "Compare each forwarded prop with its reads in the component body, the forwarding depth, the available state channels, and sibling value reads in the supplied evidence.",
          focus: "Judge whether intermediate layers depend on data only the leaves consume, not whether prop passing appears at all.",
          decision_boundary: [
            "A prop forwarded under the same name through intermediates that never read it, while a context or store hook serves the same value to siblings, is strong evidence of invented drilling.",
            "Single-level passing to a direct child that consumes the value is ordinary composition.",
            "Genuinely per-level configurability, where an intermediate reads or transforms the value, answers the question negatively.",
            "If no nearer state channel exists in the repository, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "Intermediate components forward the value unread while a nearer shared state decision already serves it",
            remedy: "Read the value from the existing context or store channel at the consuming leaf",
          },
          false: {
            what: "Each layer consumes or shapes the value, the passing is single-level, or no nearer channel exists",
          },
        },
      },
      message: "This prop is drilled through layers that never read it.",
    },
    "jev/no-stale-comment": {
      scope: "comment",
      question: {
        instructions: {
          question: "Does this comment assert behavior the adjoining code no longer exhibits, so readers inherit instructions that contradict the implementation?",
          inspect: "Compare each extracted behavior claim with the adjoining code signals and the computed contradictions, and weigh which side of the diff changed in the supplied evidence.",
          focus: "Judge confident contradiction with the current implementation, not vagueness or redundancy.",
          decision_boundary: [
            "A numeric claim such as retry counts or named outcomes contradicted by the adjoined body is strong evidence of staleness.",
            "An edited body beside an untouched comment is the high-meaning shape; a freshly written comment beside fresh code weakens the claim.",
            "Vague prose broadly consistent with the body answers the question negatively.",
            "Accurate but redundant narration belongs to the narrating-comment rule, not this one.",
          ],
        },
        criteria: {
          true: {
            what: "The comment confidently describes behavior the current adjoining code contradicts",
            remedy: "Update the comment to describe the current behavior or remove it",
          },
          false: {
            what: "The comment is consistent with the body, merely redundant, honestly hedged, or too vague to contradict",
          },
        },
      },
      message: "This comment describes behavior the adjoining code no longer exhibits.",
    },
    "jev/no-paraphrased-sibling-logic": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this function compute what a neighboring helper already provides, spelled differently enough to evade textual matching?",
          inspect: "Compare the candidate signature with each matched helper signature, their textual dissimilarity, the fingerprint-gap signals, and shared callers in the supplied evidence.",
          focus: "Judge input and output equivalence plus helper existence, never text identity.",
          decision_boundary: [
            "Identical parameter and return shapes with a coexisting helper and interchangeable callers are strong evidence of one computation owned twice.",
            "High textual dissimilarity corroborates that whole-body fingerprinting cannot see the duplication; it is evidence of the gap, not of innocence.",
            "Similar-typed helpers whose edge-case behavior provably differs answer the question negatively.",
            "If the evidence does not establish equivalent inputs and outputs, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "A neighboring helper already provides the same computation under different spelling",
            remedy: "Delete the reimplementation and call the existing helper",
          },
          false: {
            what: "The helpers differ in inputs, outputs, or edge-case behavior, or equivalence is not established",
          },
        },
      },
      message: "This function reimplements a neighboring helper in different words.",
    },
    "jev/no-unclosed-handle": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this function acquire a releasable resource on a path that can exit without releasing it?",
          inspect: "Compare each acquisition with the releases in the function, early returns before any release, ownership transfer, and module release idioms in the supplied evidence.",
          focus: "Judge whether some execution leaks the handle, not whether acquisition syntax appears.",
          decision_boundary: [
            "An acquisition with early returns before any release and no ownership transfer is strong evidence of a leak.",
            "Returning the resource to the caller or registering it with a disposer transfers ownership and answers the question negatively.",
            "Acquisition immediately wrapped in a disposer or using construct weakens the claim.",
            "Framework-managed lifecycles where cleanup lives with the owner answer no.",
          ],
        },
        criteria: {
          true: {
            what: "Some exit path leaves an acquired file, connection, or lock handle unreleased with no ownership transfer",
            remedy: "Release the handle on every exit path or transfer ownership explicitly",
          },
          false: {
            what: "Every path releases the handle, ownership transfers to the caller or a disposer, or the lifecycle is framework-managed",
          },
        },
      },
      message: "This function can exit without releasing an acquired handle.",
    },
    "jev/no-bespoke-crypto-construction": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this function assemble a cryptographic construction from bitwise and arithmetic operations instead of calling a vetted primitive?",
          inspect: "Compare the bitwise operation shapes and byte-loop signals with the vetted imports, the absence of named primitive calls, and the security-bearing callers in the supplied evidence.",
          focus: "Judge whether security rests on unreviewed design rather than analysis.",
          decision_boundary: [
            "XOR and shift loops over bytes inside an encrypt, hash, or token function whose output is stored or compared is strong evidence of a bespoke construction.",
            "Non-security fingerprinting such as sharding or display hashes used likewise by siblings answers the question negatively.",
            "Calling a named vetted primitive for the security-bearing work weakens the claim even when bit manipulation appears nearby.",
            "If the output never guards a security decision, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "A hand-rolled cipher, hash, or token scheme carries security meaning without a vetted primitive",
            remedy: "Replace the construction with a vetted primitive from the platform or an established library",
          },
          false: {
            what: "The bit manipulation serves non-security purposes, a vetted primitive does the security work, or no security bearing is shown",
          },
        },
      },
      message: "This function hand-rolls cryptography instead of calling a vetted primitive.",
    },
    "jev/no-duplicated-style-object": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this style object repeat literal values a shared theme, token set, or style helper already owns?",
          inspect: "Compare the style object fingerprint with each cross-component match, the shared entries, the theme modules, and their adoption in the supplied evidence.",
          focus: "Judge whether visual evolution must be replayed per copy, not whether style literals appear.",
          decision_boundary: [
            "Byte-identical multi-key objects repeated across components beside an adopted theme are strong evidence of duplication.",
            "Objects sharing a few tokens with per-component differences in the exercised dimension answer the question negatively.",
            "Copies that already diverge about values weaken the claim toward ordinary variation.",
            "If no shared theme or token set exists, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "Literal style values repeat across components while a shared theme already owns them",
            remedy: "Move the values into the shared theme or tokens and consume them from each component",
          },
          false: {
            what: "The overlap is incidental, per-component differences are exercised, or no shared theme exists",
          },
        },
      },
      message: "This style object repeats literals a shared theme already owns.",
    },
    "jev/no-unmeasured-performance-machinery": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this caching, memoization, or batching layer carry no shown hotspot, benchmark, or invalidation policy, so readers maintain machinery that may optimize nothing?",
          inspect: "Compare each perf-machinery shape with the invalidation policy, the wrapped operation's cost, the perf evidence in the repository, and the callers in the supplied evidence.",
          focus: "Judge whether the machinery answers a demonstrated cost, not whether caching idioms look expert.",
          decision_boundary: [
            "A bespoke cache with no eviction policy around a cheap synchronous helper and no perf evidence in the repository is strong evidence of unmeasured machinery.",
            "Memoization beside a benchmark, a documented hotspot, or an explicit invalidation rule answers the question negatively.",
            "A useMemo over a genuinely expensive derived value with measured callers weakens the claim even when no benchmark file names it.",
            "If no caching, memoization, batching, or pooling shape appears, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "Performance machinery with no demonstrated hotspot, benchmark, or invalidation policy behind it",
            remedy: "Measure the hotspot first, then keep the layer only with an explicit invalidation and eviction policy",
          },
          false: {
            what: "The layer answers a demonstrated cost, carries an invalidation policy, or no perf machinery is present",
          },
        },
      },
      message: "This caching, memoization, or batching layer shows no hotspot, benchmark, or invalidation policy behind it.",
    },
    "jev/no-unmigrated-schema-change": {
      scope: "change",
      question: {
        instructions: {
          question: "Does this schema or model edit constrain stored or wire data more tightly while showing no migration, default, or reader-compatibility handling, so existing rows and old readers break?",
          inspect: "Compare each schema edit with the migrations and backfill or default handling in the same change, the repository migration precedent, and the coverage in the supplied evidence.",
          focus: "Judge whether existing stored data and old readers survive the edit, not whether the new shape reads well fresh.",
          decision_boundary: [
            "A new non-nullable field with no default and no migration in the same change, in a repository that migrates, is strong evidence of an unmigrated change.",
            "Additive nullable fields, or a full migration with backfill in the same change, answer the question negatively.",
            "A tightened validator beside dual-shape readers that accept both forms weakens the claim even when no migration file ships.",
            "If the change adds no required field, removes nothing, and narrows nothing, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "Stored or wire data constrained more tightly with no migration, default, or compatibility handling for existing rows",
            remedy: "Ship the migration with a default or backfill in the same change, or keep the edit additive until readers converge",
          },
          false: {
            what: "The edit is additive, migrations and backfill ship together, or readers already handle both shapes",
          },
        },
      },
      message: "This schema edit constrains stored data more tightly with no migration, default, or reader-compatibility handling.",
    },
    "jev/no-unconsumed-telemetry": {
      scope: "function",
      question: {
        instructions: {
          question: "Is this metric, log channel, or span emitted where nothing in the repository consumes it, so it adds volume and maintenance without informing any response?",
          inspect: "Compare each emission name with the in-repository consumers, the sibling emissions that feed live consumers, and the callers in the supplied evidence.",
          focus: "Judge whether the emission closes a loop to an alert, dashboard, query, or runbook, not whether instrumentation reads as diligence.",
          decision_boundary: [
            "A novel metric name emitted per request with zero in-repository consumers while sibling emissions feed alerts is strong evidence of unconsumed telemetry.",
            "Emission into a demonstrably consumed channel, with an alert or dashboard naming it, answers the question negatively.",
            "A span in a repository whose trace backend lives outside the diff weakens the claim, since consumption may be unobservable from the repository.",
            "If no metric, channel, or span emission appears, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "Telemetry emitted where no alert, dashboard, query, or runbook consumes it",
            remedy: "Wire the emission to a consumer that responds to it, or remove the emission",
          },
          false: {
            what: "The emission feeds a live consumer, siblings show the channel is watched, or consumption lives outside the observable repository",
          },
        },
      },
      message: "This telemetry is emitted where nothing in the repository consumes it.",
    },
    "jev/no-english-only-pluralization": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this user string branch quantity wording on English grammar while the repository locale reach requires plural rules, so a second locale renders wrong?",
          inspect: "Compare each plural branch over internationalization keys with the plural-rules usage, the project internationalization frameworks, the locale reach, and the callers in the supplied evidence.",
          focus: "Judge whether quantity wording follows locale plural rules, not whether the English rendering reads correctly.",
          decision_boundary: [
            "An English singular-or-plural test selecting between translation keys in a multi-locale repository whose siblings use framework plurals is strong evidence of English-only branching.",
            "Branching through Intl.PluralRules or a framework plural with a count option answers the question negatively.",
            "A single-locale product with no internationalization shelf never reaches this judgment; bare literal ternaries belong to unlocalized strings, not this rule.",
            "If no quantity branch over localized wording appears, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "Quantity wording branched on English grammar while the repository serves locales with different plural rules",
            remedy: "Route the quantity through Intl.PluralRules or the framework plural form with the count",
          },
          false: {
            what: "Plural rules already decide the form, the product serves one locale with no internationalization shelf, or no quantity branch exists",
          },
        },
      },
      message: "This user string branches quantity wording on English grammar instead of locale plural rules.",
    },
    "jev/no-duplicate-config-source": {
      scope: "change",
      question: {
        instructions: {
          question: "Does this change read configuration through a new channel while the repository already owns one, so precedence, validation, and documentation now live in two places?",
          inspect: "Compare each new config read with the owned config module, whether the new channel delegates to it, the owned-channel and direct-env user counts, and the coverage in the supplied evidence.",
          focus: "Judge whether configuration keeps one validated source of truth, not whether the new read returns the right value today.",
          decision_boundary: [
            "Fresh environment reads bypassing a typed config module every sibling uses, with no delegation, is strong evidence of a duplicate source.",
            "A new source that delegates to the owned module, or a build-time-only channel with no runtime overlap, answers the question negatively.",
            "A new read beside an owned module that no sibling imports weakens the claim, since no single source is established.",
            "If no new config read appears on the changed lines, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "Configuration read through a parallel channel that bypasses the owned, validated module",
            remedy: "Route the read through the owned config module, or promote the new channel into it with precedence documented",
          },
          false: {
            what: "The new channel delegates to the owned module, overlaps no runtime source, or no owned source exists to duplicate",
          },
        },
      },
      message: "This change reads configuration through a new channel while the repository already owns one.",
    },
    "jev/no-unowned-feature-flag": {
      scope: "change",
      question: {
        instructions: {
          question: "Does this new flag gate behavior with no named owner, tracked ticket, or expiry note, so no future reader can tell when it may be removed?",
          inspect: "Compare each new gate with its adjacent owner, ticket, and expiry annotations, the sibling flag lifecycle norms, and the coverage in the supplied evidence.",
          focus: "Judge whether the flag carries a removal story a future reader can execute, not whether gating itself is disciplined.",
          decision_boundary: [
            "A new widely-gated flag with no ticket or owner in a repository where sibling flags carry both is strong evidence of an unowned flag.",
            "A flagged rollout with a tracked ticket and a dated removal note answers the question negatively.",
            "A flag born beside an explicit experiment plan with an owner weakens the claim even when the expiry date is approximate.",
            "If no new flag gate appears, or the repository keeps no flag discipline to depart from, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "A newborn flag gating behavior with no owner, ticket, or expiry a future reader could act on",
            remedy: "Name the owner, link the tracking ticket, and note the expiry or removal condition beside the flag",
          },
          false: {
            what: "The flag carries a removal story, the repository keeps no flag norms, or no new gate is introduced",
          },
        },
      },
      message: "This new flag gates behavior with no named owner, tracked ticket, or expiry note.",

    },
    "jev/no-superseded-api-use": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this call use a member the owning module marks superseded while sibling code already uses the successor?",
          inspect: "Compare each member access on an imported binding with the deprecation note on that member in the resolved owner module and whether siblings invoke the named successor in the supplied evidence.",
          focus: "Judge whether the new code adopts the idiom the repository is leaving, not whether the member still works.",
          decision_boundary: [
            "A member carrying an explicit deprecation note naming a successor, while siblings call that successor on the same owner, is strong evidence of a stale idiom.",
            "A member deprecated without a named successor, or with no sibling precedent for any successor, is a weaker signal.",
            "Member accesses whose owner cannot be resolved, or with no deprecation note in the owner, do not establish supersession.",
            "Calls to the successor itself, or to members the owner never deprecates, answer the question negatively.",
            "If no deprecation note or successor use is established, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "The function calls a member the owner marks superseded while the repository already uses the successor",
            remedy: "Call the successor member the owner names and siblings already use",
          },
          false: {
            what: "The members carry no deprecation note, name no successor, or the repository shows no successor precedent",
          },
        },
      },
      message: "This call uses an API the owning module marks superseded.",
    },
    "jev/no-phantom-package-import": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this import name a package no manifest or workspace in the repository declares, so resolution can only fail?",
          inspect: "Compare each bare import specifier with the nearest manifest dependencies, lockfile entries, path aliases, and sibling imports of neighboring real packages in the supplied evidence.",
          focus: "Judge whether the specifier resolves anywhere in the repository, not whether the name sounds plausible.",
          decision_boundary: [
            "A bare specifier absent from every manifest and lockfile, with no alias mapping, is strong evidence of a hallucinated package.",
            "A specifier close in spelling to a real package siblings import widely is a likely typo rather than a real dependency.",
            "A monorepo-local specifier resolved by a path alias the resolver only partially expands weakens the claim.",
            "Relative imports, Node builtins, and manifest-declared packages answer the question negatively.",
            "If the manifest cannot be found or the specifier resolves through an alias, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "The import names a bare package nothing in the repository declares, maps, or locks",
            remedy: "Declare the real package in the manifest or correct the specifier to the intended module",
          },
          false: {
            what: "The specifier is relative, builtin, declared, locked, or resolved through a workspace alias",
          },
        },
      },
      message: "This import names a package no manifest in the repository declares.",
    },
    "jev/no-interaction-pinning-test": {
      scope: "function",
      question: {
        instructions: {
          question: "Do this test's decisive assertions pin the subject's internal interactions rather than its observable outcome?",
          inspect: "Compare the interaction assertions against call counts, argument shapes, and invocation order with the outcome assertions on return values and observable state, and whether the asserted interaction belongs to the subject's public contract in the supplied evidence.",
          focus: "Judge the assertion target, not the mocking: legitimate doubles with over-pinned interaction assertions still pin the implementation.",
          decision_boundary: [
            "Call-order or call-count assertions on spies of internal helpers, with no outcome assertion, are strong evidence of pinning.",
            "Interaction assertions alongside outcome assertions on a contract that genuinely promises the interaction, such as exactly-once delivery, are deliberate.",
            "Spies on collaborators at the system boundary used to observe an outcome weaken the claim.",
            "Outcome assertions on return values, exported state, or rendered output answer the question negatively.",
            "If no assertion establishes an interaction target distinct from the observable outcome, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "The test's decisive assertions pin internal call counts, arguments, or order while no assertion checks the observable outcome",
            remedy: "Assert the observable outcome and keep interaction assertions only for interactions the contract promises",
          },
          false: {
            what: "Outcome assertions carry the test, or the pinned interaction is part of the subject's promised contract",
          },
        },
      },
      message: "This test pins internal interactions instead of the observable outcome.",
    },
    "jev/no-single-use-dependency": {
      scope: "change",
      question: {
        instructions: {
          question: "Does this change add a dependency whose entire use is one trivial call site the platform or existing shelf already covers?",
          inspect: "Compare each added manifest entry with its import-site count across the repository, the distinct members used, and whether a platform equivalent or existing helper covers the same need in the supplied evidence.",
          focus: "Judge the capability gain against the install and audit cost, never dependency-ness in isolation.",
          decision_boundary: [
            "A new dependency with exactly one call site for a one-liner the platform provides is strong evidence of a trivial need.",
            "A growing call-site count, several distinct members used, or no platform equivalent weakens the claim.",
            "An added dependency with no import sites at all is unused rather than trivially used.",
            "A manifest change that adds no dependencies answers the question negatively.",
            "If the use sites or the platform comparison cannot be established, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "The change adds a dependency used once for a capability the platform or shelf already provides",
            remedy: "Use the platform equivalent or existing helper and drop the added dependency",
          },
          false: {
            what: "The dependency serves several sites, distinct members, or a capability nothing on the shelf provides",
          },
        },
      },
      message: "This change adds a dependency for a single trivial call site.",
    },
    "jev/no-second-shelf-dependency": {
      scope: "change",
      question: {
        instructions: {
          question: "Does this import provide a capability the repository's manifest and module norms already cover with a different library?",
          inspect: "Compare the imported package's capability with the manifest entries and sibling imports covering the same capability in the supplied evidence.",
          focus: "Judge whether one repository now pays two conventions for one job, not whether the new library works.",
          decision_boundary: [
            "Imports of a new date, HTTP, schema, logging, or identity library in a module whose siblings import the incumbent for the same operations are strong evidence of shelf duplication.",
            "A genuinely uncovered sub-capability the incumbent lacks, noted in the evidence, weakens the claim.",
            "A single library per capability, or an import outside any labeled capability, answers the question negatively.",
            "Migration diffs that move every site to the new library are consolidation, not duplication.",
            "If no second library covers the same capability, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "The import adds a second library for a capability the manifest and siblings already cover with another",
            remedy: "Use the incumbent library or migrate every site to the new one in a single change",
          },
          false: {
            what: "The capability is uncovered, the import consolidates every site, or only one library serves the capability",
          },
        },
      },
      message: "This import adds a second library for a capability the shelf already covers.",
    },
    "jev/no-repeated-test-preamble": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this test's setup block repeat fixture construction the module already owns in one shared helper or hook?",
          inspect: "Compare the normalized fingerprint of the test's leading setup statements with sibling tests sharing it, and whether a factory or beforeEach hook already performs the same construction and some siblings adopt it in the supplied evidence.",
          focus: "Judge whether fixture evolution must now be replayed per test, not whether the setup reads as thorough.",
          decision_boundary: [
            "Several tests sharing a long setup fingerprint beside an adopted factory or hook is strong evidence of a repeated preamble.",
            "Setups that differ per test in the exercised dimension are deliberate per-test arrangement, not repetition.",
            "A shared helper nobody adopts, or no sibling sharing the fingerprint, weakens the claim to a local choice.",
            "A test with no leading fixture construction answers the question negatively.",
            "If the setups differ in what they exercise or no helper owns the construction, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "The test repeats fixture construction siblings share while the module owns a factory or hook for it",
            remedy: "Build the fixture through the shared factory or hook instead of reconstructing it per test",
          },
          false: {
            what: "Each setup exercises a distinct dimension, no shared helper owns the construction, or the setup is unique",
          },
        },
      },
      message: "This test repeats fixture setup the module already owns once.",
    },

    "jev/no-unpinned-boundary-branch": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this branch decide a boundary value that no test or caller pins, so a plausible-but-wrong comparison here stays green?",
          inspect: "Compare each extracted boundary predicate with the test references, repository callers, transitive pinning chains, and related modules in the supplied evidence. A named transitive chain (test → seam → candidate) is one hop of test coverage reaching the function; weigh it against direct test references.",
          focus: "Judge the pinning gap, not whether the comparison is correct — correctness without a spec is undecidable, but an unpinned boundary is observable.",
          decision_boundary: [
            "A boundary comparison with callers reaching both sides and zero tests touching either side is strong evidence of an unpinned branch.",
            "A test that exercises a public seam which calls the function pins the boundary one hop away; weigh the named chain against direct test references.",
            "Tests asserting both sides of the boundary pin the decision even when the comparison looks unusual.",
            "Comparisons over internal counters or loop bounds with no domain meaning deserve less weight than tier, amount, or limit decisions.",
            "A single boundary arm with no evidence that callers ever reach the edge answers the question negatively.",
          ],
        },
        criteria: {
          true: {
            what: "A reachable boundary decision has no test pinning either side, so the suite cannot tell a wrong comparison from a right one",
            remedy: "Add tests asserting both sides of the boundary value",
          },
          false: {
            what: "Tests pin both sides of the boundary, callers cannot reach the edge, or the comparison carries no domain meaning",
          },
        },
      },
      message: "This boundary branch decides a value no test or caller pins.",
    },
    "jev/no-client-only-authorization": {
      scope: "function",
      question: {
        instructions: {
          question: "Is this access decision enforced only in client or routing code while the serving endpoint it protects shows no corresponding check?",
          inspect: "Compare each extracted client guard with the server signals, related modules, and repository callers in the supplied evidence.",
          focus: "Judge enforcement-layer placement, not whether the predicate points the right way — a correct predicate in the wrong layer still bypasses.",
          decision_boundary: [
            "A new route or component guard over a mutating endpoint whose handler performs no role read, while sibling endpoints do, is strong evidence of client-only enforcement.",
            "Defense-in-depth UI gating above an already-guarded handler answers the question negatively.",
            "Disabled buttons and hidden panels are presentation, never enforcement, when the endpoint itself is bare.",
            "If the evidence shows no server surface at all, answer no rather than guessing at an outside-the-repo backend.",
          ],
        },
        criteria: {
          true: {
            what: "The policy lives only in client or routing code while the serving path performs no matching role check, so direct callers bypass it",
            remedy: "Enforce the role check in the serving endpoint and keep the client guard as presentation only",
          },
          false: {
            what: "The server path already checks the claim, or no server surface is visible to judge against",
          },
        },
      },
      message: "This access decision is enforced only in client or routing code.",
    },
    "jev/no-check-then-act-race": {
      scope: "function",
      question: {
        instructions: {
          question: "Are this check and its dependent mutation separated by an await, so concurrent executions can invalidate the check before the mutation lands?",
          inspect: "Compare each extracted check with its intervening awaits, the later mutation on the same resource, the atomic signals, and the repository callers in the supplied evidence.",
          focus: "Judge whether the await gap lets a concurrent execution invalidate the checked condition, not whether the sequential logic reads correctly.",
          decision_boundary: [
            "An existence or ownership check, followed by an await, followed by a state-changing call on the same key with no atomic wrapper is strong evidence of a race.",
            "The same span wrapped in a transaction, compare-and-set, or single-flight the repo already uses answers the question negatively.",
            "Awaits that cannot yield to a concurrent writer of the same resource, such as pure local computation, weaken the claim.",
            "If the check and the mutation touch different resources, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "A check and its dependent mutation straddle an await on the same resource with no atomic guard, so overlap invalidates the check",
            remedy: "Guard the span with the repo's atomic primitive, transaction, or single-flight",
          },
          false: {
            what: "An atomic primitive covers the span, the gap cannot reach a concurrent writer, or check and mutation touch different resources",
          },
        },
      },
      message: "This check and its mutation are separated by an await on the same resource.",
    },
    "jev/no-non-idempotent-retry": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this retry repeat a state-changing operation that carries no idempotency identity, so a slow first attempt becomes two effects?",
          inspect: "Use each extracted retry span, its wrapped calls and mutating sinks, the idempotency signals, and the repository callers in the supplied evidence.",
          focus: "Judge repetition safety, not attempt policy — a bounded, backed-off retry of a keyless charge still duplicates.",
          decision_boundary: [
            "Bounded retries around a keyless charge, send, or publish whose endpoint supports keys per sibling usage is strong evidence of duplication risk.",
            "Retries over reads, or over writes carrying an idempotency key, request ID, or dedupe token, answer the question negatively.",
            "A callee contract one hop away that accepts or requires a key makes the absence meaningful; without such a contract, weigh the claim less.",
            "Pure read-only spans never reach this judgment.",
          ],
        },
        criteria: {
          true: {
            what: "A retry repeats a state-changing call with no idempotency identity, so a slow first attempt lands twice",
            remedy: "Attach an idempotency key, request ID, or dedupe token to the retried call",
          },
          false: {
            what: "The retried operation is read-only, carries an idempotency identity, or has no retry span at all",
          },
        },
      },
      message: "This retry repeats a state-changing operation with no idempotency identity.",
    },
    "jev/no-parallel-abstraction": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this module own a concept the repository already owns elsewhere, so one idea now has two addresses?",
          inspect: "Compare the module exports with each overlapping sibling's exports and shared vocabulary, the delegation signals, and the importing modules in the supplied evidence.",
          focus: "Judge concept duplication, not textual duplication — a re-expressed idea under prompt-flavored names still splits future changes across two addresses.",
          decision_boundary: [
            "A new module exporting the incumbent's concept under different names, with zero cross-references and a split caller base, is strong evidence of a parallel abstraction.",
            "A new module that delegates to or wraps the incumbent, such as a migration adapter, answers the question negatively.",
            "A new unit owning a named sub-capability the incumbent lacks is extension, not duplication.",
            "Shared generic vocabulary alone, without a shared domain concept, is insufficient.",
          ],
        },
        criteria: {
          true: {
            what: "A new module re-derives a repo-owned concept instead of reusing it, so changes must find both addresses",
            remedy: "Reuse the incumbent module or delegate to it from the new unit",
          },
          false: {
            what: "The new unit delegates to the incumbent, owns a distinct sub-capability, or shares only generic vocabulary",
          },
        },
      },
      message: "This module owns a concept the repository already owns elsewhere.",
    },
    "jev/no-misplaced-error-boundary": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this error boundary guard code whose callees cannot produce the caught failure while a neighboring fallible call sits outside it?",
          inspect: "Compare each extracted try block and its in-span calls with the caught kinds, the catch body, and the uncovered neighbor calls in the supplied evidence.",
          focus: "Judge whether the handling is addressed to the span that can actually fail, not whether handling exists at all.",
          decision_boundary: [
            "A caught kind no in-span callee produces, beside an uncovered neighbor that observably throws, is strong evidence of a misaddressed boundary.",
            "A boundary whose kinds match its in-span contracts, with the neighbor covered by its own documented policy, answers the question negatively.",
            "Catching a broad Error around genuinely fallible in-span calls is placement-correct even when a neighbor also throws elsewhere.",
            "If callee throw contracts are unknown, weigh the claim less rather than inferring failure modes.",
          ],
        },
        criteria: {
          true: {
            what: "Diligent handling guards an infallible span while the fallible neighbor goes uncovered, so the failure enters through the bare call",
            remedy: "Move the boundary to cover the fallible call or narrow the caught kinds to what the span produces",
          },
          false: {
            what: "Caught kinds match the in-span contracts, neighbors carry their own handling, or throw contracts are too uncertain to place blame",
          },
        },
      },
      message: "This error boundary guards the wrong span while a fallible neighbor sits outside it.",
    },

    "jev/no-rare-case-first": {
      scope: "function",
      question: {
        instructions: {
          question: "Does a shallow branch handle the rare case first and park the nominal outcome in else?",
          inspect: "Compare the first-branch test signals, the relative sizes of the two arms, and the function's callers in the supplied evidence.",
          focus: "Judge branch ORDERING at depth 1, not burial under nesting depth; guard clauses with no else are a different shape.",
          decision_boundary: [
            "A null, error, or empty test first with a substantially larger else arm exercised by most callers is strong evidence the common path waits.",
            "Arms with genuinely balanced likelihood answer the question negatively even when the first test names an edge case.",
            "Guard clauses that return early with no else are the preferred shape, not this smell.",
            "Nesting depth alone never decides; a deeply buried path belongs to another rule.",
          ],
        },
        criteria: {
          true: {
            what: "The first branch tests the exception while the rule readers need sits in else",
            remedy: "Test the nominal case first or return early on the rare case so readers meet the rule before the exception",
          },
          false: {
            what: "The arms are balanced, the first branch is the common path, or the shape is an early-return guard with no else",
          },
        },
      },
      message: "This branch handles the rare case first and parks the nominal outcome in else.",
    },
    "jev/no-side-effecting-conditional-expression": {
      scope: "function",
      question: {
        instructions: {
          question: "Does a conditional expression perform side effects or nest so deep that readers must execute it like statements?",
          inspect: "Compare each conditional arm's recorded calls and assignments, the nesting depth, and the statement-position logical chains in the supplied evidence.",
          focus: "Judge statement-position effects and nesting, not value selection; a flat ternary choosing between two pure values is not this smell.",
          decision_boundary: [
            "Mutating calls or assignments inside ternary arms, nesting two or more levels deep, are strong evidence readers must execute the expression.",
            "Statement-position && or || chains that invoke effects are the same smell in logical form.",
            "One flat ternary selecting between two pure values answers the question negatively.",
            "Data-mapping branches a lookup could replace belong to another rule even when written as a ternary.",
          ],
        },
        criteria: {
          true: {
            what: "Conditional or logical expression arms perform effects or nest so deep the expression reads as hidden statements",
            remedy: "Rewrite the selection as explicit statements or split nested choices into named steps",
          },
          false: {
            what: "Every conditional is a flat selection between pure values with no statement-position effects",
          },
        },
      },
      message: "This conditional expression performs side effects or nests so deep it reads like statements.",
    },
    "jev/no-unexplained-complex-condition": {
      scope: "function",
      question: {
        instructions: {
          question: "Does one boolean expression combine so many operators that no reader can hold it, with no local name explaining any part?",
          inspect: "Compare the operator counts and depth of each recorded condition with the extracted boolean locals in the supplied evidence.",
          focus: "Judge ONE expression and its missing explanatory names, not a patchwork of special-case branches.",
          decision_boundary: [
            "Six or more clauses in one test with zero extracted boolean locals is strong evidence no reader can hold the condition.",
            "Three clauses already grouped behind one explanatory local weaken the claim toward adequate decomposition.",
            "Two-clause tests with an obvious single idea answer the question negatively.",
            "A collection of special-case branches belongs to another rule; this rule needs one dense expression.",
          ],
        },
        criteria: {
          true: {
            what: "A single dense condition carries the whole decision with no explanatory variable naming any part",
            remedy: "Extract explanatory boolean locals that name each clause of the decision",
          },
          false: {
            what: "Each condition is small, already decomposed into named parts, or the complexity lives across branches rather than one expression",
          },
        },
      },
      message: "This boolean expression combines many operators with no local name explaining any part.",
    },
    "jev/no-clever-expression": {
      scope: "function",
      question: {
        instructions: {
          question: "Does an expression use expert-only idioms that force readers to decode mechanics before intent?",
          inspect: "Compare each recorded finding, its idiom kind, and the surrounding function in the supplied evidence.",
          focus: "Judge idiom cleverness only; narrow expression shapes owned by other rules are not this smell.",
          decision_boundary: [
            "Assignment inside a test combined with bitwise defaults no comment explains is strong evidence of decoding-before-intent.",
            "Comma sequences, chained assignment, and bitwise tricks on non-bitwise domains each force mechanical decoding.",
            "One conventional idiom used consistently in the file, such as boolean coercion, answers the question negatively.",
            "If the idiom is the module's established convention, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "An expert-only idiom hides the intent behind mechanics readers must decode first",
            remedy: "State the intent directly with separate statements, named values, or plain comparisons",
          },
          false: {
            what: "The expressions use only plain comparisons, calls, and conventional idioms the module already shares",
          },
        },
      },
      message: "This expression uses expert-only idioms that force readers to decode mechanics before intent.",
    },

    "jev/no-hand-rolled-group-by": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this grouping helper reimplement Object.groupBy or Map.groupBy with no demonstrated need for its differences?",
          inspect: "Compare the grouping loop and accumulator writes with the key normalization, Map identity use, target constraint comments, and repository callers in the supplied evidence.",
          focus: "Judge whether the local copy is gratuitous or justified by key semantics, engine targets, or caller-relied behavior the platform cannot express.",
          decision_boundary: [
            "A plain string-key group on modern engines with no key normalization and no comment is strong evidence of a gratuitous reimplementation.",
            "Composite or custom-collapsed keys, a Map with identity semantics the call sites rely on, or a comment citing a sub-ES2024 target weaken the claim toward justified.",
            "Grouping loops alone are insufficient; the accumulator-write shape must show key-indexed collection building.",
            "jev/no-duplicated-logic scores duplication against another repository function; this scores duplication against the shared platform and needs no repository match.",
            "If the evidence does not establish a grouping shape or the justification side is unresolved, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "The function rebuilds platform grouping with plain keys while engines admit the platform form and no justification is shown",
            remedy: "Use Object.groupBy or Map.groupBy, or document the key semantics or target constraint that forces the local copy",
          },
          false: {
            what: "The grouping needs custom keys, identity semantics, an older target, or the evidence does not establish a grouping shape",
          },
        },
      },
      message: "This grouping helper reimplements platform grouping without a demonstrated need.",
    },
    "jev/no-hand-rolled-deep-clone": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this copy routine reimplement structuredClone with no demonstrated need for its differences?",
          inspect: "Compare the JSON round-trip or recursive type-branching shape with the prototype, function, and reviver preservation signals, the lossy-tradeoff comment, and repository callers in the supplied evidence.",
          focus: "Judge whether the local copy is gratuitous or justified by class instances, function preservation, or a named lossy tradeoff the callers accept.",
          decision_boundary: [
            "A JSON round-trip applied to state holding Date, Map, Set, or undefined values is strong evidence of a gratuitous reimplementation.",
            "Class instances needing a reviver, function-prototype preservation, or a comment naming the lossy tradeoff weaken the claim toward justified.",
            "A single JSON.stringify for serialization or logging without a parse-back copy is not a clone shape.",
            "jev/no-duplicated-logic scores duplication against another repository function; this scores duplication against the shared platform and needs no repository match.",
            "If the evidence does not establish a copy shape or the preserved semantics are unresolved, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "The routine copies structured state the platform clones natively while dropping semantics no caller accepts losing",
            remedy: "Use structuredClone, or document the preservation semantics that force the local copy",
          },
          false: {
            what: "The copy preserves prototypes, functions, or custom semantics, names its lossy tradeoff, or lacks a clone shape",
          },
        },
      },
      message: "This copy routine reimplements structuredClone without a demonstrated need.",
    },
    "jev/no-hand-rolled-set-ops": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this loop reimplement dedupe, intersection, or difference that Set expresses directly, with no custom equality doing real work?",
          inspect: "Compare the loop excerpts and membership checks with the comparator signals and repository callers in the supplied evidence.",
          focus: "Judge whether the membership test is plain identity a Set covers or domain equality the call sites demonstrably need.",
          decision_boundary: [
            "Primitive dedupe by identity with no comparator in sight is strong evidence of a gratuitous reimplementation.",
            "Dedupe by a domain key function, epsilon or ordering-sensitive comparison, or lazy-generator consumption the call sites demonstrate weaken the claim toward justified.",
            "Loops with membership checks but no collected result are iteration, not set operations.",
            "jev/no-duplicated-logic scores duplication against another repository function; this scores duplication against the shared platform and needs no repository match.",
            "If the evidence does not establish a dedupe, intersection, or difference shape, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "The loop rebuilds identity-based set semantics the platform expresses directly with no custom equality at work",
            remedy: "Use Set dedupe, intersection, or difference, or document the domain equality that forces the local loop",
          },
          false: {
            what: "A domain comparator does real work, callers need lazy consumption, or no set-operation shape is established",
          },
        },
      },
      message: "This loop reimplements set semantics the platform expresses directly.",
    },
    "jev/no-hand-rolled-flatten": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this recursion reimplement Array.flat or flatMap with no demonstrated need for its differences?",
          inspect: "Compare the self-recursive concat shape and depth parameter with the depth-cap meaning, hole handling, lazy iteration, and repository callers in the supplied evidence.",
          focus: "Judge whether the recursion is plain full-depth flattening or carries domain semantics the platform form cannot express.",
          decision_boundary: [
            "Unbounded full-depth flattening of plain nested arrays is strong evidence of a gratuitous reimplementation.",
            "Depth caps with domain meaning, sparse or hole handling the callers rely on, or lazy iteration over a large structure weaken the claim toward justified.",
            "Array checks without concatenation or recursion are traversal, not flattening.",
            "jev/no-duplicated-logic scores duplication against another repository function; this scores duplication against the shared platform and needs no repository match.",
            "If the evidence does not establish a flattening shape or the extra semantics are unresolved, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "The recursion flattens plain nested arrays with semantics Array.flat already provides and no demonstrated extra need",
            remedy: "Use Array.flat or flatMap, or document the depth, hole, or laziness semantics that force the local recursion",
          },
          false: {
            what: "Depth caps, hole handling, or laziness carry caller-relied meaning, or no flattening shape is established",
          },
        },
      },
      message: "This recursion reimplements Array.flat without a demonstrated need.",
    },
    "jev/no-hand-rolled-deep-equal": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this comparison routine reimplement a deep-equality capability the repository already owns, with no demonstrated need for its differences?",
          inspect: "Compare the key-length check, key iteration, and recursive call shape with the owned capability facts, the domain comparator signals, the zero-dependency footprint, and repository callers in the supplied evidence.",
          focus: "Judge whether the local compare is gratuitous beside an owned capability or justified by domain comparison semantics or a sustained zero-dependency footprint.",
          decision_boundary: [
            "A full recursive structural compare beside an installed deep-equal dependency or an existing node:assert or util import with no options is strong evidence of a gratuitous reimplementation.",
            "A domain comparator such as numeric epsilon, key subsets, or order-insensitivity exercised by callers, or a zero-dependency footprint the manifest sustains, weakens the claim toward justified.",
            "Shallow field comparisons without recursion are not deep equality.",
            "jev/no-duplicated-logic scores duplication against structural similarity to another repository function; this scores duplication against a declared dependency or platform module evidenced by manifest and import facts.",
            "If the evidence does not establish a recursive structural-compare shape, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "The routine rebuilds structural comparison an owned dependency or platform module already provides with no demonstrated extra need",
            remedy: "Use the owned deep-equal capability, or document the domain comparison semantics that force the local routine",
          },
          false: {
            what: "Domain comparison semantics do real work, the footprint is intentionally dependency-free, or no recursive compare shape is established",
          },
        },
      },
      message: "This comparison routine reimplements an owned deep-equality capability.",
    },

    "jev/no-hand-rolled-schema-check": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this validator reimplement a schema capability an installed dependency already owns, with no demonstrated need for its differences?",
          inspect: "Compare the typeof checks, required-field loops, and error accumulation with the owned validator, its sibling importers, the custom error shape, and the repository callers in the supplied evidence.",
          focus: "Judge whether the local copy is gratuitous beside an owned validator, not whether validation exists.",
          decision_boundary: [
            "Multi-field object validation with error lists in a repo where siblings import the installed validator is strong evidence of a gratuitous copy.",
            "A single-field check at one call site answers the question negatively.",
            "A custom error shape pinned by an API contract weakens the claim when callers depend on that shape.",
            "If no validator dependency is installed, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "The function reimplements schema validation the repo already pays for without a demonstrated semantic gap",
            remedy: "Express the schema with the installed validator and remove the hand-rolled copy",
          },
          false: {
            what: "The check is trivially small, carries a pinned contract the validator cannot express, or no validator is installed",
          },
        },
      },
      message: "This validator reimplements a schema capability an installed dependency already owns.",
    },
    "jev/no-hand-rolled-retry-loop": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this retry loop reimplement an installed retry dependency with no demonstrated need for its differences?",
          inspect: "Compare the loop, delay, attempt counting, and jitter signals with the owned retry dependency, its sibling importers, and the repository callers in the supplied evidence.",
          focus: "Judge whether the local loop is gratuitous beside an owned retry capability.",
          decision_boundary: [
            "A backoff loop with jitter beside an installed retry dependency the siblings use is strong evidence of a gratuitous copy.",
            "A single call site with a short loop and trimmed semantics answers the question negatively.",
            "Per-attempt side effects the dependency API cannot thread weaken the claim.",
            "If no retry dependency is installed, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "The function reimplements retry machinery the repo already pays for without a demonstrated semantic gap",
            remedy: "Use the installed retry dependency and remove the hand-rolled loop",
          },
          false: {
            what: "The loop is minimal with trimmed semantics, carries side effects the dependency cannot model, or no retry dependency is installed",
          },
        },
      },
      message: "This retry loop reimplements an installed retry dependency.",
    },
    "jev/no-hand-rolled-concurrency-limit": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this limiter reimplement an installed concurrency dependency with no demonstrated need for its differences?",
          inspect: "Compare the active counter, waiting queue, and acquire-release signals with the owned limiter dependency, its sibling importers, and the repository callers in the supplied evidence.",
          focus: "Judge whether the local limiter is gratuitous beside an owned width-control capability.",
          decision_boundary: [
            "A counter-queue limiter while the manifest holds a limiter used elsewhere is strong evidence of a gratuitous copy.",
            "Release semantics tied to a domain resource with health checks the dependency cannot model answer the question negatively.",
            "A plain counter without a waiting queue is not a limiter by itself.",
            "If no limiter dependency is installed, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "The function reimplements width control the repo already pays for without a demonstrated semantic gap",
            remedy: "Use the installed concurrency limiter and remove the hand-rolled copy",
          },
          false: {
            what: "The control models domain resource semantics the dependency lacks, or no limiter is installed",
          },
        },
      },
      message: "This limiter reimplements an installed concurrency dependency.",
    },
    "jev/no-hand-rolled-debounce": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this timing wrapper reimplement debounce semantics an installed dependency already owns, with generality its callers do not exercise?",
          inspect: "Compare the timer-reset shape and leading, trailing, max-wait, cancel, and flush options with the owned dependency, the caller count, and the exercised options in the supplied evidence.",
          focus: "Judge whether the local wrapper is gratuitous beside an owned debounce capability.",
          decision_boundary: [
            "A full leading, trailing, and max-wait wrapper with one call site using defaults beside an installed dependency is strong evidence of a gratuitous copy.",
            "A short inline timer at a single call site answers the question negatively.",
            "Timer identity semantics the dependency cannot provide weaken the claim.",
            "If no debounce-capable dependency is installed, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "The function reimplements debounce capability the repo already pays for without a demonstrated semantic gap",
            remedy: "Use the installed debounce dependency and remove the hand-rolled wrapper",
          },
          false: {
            what: "The timer is a minimal inline form, carries identity semantics the dependency lacks, or no debounce dependency is installed",
          },
        },
      },
      message: "This timing wrapper reimplements debounce an installed dependency already owns.",
    },
    "jev/no-hand-rolled-csv-split": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this row splitter reimplement an installed CSV dependency with no demonstrated flat-shape safety?",
          inspect: "Compare the row split, cell split, and header-index mapping with the owned CSV dependency, its sibling importers, quote handling, and the input provenance in the supplied evidence.",
          focus: "Judge whether naive splitting is gratuitous beside an owned parser.",
          decision_boundary: [
            "Naive splitting of user-supplied content beside an installed parser is strong evidence of a gratuitous copy.",
            "A provably flat machine-generated shape with a test pinning no quotes at a single call site answers the question negatively.",
            "Quote handling in the local code weakens the claim toward a deliberate tradeoff.",
            "If no CSV dependency is installed, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "The function reimplements CSV parsing the repo already pays for without demonstrated input safety",
            remedy: "Parse with the installed CSV dependency and remove the hand-rolled splitter",
          },
          false: {
            what: "The input is provably flat with pinned tests, or no CSV dependency is installed",
          },
        },
      },
      message: "This row splitter reimplements an installed CSV dependency.",
    },

    "jev/no-nested-conditional-expression": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this function's decisive logic hide inside nested conditional expressions that force readers to simulate the evaluator?",
          inspect: "Compare each conditional and logical site with its return or JSX position, nesting depth, chain length, changed-line overlap, and the named-boolean bindings in the supplied evidence.",
          focus: "Judge whether a reader must mentally evaluate nested branches to follow the decision, not whether any conditional appears.",
          decision_boundary: [
            "Conditional expressions nested inside one another in a return or render position are strong evidence of hidden decisive logic.",
            "A single conditional over well-named boolean bindings answers the question negatively.",
            "Long logical chains in return positions corroborate the claim when no intermediate name explains each step.",
            "If the evidence shows no conditional expression in a decisive position, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "Decisive branching is packed into nested conditional expressions or long unnamed logical chains in a return or render position",
            remedy: "Name each intermediate condition and flatten the decision into early returns or a lookup",
          },
          false: {
            what: "The decision reads through named booleans, flat guards, or conditionals outside decisive positions",
          },
        },
      },
      message: "This function's decisive logic hides inside nested conditional expressions.",
    },
    "jev/no-unexplained-behavioral-literal": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this function repeat a behavior-steering value across sites that must stay in sync, with no name holding them together?",
          inspect: "Weigh each steering literal with its comparison, equality, or arithmetic position and the other-side binding name, the coupling facts naming the co-sites that must agree, and the named constants in the supplied evidence.",
          focus: "Judge the drift hazard of recurrence-with-agreement, not the occurrence of any single literal. Emptiness checks, typeof guards, and closed-set flag equality never reach you; they are structural idioms, not evidence.",
          decision_boundary: [
            "The same value recurring across sites that must agree — a constant with its derived N / length-N / slice(0,N) forms — and no named constant is strong evidence of drift hazard.",
            "A one-off bare steering literal with no named constant is weaker evidence; judge whether a reader can tell what the value means without guessing.",
            "Loop index arithmetic and values bound to named constants answer the question negatively.",
            "If the evidence shows no behavior-steering literal, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "A behavior-steering value recurs across coupled sites that must agree, or steers solo, as bare literals no name explains",
            remedy: "Bind each shared steering value to one named constant used at every co-site",
          },
          false: {
            what: "The literals are named, incidental arithmetic, idiom abstentions, or absent from steering positions",
          },
        },
      },
      message: "This function steers behavior with literals no name in scope explains; recurring values couple sites that must stay in sync.",
    },
    "jev/no-shadowed-meaning": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this function reuse a visible outer name for a different meaning, so readers carry the wrong assumption into the inner scope?",
          inspect: "Compare each shadowing pair's inner role with the outer import, module, or enclosing binding, including both type texts in the supplied evidence.",
          focus: "Judge whether the same name denotes different things across the boundary, not whether any redeclaration appears.",
          decision_boundary: [
            "A parameter or local sharing an imported or module-level name with a different type is strong evidence of a shadowed meaning.",
            "Conventional catch bindings and same-meaning refinements answer the question negatively.",
            "An inner binding whose type text matches the outer one weakens the claim even when the declaration repeats.",
            "If the evidence shows no shadowing pair, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "An inner binding reuses an outer name for a different meaning a reader would confuse",
            remedy: "Rename the inner binding so each name denotes one thing in every visible scope",
          },
          false: {
            what: "The repeated name keeps the same meaning, follows convention, or no shadowing occurs",
          },
        },
      },
      message: "This function reuses a visible outer name for a different meaning.",
    },
    "jev/no-oversized-working-set": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this function force readers to track more live values than its outcome requires?",
          inspect: "Compare the total binding inventory with the maximum concurrently live values, the longest feed chain, and each binding's use count in the supplied evidence.",
          focus: "Judge whether interleaved values overload working memory, not whether the function is long.",
          decision_boundary: [
            "Many simultaneously live values with no feed chain between them are strong evidence of an oversized working set.",
            "A long single-pipeline transform where each value feeds the next answers the question negatively.",
            "Parameters and locals each used once in order weaken the claim even when the inventory is large.",
            "If the evidence shows only a handful of tracked values, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "Interleaved live values exceed what the outcome's data flow requires readers to hold",
            remedy: "Split the function along its data flows or thread values through a pipeline so each step needs few live names",
          },
          false: {
            what: "The values form one pipeline, stay few, or the inventory does not establish interleaved tracking",
          },
        },
      },
      message: "This function forces readers to track more live values than its outcome requires.",
    },

    "jev/no-hand-rolled-date-format": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this date assembly reimplement Intl.DateTimeFormat with no demonstrated need for pinned output?",
          inspect: "Compare the extracted date-part reads and separator assembly with the pinned-output signals, the Intl shelf elsewhere in the repository, and the repository callers in the supplied evidence.",
          focus: "Judge whether the local assembly is gratuitous locale machinery or a pinned format a contract depends on.",
          decision_boundary: [
            "A user-visible date built from getFullYear, getMonth, and getDate with padStart and separators, while no snapshot or wire contract pins the exact string, is strong evidence of reimplemented locale machinery.",
            "A snapshot, golden file, or wire-format assertion on the exact string answers the question negatively, as does a non-Gregorian or custom calendar Intl cannot express.",
            "Output already routed through Intl.DateTimeFormat weakens the claim even when part reads remain nearby.",
            "If the evidence does not establish user-facing display versus a pinned serialized form, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "The function assembles display dates from parts while no contract pins the exact output",
            remedy: "Format the date with Intl.DateTimeFormat or pin the wire format explicitly with a round-trip test",
          },
          false: {
            what: "A snapshot or wire contract pins the exact string, the calendar is beyond Intl, or the display versus serialized position is unclear",
          },
        },
      },
      message: "This date assembly reimplements Intl.DateTimeFormat without a pinned-output need.",
    },
    "jev/no-hand-rolled-relative-time": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this time-ago ladder reimplement Intl.RelativeTimeFormat with no demonstrated need for its exact copy?",
          inspect: "Compare the extracted time-unit ladder and diff signals with the pinned-copy signals, the Intl shelf elsewhere in the repository, and the repository callers in the supplied evidence.",
          focus: "Judge whether the English-only ladder serves locales Intl could serve, or product copy a contract pins.",
          decision_boundary: [
            "An English-only minute, hour, day, and week ladder in a product serving several locales, with no copy contract, is strong evidence of reimplemented relative-time machinery.",
            "Product copy pinned by tests, such as yesterday versus 1 day ago, or brand plural rules Intl gets wrong, answers the question negatively.",
            "Output already routed through Intl.RelativeTimeFormat weakens the claim even when unit literals remain nearby.",
            "If the evidence does not establish the locale reach or the copy contract, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "The function ladders time units into hard-coded copy with no pinned-copy justification",
            remedy: "Render relative time with Intl.RelativeTimeFormat or pin the product copy with explicit copy tests",
          },
          false: {
            what: "Tests pin the exact wording, brand voice needs copy Intl cannot produce, or locale reach is not established",
          },
        },
      },
      message: "This time-ago ladder reimplements Intl.RelativeTimeFormat without a copy need.",
    },
    "jev/no-hand-rolled-number-format": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this number assembly reimplement Intl.NumberFormat with no demonstrated need for pinned output?",
          inspect: "Compare the extracted formatting techniques and currency symbols with the pinned-output signals, the Intl shelf elsewhere in the repository, and the repository callers in the supplied evidence.",
          focus: "Judge whether the regex and prefix machinery formats display values Intl could format, or a serialized form a parser depends on.",
          decision_boundary: [
            "Display currency built by thousand-separator regex or manual symbol prefixing, while no test or parser pins the exact string, is strong evidence of reimplemented formatting machinery.",
            "A pinned wire format a parser depends on, or compact and percent forms asserted in tests, answers the question negatively.",
            "Output already routed through Intl.NumberFormat weakens the claim even when toFixed calls remain nearby.",
            "If the evidence does not establish user-facing display versus a pinned serialized form, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "The function assembles display numbers from regex and symbol parts while no contract pins the exact output",
            remedy: "Format the number with Intl.NumberFormat or pin the wire format explicitly with a round-trip test",
          },
          false: {
            what: "A parser or test pins the exact string, or the display versus serialized position is unclear",
          },
        },
      },
      message: "This number assembly reimplements Intl.NumberFormat without a pinned-output need.",
    },
    "jev/no-hand-rolled-url-query": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this query parse or build reimplement URLSearchParams with no demonstrated need for syntax it cannot express?",
          inspect: "Compare the extracted split and encode-join signals with the nested-syntax support, the tested shape signals, the URLSearchParams shelf, and the repository callers in the supplied evidence.",
          focus: "Judge whether flat key and value handling could use the platform, or callers demonstrably pass bracket-nested shapes.",
          decision_boundary: [
            "Flat key and value parsing by split on ampersand and equals with manual encoding is strong evidence of reimplemented query machinery.",
            "Bracket-nested or array syntax, such as a[]=1 or a[b]=2, that callers demonstrably pass with tests on that shape answers the question negatively.",
            "Query work already routed through URLSearchParams weakens the claim even when split calls remain nearby.",
            "If the evidence does not establish the shapes callers actually pass, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "The function parses or builds flat query strings by hand while callers show no shape the platform cannot express",
            remedy: "Parse and build the query with URLSearchParams or pin the nested shape with explicit shape tests",
          },
          false: {
            what: "Callers demonstrably pass nested shapes with tests, the work already uses URLSearchParams, or caller shapes are not established",
          },
        },
      },
      message: "This query handling reimplements URLSearchParams without a shape need.",
    },

    "jev/no-far-away-test": {
      scope: "module",
      question: {
        instructions: {
          question: "Does this change's test file live far from its subject although this repo colocates tests with sources?",
          inspect: "Compare the test file's directory with its subject's directory and the repo's colocated-test counts in the supplied evidence.",
          focus: "Judge whether the placement departs from the repository's own demonstrated colocation practice, not whether colocation is ideal in general.",
          decision_boundary: [
            "A new test landing several directories away from its subject while the repo's own tests sit beside their subjects is strong evidence of a far-away test.",
            "A test with no identifiable subject, or a subject that itself lives in a shared location, weakens the claim even when the distance is large.",
            "A repository that already spreads tests across dedicated directories establishes no colocation norm to depart from.",
            "A single clarifying move, such as placing a cross-cutting integration test with its harness, is not a far-away test.",
            "If the subject cannot be identified or the colocation counts are thin, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "A test added far from its subject in a repository whose own tests demonstrate colocation",
            remedy: "Place the test beside its subject, or record why this test belongs with its distant harness",
          },
          false: {
            what: "The test sits with its subject, the subject is genuinely shared, or the repo keeps no colocation practice",
          },
        },
      },
      message: "This test lives far from its subject although this repo colocates tests with sources.",
    },
    "jev/no-utils-grab-bag-growth": {
      scope: "module",
      question: {
        instructions: {
          question: "Were new unrelated exports added to a miscellaneous utils, helpers, or common module instead of an owned home?",
          inspect: "Compare the added export names with the host module's existing export domains and importer topics in the supplied evidence.",
          focus: "Judge whether the addition deepens a grab-bag the repository already demonstrates, not whether small helpers may ever share a file.",
          decision_boundary: [
            "A new domain operation landing in a miscellaneous module whose existing exports already span several unrelated domains is strong evidence of grab-bag growth.",
            "A helper that shares the host's existing vocabulary, or a repo where the miscellaneous module is the documented convention, weakens the claim.",
            "One more string formatter among string formatters is cohesion, even inside a file named utils.",
            "Growth that arrives with its own tests and a name tied to the host's existing domains is not grab-bag growth.",
            "If the added exports share the host's domains or the host shows no grab-bag shape, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "Unrelated new exports deepen a miscellaneous module that already spans several domains",
            remedy: "Give the new exports a home beside the code they serve, or split the host by domain",
          },
          false: {
            what: "The additions share the host's domains, the host is cohesive, or no miscellaneous-module shape is shown",
          },
        },
      },
      message: "This change adds unrelated exports to a miscellaneous module instead of an owned home.",
    },
    "jev/no-barrel-bypass": {
      scope: "module",
      question: {
        instructions: {
          question: "Does a new import reach deep into a feature's internals although that feature publishes a barrel entry point?",
          inspect: "Compare the new import's depth with the feature barrel's re-exported symbols and how the repo's other external importers reach the feature.",
          focus: "Judge whether the consumer bypasses the feature's own published surface, not whether deep imports are ever convenient.",
          decision_boundary: [
            "A new deep import for a symbol the barrel already re-exports, while sibling consumers use the barrel, is strong evidence of a bypass.",
            "A barrel nobody uses, or a symbol the barrel does not offer, leaves no published surface to bypass.",
            "A deep import that the barrel itself cannot express, such as a type the barrel deliberately hides, is not a bypass.",
            "Test-only or type-only reach into internals carries less weight than a runtime dependency on them.",
            "If the barrel offers no path to the symbol or the repo shows no barrel discipline, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "A new consumer reaches past a feature's barrel for a symbol the barrel already publishes",
            remedy: "Import through the feature's barrel entry point, or extend the barrel when the symbol belongs on the surface",
          },
          false: {
            what: "The barrel offers no route to the symbol, the barrel is unused repo-wide, or the import already uses the entry point",
          },
        },
      },
      message: "This import reaches deep into a feature although the feature publishes a barrel entry point.",
    },
    "jev/no-skipped-level-import": {
      scope: "module",
      question: {
        instructions: {
          question: "Does a new import climb multiple directory levels to reach a module that has a nearer sanctioned entry?",
          inspect: "Read the new import's climb depth, the nearer barrel or alias entry in the supplied evidence, and the repo's typical relative depth.",
          focus: "Judge whether the climb skips an entry the repository itself provides, not whether relative imports are untidy in the abstract.",
          decision_boundary: [
            "A new climb of several levels to a module whose own directory barrel re-exports it is strong evidence of a skipped level.",
            "A climb with no nearer entry anywhere, and no alias configuration, leaves the importer no sanctioned alternative.",
            "A repository whose own imports routinely climb is describing its norm, even when an alias would read better.",
            "A one-level relative reach, or a climb forced by generated output locations, is not a skipped level.",
            "If no nearer entry exists or the climb is the repo's ordinary shape, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "A new multi-level climb reaches a module past a nearer barrel or alias entry",
            remedy: "Import through the nearer barrel entry or the configured path alias",
          },
          false: {
            what: "No nearer entry exists, the climb matches the repo's ordinary shape, or the reach stays within one level",
          },
        },
      },
      message: "This import climbs multiple directory levels although a nearer entry point exists.",
    },
    "jev/no-deep-delegation-chain": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this function sit mid-chain in a multi-module delegation path whose depth hides the policy decisions callers transitively depend on?",
          inspect: "Compare the candidate's delegation target with the intermediate module's forwarding shape and guard signals, the terminal module reached on the second hop, and the module-crossing count in the supplied evidence.",
          focus: "Judge whether callers must transitively depend on policy they cannot see, not whether delegation itself is wrong.",
          decision_boundary: [
            "A candidate delegating into a module whose handler purely forwards into a third module that enforces unseen policy is strong evidence of a deep delegation chain.",
            "Intermediate hops that add shaping, validation, or guards of their own weaken the claim even when the chain crosses modules.",
            "A chain that stays inside one module, or a documented pipeline whose stages are explicit, is not a deep delegation chain.",
            "A single shallow hop, however thin, carries no depth and belongs to pass-through judgments instead.",
            "If the evidence traces fewer than two hops or fewer than two module crossings, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "The function delegates across modules into a forwarding middle hop whose terminal hop decides policy invisibly to callers",
            remedy: "Collapse the chain, move the policy decision beside the caller-visible contract, or document the pipeline stages explicitly",
          },
          false: {
            what: "Each hop adds shaping or guards, the chain stays in one module, the path is a documented pipeline, or no multi-hop chain is shown",
          },
        },
      },
      message: "This function sits mid-chain in a delegation path whose depth hides the policy its callers depend on.",
    },
    "jev/no-stability-inversion": {
      scope: "abstraction",
      question: {
        instructions: {
          question: "Does this widely used abstraction depend on a volatile detail, so churn below threatens calm above?",
          inspect: "Compare the owner module's importer count with each resolved target module's importer count, test or internal path markers, and internal annotations in the supplied evidence.",
          focus: "Judge the direction of the dependency edge, stable depending on volatile, not how much the abstraction knows.",
          decision_boundary: [
            "A heavily imported type naming an export of a test-only, fixture, or internal module that nothing else imports is strong evidence of a stability inversion.",
            "A target that is version-pinned, widely imported, and calm weakens the claim even when its path looks internal.",
            "An abstraction that is itself internal with one caller carries no stability promise to invert.",
            "Depending outward through a published barrel is a different shape from depending inward on volatility.",
            "If no resolved project-module dependency is shown, or the direction runs volatile toward stable, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "A stable, widely used surface depends inward on a rarely imported, test-marked, or internally documented module",
            remedy: "Depend on a stable published contract instead, or move the abstraction down beside the volatile detail it needs",
          },
          false: {
            what: "The target is calm and widely used, the abstraction is itself internal, or no stable-onto-volatile edge is shown",
          },
        },
      },
      message: "This widely used abstraction depends on a volatile detail, so churn below threatens calm above.",
    },
    "jev/no-options-style-split": {
      scope: "module",
      question: {
        instructions: {
          question: "Do this module's exports mix options-object and positional parameter styles for overlapping call shapes, so callers cannot predict how to pass arguments?",
          inspect: "Compare each exported function's parameter style and arity with the module majority style, the same-arity siblings on opposite styles, and each sampled call against its enclosing caller's signature and style in the supplied evidence.",
          focus: "Judge cross-sibling convention incoherence across the module surface, not whether one signature is awkward on its own.",
          decision_boundary: [
            "Same-arity siblings on opposite styles, both public, with callers wrapping one to call the other, is strong evidence of an options-style split.",
            "Styles partitioned by domain, such as builders versus queries, weaken the claim even when both styles appear.",
            "A module mid-migration with the new style documented is transition, not incoherence.",
            "A single signature that merely wants an object belongs to unnamed-parameter judgments instead.",
            "If every export shares one style or fewer than two styled exports are shown, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "The module's public exports mix options-object and positional styles for overlapping call shapes without a domain partition",
            remedy: "Converge the surface on one parameter convention, or partition the styles by documented domain",
          },
          false: {
            what: "One style dominates by domain, the module documents a migration, or no cross-sibling style split is shown",
          },
        },
      },
      message: "This module's exports mix options-object and positional styles for overlapping call shapes.",
    },
    "jev/no-concrete-stable-module": {
      scope: "module",
      question: {
        instructions: {
          question: "Is this module widely imported yet offering no abstract surface, so its stability rests on concrete details?",
          inspect: "Compare the owner module's importer count and imported symbols with its exported abstraction inventory and concrete export list in the supplied evidence.",
          focus: "Judge whether stability rests on concrete details for lack of interfaces or type aliases shaping the contracts, not whether abstraction is fashionable.",
          decision_boundary: [
            "A heavily imported module with all-concrete exports, where the imported symbols are concrete functions or classes, is strong evidence of a concrete stable module.",
            "A small stable utility with few callers weakens the claim even when it exports no interfaces.",
            "Leaf-level glue, where an interface would be ceremony, is not a concrete stable module.",
            "One exported interface or type alias shaping the contracts defeats the claim regardless of importer counts.",
            "If the module shows any abstract surface, no concrete exports, or no importers, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "A widely imported module whose de-facto contract is concrete exports with no interfaces or type aliases shaping them",
            remedy: "Introduce interfaces or type aliases that shape the module's contracts and program callers against them",
          },
          false: {
            what: "The module already offers an abstract surface, has few callers, is leaf-level glue, or shows no importer base",
          },
        },
      },
      message: "This widely imported module offers no abstract surface, so its stability rests on concrete details.",
    },
    "jev/no-import-use-skew": {
      scope: "module",
      question: {
        instructions: {
          question: "Does this file import a wide surface from one module but exercise a narrow slice, keeping a dependency edge heavier than its use justifies?",
          inspect: "Compare each source module's imported-symbol list with the used and unused names and the used-versus-imported ratio in the supplied evidence.",
          focus: "Judge whether the dependency edge is heavier than its exercised use justifies, not whether imports are alphabetized or tidy.",
          decision_boundary: [
            "Many names imported from one volatile or heavy module with only one exercised in the file is strong evidence of import-use skew.",
            "Symbols used in conditionally compiled paths present in the source count as used, not skew.",
            "Type-only extras and barrel re-export files carry no local-use expectation and are not skew.",
            "One unused name beside a broadly exercised surface is ordinary drift, not a heavy edge.",
            "If every source's imports are exercised or the file is a barrel, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "The file holds a wide import surface from a module while exercising a narrow slice of it",
            remedy: "Narrow the import to the exercised symbols or split the dependency so the edge matches its use",
          },
          false: {
            what: "Each source's imports are exercised, the extras are type-only, the file re-exports, or no unused surface is shown",
          },
        },
      },
      message: "This file imports a wide surface from one module but exercises a narrow slice of it.",
    },
    "jev/no-unverified-mock-contract": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this test's mocked layer diverge from the real module contract it stands in for, so the test verifies the mock rather than the interaction?",
          inspect: "Use each resolved mock target with its stubbed members, the members absent from the real module, the mocked return shapes beside the real return expressions, the error paths no stub reproduces, and whether any assertion checks a value computed by real code in the supplied evidence.",
          focus: "Judge fidelity between the mock and the real contract, not how many collaborators are doubled.",
          decision_boundary: [
            "A stubbed member the real module does not export, or a mocked return shape the real function never returns, is strong evidence of an unverified mock contract.",
            "A documented error path the real module throws that no stub reproduces leaves the failure behavior unverified.",
            "A stubbed surface matching the real exports with assertions on values computed by real code answers the question negatively.",
            "Breadth of doubling alone belongs to mock-everything; this question needs a resolved real module to compare against.",
            "If no mock resolves to a project module, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "The mock's members, return shapes, or error paths diverge from the real module it stands in for",
            remedy: "Align the stub with the real exports and return shapes, including the documented error paths, or stop doubling that module",
          },
          false: {
            what: "The stub matches the real surface and error behavior, real computed values are asserted, or no mock resolves to a project module",
          },
        },
      },
      message: "This test's mock diverges from the real module contract it stands in for.",
    },
    "jev/no-implementation-mirrored-expectation": {
      scope: "function",
      question: {
        instructions: {
          question: "Do this test's expected values mirror literals copied from the subject implementation rather than from an independent contract, so the assertion pins the implementation's current assumption?",
          inspect: "Use each expectation literal with whether it appears verbatim in the subject source and which independent anchors outside the subject and the test repeat it in the supplied evidence.",
          focus: "Judge whether the expected value is anchored outside the subject, not whether the assertion checks an outcome.",
          decision_boundary: [
            "An expected literal appearing only in the subject source and the test is strong evidence of a mirrored assumption: changing both together stays green.",
            "A value repeated in a contract fixture, seed data, or a second independent consumer is anchored outside the subject.",
            "Assertions pinning call counts, arguments, or order belong to interaction pinning, not literal mirroring.",
            "A test with no outcome literals to compare cannot mirror an assumption; answer no.",
          ],
        },
        criteria: {
          true: {
            what: "Expected values repeat the subject's own literals with no independent anchor, so the test pins current assumptions",
            remedy: "Source expected values from the contract, fixture, or independent consumer that defines the behavior",
          },
          false: {
            what: "The expected values are anchored outside the subject, or the test states no outcome literal to mirror",
          },
        },
      },
      message: "This test's expectations mirror the implementation's own literals rather than an independent contract.",
    },
    "jev/no-self-authored-exam": {
      scope: "change",
      question: {
        instructions: {
          question: "Does this change author the implementation, its doubles, and its assertions together with no pre-existing anchor, so the same diff writes the exam it takes?",
          inspect: "Use each implementation and test pairing with the touched declarations, the changed test functions, and the anchor files referencing each declaration outside the pairing in the supplied evidence.",
          focus: "Judge whether the touched behavior is anchored anywhere the diff leaves alone, not whether tests were added.",
          decision_boundary: [
            "Touched declarations exercised only by tests the same diff adds or edits, with zero unchanged references, is strong evidence of a self-authored exam.",
            "A pre-existing contract test, fixture, spec, or second caller left untouched that still references the behavior anchors the change.",
            "Implementation edits with no paired test change, or test edits with no paired implementation change, are not a same-diff exam.",
            "If the change pairs no implementation with a test, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "The same diff writes the implementation, its doubles, and its assertions with no anchor the diff leaves alone",
            remedy: "Anchor the behavior first in an independent contract test or fixture, then change the implementation against it",
          },
          false: {
            what: "Unchanged tests, fixtures, or callers already pin the behavior, or the change pairs no implementation with a test",
          },
        },
      },
      message: "This change writes the implementation and its exam together with no pre-existing anchor.",
    },
    "jev/no-change-stranded-code": {
      scope: "change",
      question: {
        instructions: {
          question: "Does this change strand previously-live code — a retained function or module whose last in-repo callers or importers disappear inside this diff — that should have been removed in the same change?",
          inspect: "Compare the stranded functions and their before/after caller counts, the co-added successors with migrated call sites, the stranded modules with lost importers, and the coverage metadata in the supplied evidence.",
          focus: "Judge whether the retained code lost its last reason to exist inside this diff, not whether the new code duplicates logic elsewhere.",
          decision_boundary: [
            "A function dropping from live callers to zero in a diff that adds a same-responsibility successor with migrated call sites is strong evidence of stranded code.",
            "An exported public API with possible external callers, a documented deprecation window, or a successor covering only part of the old behavior weakens the claim toward deliberate retention.",
            "jev/no-duplicated-logic scores the new-copy side with remedy reuse the old; this scores the kept-dead side with remedy delete the old on caller-delta evidence.",
            "If the coverage metadata shows unanalyzed files needed for the judgment, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "Previously-live code lost its last in-repo callers inside this change while a replacement stays beside it",
            remedy: "Delete the stranded implementation in the same change",
          },
          false: {
            what: "The retained code still serves callers, serves external consumers, awaits a deprecation window, or lacks enough caller-delta evidence",
          },
        },
      },
      message: "This change strands previously-live code with no remaining callers.",
    },
    "jev/no-impossible-error-branch": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this error-handling branch guard a failure its repo-visible callee cannot produce, making the branch untestable weight?",
          inspect: "Compare each handler's guarded calls with the callee throw and rejection findings, the ownership and analyzability of each callee, and the boundary position in the supplied evidence.",
          focus: "Judge whether the guarded failure can actually occur in this repository, not whether defensive handling is virtuous in general.",
          decision_boundary: [
            "A single repo-visible callee, fully analyzable with zero throw or rejection paths, guarded far from any trust boundary, is strong evidence of an impossible branch.",
            "External or package callees, dynamic dispatch, unanalyzable targets, or a boundary position where callers are untrusted weaken the claim toward prudent handling.",
            "jev/no-unreachable-guard scores parameter guards on caller-value evidence; this scores callee capability by inspecting callee bodies.",
            "If no guarded callee is analyzable, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "The branch guards a failure no repo-visible callee path can produce",
            remedy: "Remove the dead branch or narrow it to the failure the callee can actually produce",
          },
          false: {
            what: "A callee can produce the guarded failure, the callee is external or unanalyzable, or the boundary position justifies the handling",
          },
        },
      },
      message: "This error branch guards a failure its callee cannot produce.",
    },
    "jev/no-retained-superseded-implementation": {
      scope: "function",
      question: {
        instructions: {
          question: "Is this implementation marked superseded by its owning module, with no live in-repo callers, yet retained beside its successor instead of removed?",
          inspect: "Compare the supersede marker and named successor with the caller count, the symbol importers, and the successor-in-use files in the supplied evidence.",
          focus: "Judge whether the old implementation remains only as history beside a live successor, not whether callers still use the old member.",
          decision_boundary: [
            "A marked implementation with zero in-repo callers while all siblings use the named successor is strong evidence of a retained corpse.",
            "A package-entry export with possible external consumers, or callers the scan cannot see such as dynamic imports or plugin registries, weakens the claim toward deliberate retention.",
            "jev/no-superseded-api-use scores the call side with callers still on the old member; this scores the retained-implementation side needing the marker-plus-zero-caller conjunction.",
            "If the marker is absent or live callers remain, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "A marked-superseded implementation with no live callers remains beside its in-use successor",
            remedy: "Delete the superseded implementation now that its successor carries the callers",
          },
          false: {
            what: "The marker is absent, callers remain, external consumers may rely on it, or the successor is not established",
          },
        },
      },
      message: "This superseded implementation has no callers and should be removed.",
    },
    "jev/no-doubled-pure-helper": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this test double a side-effect-free repo helper it could call directly, maintaining a double that verifies nothing the real helper would not?",
          inspect: "Compare each doubled helper with its purity signals and source, the canned mock values, and the real subject calls the test still makes in the supplied evidence.",
          focus: "Judge whether the double replaces a deterministic helper the test could exercise directly, not whether the test doubles its subject.",
          decision_boundary: [
            "A pure leaf helper such as a string or key transform, mocked to return canned values identical to real outputs while the subject stays real, is strong evidence of a needless double.",
            "A helper with nondeterminism or clock dependence, separate ownership or contract, or a mock deliberately pinning a failure mode the test needs weakens the claim toward a justified seam.",
            "jev/no-mock-everything scores doubling the subject; this scores doubling a pure helper while the subject stays real on purity evidence.",
            "If no doubled helper is analyzable or purity is unresolved, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "The test maintains a double of a pure helper it could call directly while asserting against the real subject",
            remedy: "Call the real helper and drop the double",
          },
          false: {
            what: "The helper is impure or clock-dependent, the seam pins a needed failure mode, or no analyzable double is established",
          },
        },
      },
      message: "This test doubles a pure helper it could call directly.",
    },

    "jev/no-import-cycle-tangle": {
      scope: "change",
      question: {
        instructions: {
          question: "Does this change create a module dependency cycle that collapses a layering boundary?",
          inspect: "Compare the cycle path across the changed file, whether each edge carries value imports or type-only imports, the directory segments of each file on the cycle, and whether the changed lines introduce the closing edge in the supplied evidence.",
          focus: "Judge whether the cycle merges two layers' change fates, not whether the imported symbols resolve correctly today.",
          decision_boundary: [
            "A changed file adding a value import that closes a cycle across distinct layer directories is strong evidence of a collapsed boundary.",
            "A cycle carried only by type-only edges, or a cycle within one directory, answers the question negatively.",
            "A cycle that predates the change, where the changed lines touch none of its edges, weakens the claim.",
            "If no cycle passes through the changed file, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "A module dependency cycle through the changed file that joins separately layered modules into one change unit",
            remedy: "Break the cycle by moving the shared dependency into the lower layer or a shared module both sides may import",
          },
          false: {
            what: "No cycle through the changed file, a type-only or same-directory cycle, or a pre-existing cycle the change does not touch",
          },
        },
      },
      message: "This change creates a module dependency cycle that collapses a layering boundary.",
    },
    "jev/no-domain-upward-import": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this domain-owned function depend directly on an outer-layer module?",
          inspect: "Compare the function's domain ownership with each resolved upward import, the outer layer each target lives in, whether the edge is a value or type-only import, and the repository callers in the supplied evidence.",
          focus: "Judge the direction of the dependency arrow from inner to outer layer, not the content of what is imported.",
          decision_boundary: [
            "A domain function value-importing an adapter, infrastructure, UI, route, or app module is strong evidence of an upward dependency.",
            "Imports of shared-kernel value objects or same-layer modules answer the question negatively.",
            "A type-only upward edge weakens the claim, since no runtime fate is shared.",
            "If the function lives outside domain-owned paths, or no outer-layer import exists, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "A domain-owned function depending directly on an outer-layer module at runtime",
            remedy: "Invert the dependency by passing the outer capability in as a parameter or interface the domain owns",
          },
          false: {
            what: "The function lives outside the domain, imports only shared or same-layer modules, or reaches outward by type alone",
          },
        },
      },
      message: "This domain-owned function depends directly on an outer-layer module.",
    },
    "jev/no-barrel-wide-reexport": {
      scope: "change",
      question: {
        instructions: {
          question: "Does this barrel change widen one module's public surface across unrelated responsibilities?",
          inspect: "Compare each added re-export with the owning directory of its target, how many distinct directories the additions span, whether each addition is a wildcard or named re-export, and the importer counts in the supplied evidence.",
          focus: "Judge whether the aggregation merges consumers of unrelated responsibilities, not whether any internal detail escapes.",
          decision_boundary: [
            "An index barrel adding wildcard re-exports from several unrelated directories is strong evidence of a widened surface.",
            "A barrel adding one sibling component from its own feature directory answers the question negatively.",
            "Named re-exports of a single responsibility, even across a directory line, weaken the claim.",
            "If no re-export is added on the changed lines, or the file is not a barrel, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "A barrel change aggregating unrelated responsibilities behind one public surface",
            remedy: "Keep one barrel per responsibility, or re-export only the cohesive sibling surface the barrel owns",
          },
          false: {
            what: "The additions stay within one responsibility, the file is not a barrel, or no re-export is added",
          },
        },
      },
      message: "This barrel change widens one module's public surface across unrelated responsibilities.",
    },
    "jev/no-utility-module-grab-bag": {
      scope: "change",
      question: {
        instructions: {
          question: "Does this new export land in a shared utility module whose existing exports serve unrelated responsibilities?",
          inspect: "Compare the new export with the module's existing export inventory, the per-export importer footprints and how disjoint they are, and the disjoint importer-pair count in the supplied evidence.",
          focus: "Judge whether the module's exports form one cohesive responsibility the newcomer joins, not whether the new export is useful.",
          decision_boundary: [
            "A new export joining existing exports with fully disjoint importer footprints is strong evidence of a grab bag.",
            "A newcomer sharing importers and subject matter with cohesive siblings answers the question negatively.",
            "A module with only one or two existing exports weakens the claim, since no grab-bag shape is established.",
            "If the file is not a shared utility module, or no new export is added, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "A new export landing in a shared utility module whose exports serve unrelated responsibilities with disjoint callers",
            remedy: "Place the export beside the responsibility it serves, or split the module so each part owns one cohesive surface",
          },
          false: {
            what: "The newcomer joins a cohesive export family, the module is not a shared utility, or no new export is added",
          },
        },
      },
      message: "This new export lands in a shared utility module whose existing exports serve unrelated responsibilities.",
    },
    "jev/no-duplicate-module-role": {
      scope: "change",
      question: {
        instructions: {
          question: "Does this added file duplicate the responsibility already owned by an existing module?",
          inspect: "Compare the new file's export inventory with each same-directory sibling, the overlapping export names, the filename token similarity, whether either side is a platform variant, and the importer split in the supplied evidence.",
          focus: "Judge whether two modules now own one role even when their implementations differ, not whether any code span is copied.",
          decision_boundary: [
            "A new file beside a same-directory sibling exporting the same operations under a near-synonym name is strong evidence of a duplicated role.",
            "A platform-specific variant or test-adjacent file beside the shared implementation answers the question negatively.",
            "Overlapping generic names with no filename resemblance weakens the claim.",
            "If the change is not an added file, or no sibling shares exports or name tokens, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "An added file taking on a responsibility a same-directory sibling already owns",
            remedy: "Extend the owning module instead, or remove the superseded sibling and move its importers to the new file",
          },
          false: {
            what: "The file extends no owned role, is a platform variant, or shares neither exports nor naming with any sibling",
          },
        },
      },
      message: "This added file duplicates the responsibility already owned by an existing module.",

    },
    "jev/no-clone-and-tweak-sibling": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this added function duplicate a same-module sibling with only small edits, where one parameterized function would serve both callers?",
          inspect: "Compare the function and its closest sibling: shared tokens and statement shapes, parameter lists, literals that differ, and the caller list of each in the supplied evidence.",
          focus: "Judge whether the differences are parameter-sized tweaks that one function with an option or branch could absorb, not whether the two merely share a topic.",
          decision_boundary: [
            "Near-identical bodies that differ by one branch, literal, or extra parameter are strong evidence of a clone that should be parameterized.",
            "Shared guard clauses, imports, or generic scaffolding with otherwise different bodies weaken the claim.",
            "Siblings with distinct callers exercising distinct contracts may justify separate functions even when their shapes overlap.",
            "Token or shape overlap alone is not proof. If the differences change the contract rather than tweak it, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "The function restates a sibling with parameter-sized edits while both callers could share one parameterized implementation",
            remedy: "Parameterize the original function with the varying branch, literal, or option instead of keeping a separate copy",
          },
          false: {
            what: "The sibling differs in contract, serves a distinct role, or shares only generic scaffolding with the candidate",
          },
        },
      },
      message: "This function duplicates a same-module sibling with only small edits.",
    },
    "jev/no-single-caller-exported-helper": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this exported helper serve exactly one production caller and belong living with that caller once the keep-signal facts are weighed?",
          inspect: "Weigh the single production caller against the keep-signal facts: whether the caller lives in the same file, the direct contract tests and transitive test pins exercising the helper, whether the package exports map or an index barrel reaches the helper as public API, and the co-change seam history of helper versus caller.",
          focus: "Judge whether the export promises reuse the repository never demonstrates, weighing every named fact in both directions. Absence from the exports map and barrel is one fact among others, never proof on its own. Test callers exercise the helper without demonstrating reuse.",
          decision_boundary: [
            "A same-file caller, direct contract tests, reachability through the package exports map or an index barrel, and a seam history where the helper sits untouched while the caller evolves each pull against the claim; no single fact decides it.",
            "Reachability through the package exports map or an index barrel pulls the answer toward no even with a single current caller, since the export promises reuse beyond the repository.",
            "A caller in another module that imports the helper shows at least cross-module intent, which weakens the claim.",
            "Direct contract tests and transitive test pins exercise the helper without demonstrating production reuse; they inform the judgment without adding callers.",
            "One caller is never enough on its own. Absence from the exports map and barrel is a fact, not proof: weigh it with colocation, contract tests, and seam history before answering yes.",
          ],
        },
        criteria: {
          true: {
            what: "An exported helper with exactly one production caller whose colocation, contract-test, reachability, and seam-history facts together favor living beside its caller",
            remedy: "Move the helper beside its caller or unexport it until a second consumer demonstrates reuse",
          },
          false: {
            what: "The helper is reachable as public API, shows genuine cross-module intent, or its keep-signal facts together favor keeping the export",
          },
        },
      },
      message: "This exported helper serves exactly one production caller; weighed against its keep-signal facts it belongs living with that caller.",
    },
    "jev/no-string-duplicated-enumeration": {
      scope: "change",
      question: {
        instructions: {
          question: "Does this change restate a literal value set already owned by another module instead of reusing the canonical type?",
          inspect: "Compare the literals introduced in the changed lines with the owning module's union or enum members, the overlap between them, and whether the changed file imports the owner in the supplied evidence.",
          focus: "Judge whether the change duplicates a domain value set that already has a canonical home, not whether individual literals coincide by chance.",
          decision_boundary: [
            "Several changed-line literals matching a union owned elsewhere while the changed file does not import the owner is strong evidence of restatement.",
            "A boundary parser that maps wire strings into the owned union once answers the question negatively.",
            "One or two coincidental literals, config keys, or display strings are not a duplicated enumeration.",
            "Literal overlap alone is not proof. If no other module owns the set as a type, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "The change restates a literal set that another module already owns as a union or enum without importing it",
            remedy: "Import the canonical type and parse or narrow the changed values into it at the boundary",
          },
          false: {
            what: "The literals are coincidental, belong to configuration or display copy, map into the owned type once, or have no canonical owner",
          },
        },
      },
      message: "This change restates a literal value set already owned by another module.",
    },
    "jev/no-convergent-twin-types": {
      scope: "abstraction",
      question: {
        instructions: {
          question: "Does this type duplicate a field shape already owned by another module, so the two copies must be kept in agreement by hand?",
          inspect: "Compare the property lists of the candidate and its closest twin, the shared properties, and the importer footprints of each in the supplied evidence.",
          focus: "Judge whether the two shapes describe the same domain value and should be one shared type, not whether small records ever coincide.",
          decision_boundary: [
            "Near-identical multi-field shapes in different modules with overlapping consumers are strong evidence of twins that should converge.",
            "Coincidental two-field shapes such as id and name answer the question negatively.",
            "Twins that evolve independently toward different required fields weaken the claim even when they still overlap.",
            "Property overlap alone is not proof. If the shapes describe different domain values, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "The type restates a field shape owned by another module while consumers of both overlap",
            remedy: "Share one canonical type between the modules instead of maintaining two copies by hand",
          },
          false: {
            what: "The overlap is coincidental, the shapes describe different domain values, or each shape evolves under its own owner",
          },
        },
      },
      message: "This type duplicates a field shape already owned by another module.",
    },
    "jev/no-change-amplifier-case": {
      scope: "change",
      question: {
        instructions: {
          question: "Does this change add one case that sibling code must mirror to stay consistent, while nothing forces the mirror?",
          inspect: "Compare each added case with the mirror switches and if-chains over the same discriminant or value set, which literals each mirror handles, and whether any mirror carries an exhaustiveness check in the supplied evidence.",
          focus: "Judge whether the change creates unhandled-case risk elsewhere, not whether the new case itself is correct.",
          decision_boundary: [
            "A new union member with several mirrors not handling it and no exhaustiveness check is strong evidence of change amplification.",
            "A new case under mirrors that fail compilation until handled answers the question negatively.",
            "An already-scattered multi-file edit belongs to shotgun change, not this rule; this rule scores one new case with missing mirrors.",
            "If no case is added, or no sibling code branches over the widened set, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "One added case leaves sibling switches or chains handling the old set with no check that forces an update",
            remedy: "Handle the new case at each mirror or add an exhaustiveness check that fails until mirrors are updated",
          },
          false: {
            what: "Mirrors already handle the case, an exhaustiveness check forces the update, or nothing else branches over the set",
          },
        },
      },
      message: "This change adds a case that sibling code must mirror with nothing forcing the mirror.",
    },
    "jev/no-mutable-surface-expansion": {
      scope: "change",
      question: {
        instructions: {
          question: "Does this change widen the exported mutable surface that other modules can come to depend on?",
          inspect: "Compare each added mutable export with its declaration, the importing modules of the touched file, and the coverage in the supplied evidence.",
          focus: "Judge whether the change exposes new mutation, not whether existing shared state is already coupled.",
          decision_boundary: [
            "An added exported let or a setter on an exported class is strong evidence of mutable surface expansion.",
            "A new frozen constant or a pure function export answers the question negatively.",
            "Existing shared mutable state belongs to the shared-mutable-module-state family, not this rule; this rule scores the expansion event.",
            "If no added export exposes mutation, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "The change adds an exported binding, field, setter, or mutation method other modules can mutate through",
            remedy: "Keep the state private or expose it behind a frozen snapshot or an explicit mutation protocol",
          },
          false: {
            what: "New exports are frozen or pure, or no export is added",
          },
        },
      },
      message: "This change widens the exported mutable surface other modules can depend on.",
    },
    "jev/no-subclass-fragility-hook": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this override duplicate its base method's logic with edits instead of reusing it, so the next base-class fix silently misses this copy?",
          inspect: "Compare the override body with the resolved base method source, the shared-token similarity, the super-call signal, and the sibling overrides in the supplied evidence.",
          focus: "Judge whether the override copies logic it should inherit, not whether overriding itself is wrong.",
          decision_boundary: [
            "An override that repeats nearly all of a long base method with a small tweak and no super call is strong evidence of a fragility hook.",
            "An override that calls super and then extends the result answers the question negatively.",
            "A subclass refusing the inherited contract belongs to refused inheritance, not this rule; this rule scores a copy with edits.",
            "Duplication without an inheritance link belongs to duplicated logic; this rule needs a resolved base method.",
          ],
        },
        criteria: {
          true: {
            what: "The override carries its own edited copy of base logic that future base fixes will miss",
            remedy: "Call super and keep only the extending behavior in the override",
          },
          false: {
            what: "The override reuses the base through super, adds genuinely new behavior, or has no resolvable base method",
          },
        },
      },
      message: "This override copies base logic with edits instead of reusing it through super.",
    },
    "jev/no-contract-narrowing-after-ship": {
      scope: "change",
      question: {
        instructions: {
          question: "Does this change narrow what existing callers may pass while leaving current call sites to break?",
          inspect: "Compare each narrowing with its before and after excerpts, the owning function, and the observed callers with their argument lists in the supplied evidence.",
          focus: "Judge whether live callers can still satisfy the narrowed contract, not whether the stricter contract is desirable.",
          decision_boundary: [
            "A new required field on a widely called options object with existing callers omitting it is strong evidence of narrowing after ship.",
            "A narrowing shipped behind a new function while the old one keeps delegating answers the question negatively.",
            "A new positional parameter belongs to breaking export reshape, not this rule; this rule scores options properties, new rejection guards, and fresh non-null assertions on parameters.",
            "If no narrowing appears, or every observed caller already satisfies it, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "Existing callers pass shapes the narrowed contract now rejects",
            remedy: "Keep the old contract working alongside the stricter one or migrate the affected call sites in the same change",
          },
          false: {
            what: "Callers already satisfy the contract, the old entry keeps delegating, or no input contract narrows",
          },
        },
      },
      message: "This change narrows what existing callers may pass while current call sites break.",
    },
    "jev/no-nondeterministic-test-input": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this test draw unseeded randomness or live time into values its expectations depend on, so it can pass or fail by luck?",
          inspect: "Use the extracted nondeterministic reads, whether the drawn values flow into assertions, and whether a seeded PRNG or fake-timer setup controls them in the supplied evidence.",
          focus: "Judge whether timing or randomness variance can decide the verdict, not whether the test touches async code or waits.",
          decision_boundary: [
            "A snapshot or exact assertion over Math.random output or live timestamps with no seed or clock control is strong evidence of a nondeterministic test.",
            "A seeded PRNG draw with fake timers installed weakens the claim even when randomness appears, since the values are reproducible.",
            "Fixed literal inputs with no randomness or time reads deserve a negative answer even when the subject itself is time-sensitive.",
            "A nondeterministic draw that never reaches an assertion is weaker evidence; weigh whether the verdict can actually vary.",
            "If the evidence cannot establish a nondeterministic read, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "Uncontrolled randomness or live time flows into asserted values, so reruns can disagree without any code change",
            remedy: "Seed the PRNG and freeze the clock, or assert properties that hold for every draw",
          },
          false: {
            what: "The values are seeded, clock-controlled, fixed literals, or never reach an expectation",
          },
        },
      },
      message: "This test feeds unseeded randomness or live time into its expectations.",
    },
    "jev/no-untestable-singleton-grab": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this domain function reach ambient singleton state that tests cannot substitute through its contract?",
          inspect: "Compare the function's parameters with each extracted singleton grab, whether the singleton arrives as an argument, whether the grab lives in composition-root wiring, the repository callers, and the test doubles available in the supplied evidence.",
          focus: "Judge whether a test can substitute the singleton through the function's contract, not whether the singleton is documented or the function is otherwise pure.",
          decision_boundary: [
            "A pricing or policy function calling a database or store singleton with no such parameter is strong evidence of an untestable grab.",
            "Receiving the collaborator as a parameter answers the question negatively even when the call site passes a singleton, since the seam exists.",
            "A grab inside composition-root wiring weakens the claim, since wiring exists to assemble singletons rather than to decide domain outcomes.",
            "Test doubles mocking the singleton module weaken but do not remove the claim; judge whether the contract itself offers a seam.",
            "If the evidence cannot establish an ambient singleton read, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "Domain behavior depends on ambient singleton state with no parameter or seam a test could substitute",
            remedy: "Accept the collaborator as a parameter assembled once in wiring",
          },
          false: {
            what: "The singleton arrives through the contract, the grab is wiring rather than domain logic, or no ambient read is established",
          },
        },
      },
      message: "This domain function grabs ambient singleton state its tests cannot substitute.",
    },
    "jev/no-giant-test-arrange": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this test bury its behavior under inline setup mass that hides what is actually being verified?",
          inspect: "Use the extracted arrange-phase statement and line counts, inline object-literal sizes, the assertion count, and the factory or builder helpers available in nearby test files in the supplied evidence.",
          focus: "Judge the setup-to-assertion imbalance, not fixture duplication across files or whether assertions exist at all.",
          decision_boundary: [
            "A large inline object graph feeding one assertion, while nearby tests build the same scenario with factory helpers, is strong evidence of a giant arrange.",
            "The same scenario built with shared factories in a few lines weakens the claim even when the domain setup is inherently large.",
            "A proportional setup that each assertion visibly needs is not a smell; require mass that obscures the verified behavior.",
            "Counts alone are never sufficient; weigh what the setup hides against what the assertions check.",
            "If the evidence cannot establish an arrange phase before an assertion, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "Inline setup mass obscures the behavior under test, so readers cannot tell what the assertions actually verify",
            remedy: "Build the scenario with the factory helpers the sibling tests use and keep only the case-specific setup inline",
          },
          false: {
            what: "The setup is proportional, factory-built, or absent, and the verified behavior stays visible",
          },
        },
      },
      message: "This test buries its behavior under inline setup mass.",
    },
    "jev/no-private-internals-assertion": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this test pin module internals rather than observable behavior, so refactoring breaks the test without breaking users?",
          inspect: "Use the extracted deep imports bypassing barrels, any-casts, and private member accesses, and whether a public entry point for the module is available in the supplied evidence.",
          focus: "Judge whether the test couples to representation that owners may change freely, not whether mocks or branches appear in the test.",
          decision_boundary: [
            "Importing from an internal path and reading underscore state through an any-cast is strong evidence of an internals-pinning test.",
            "Driving the public entry and asserting observable outcomes answers the question negatively even when internals exist nearby.",
            "An any-cast used only to satisfy the type checker around a public API weakens the claim; require coupling to non-public representation.",
            "A deep import with no internals read deserves suspicion but is weaker evidence on its own.",
            "If the evidence cannot establish internals coupling, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "The test asserts on non-public representation, so compatible refactors fail the suite without changing behavior",
            remedy: "Assert the observable outcomes the public entry promises instead of its internal representation",
          },
          false: {
            what: "The test drives public behavior, or no coupling to internals is established",
          },
        },
      },
      message: "This test pins module internals rather than observable behavior.",
    },
    "jev/no-flaky-order-assertion": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this test assert an order over concurrent work that nothing synchronizes, so it passes by scheduling luck?",
          inspect: "Use the extracted concurrent units with their synchronized flags, the order-sensitive assertions joining them, and the combinator, barrier, or unordered-comparison signals in the supplied evidence.",
          focus: "Judge whether synchronization forces the asserted order, not whether the test touches async code or sleeps.",
          decision_boundary: [
            "Asserting log or call order across promises that are never joined, with no barrier or combinator, is strong evidence of a flaky order assertion.",
            "Results joined with Promise.all and compared as sorted sets or unordered collections answer the question negatively.",
            "A barrier, gate, or explicit sequencing primitive between the concurrent units weakens the claim even when order is asserted.",
            "One order assertion over fully synchronized work is not a smell; require unsynchronized concurrency beneath the asserted order.",
            "If the evidence cannot establish concurrent work or an order assertion, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "The asserted order is decided by scheduling rather than by synchronization, so reruns can disagree without any code change",
            remedy: "Join the concurrent work explicitly and compare results as sorted sets or assert the order the synchronization guarantees",
          },
          false: {
            what: "Synchronization forces the asserted order, the comparison is order-insensitive, or no concurrent order is asserted",
          },
        },
      },
      message: "This test asserts an order over concurrent work that nothing synchronizes.",
    },
    "jev/no-redundant-conditional-arm": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this conditional contain an arm whose test adds no decision the remaining arms do not already make?",
          inspect: "Compare each arm's test with its sibling tests and body fingerprint, the body groups sharing byte-identical bodies, whether the default arm repeats a named arm, and the opaque-test flags plus caller shapes in the supplied evidence.",
          focus: "Judge logical redundancy given the siblings — subsumed tests or moot distinctions — not whether the branches look busy.",
          decision_boundary: [
            "Two or more arms with byte-identical bodies on one discriminant, or a default arm repeating a named arm, is strong evidence of a redundant arm.",
            "An arm whose test set is subsumed by sibling tests plus the fallthrough path is redundant even when its body differs cosmetically.",
            "A coherent policy with distinct bodies per distinct test answers the question negatively, however many arms it carries.",
            "Tests calling opaque predicates whose inclusion relation cannot be established from the AST answer the question negatively.",
          ],
        },
        criteria: {
          true: {
            what: "An arm is logically subsumed by its siblings or distinguished by a test its identical body renders moot",
            remedy: "Delete the redundant arm and let the general arm decide those inputs",
          },
          false: {
            what: "Each arm decides inputs no sibling decides, or the overlap cannot be established from opaque predicates",
          },
        },
      },
      message: "This conditional carries an arm its siblings already decide.",
    },
    "jev/no-double-negation": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this code express a positive concept through two or more stacked negations?",
          inspect: "Count the negation layers per site, whether the negated name already carries negative polarity, and whether a negative-polarity parameter is inverted across a call edge in the supplied evidence.",
          focus: "Judge the polarity-expression shape — stacked negations resolving to a positive reading — not whether any single name is clear.",
          decision_boundary: [
            "Two negation layers on one expression, an equality against false, or a negative-polarity argument inverted into a positive-polarity parameter is strong evidence of stacked negation.",
            "A single negation against a negative-domain concept with no positive identifier anywhere in the module answers the question negatively.",
            "Load-bearing negation such as null narrowing under the project's null convention answers the question negatively.",
            "If no stacked or polarity-inverted negation reaches the evidence, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "Stacked negations resolve to a positive reading the code could state directly",
            remedy: "Name the positive concept once and use it without the negation layers",
          },
          false: {
            what: "Each negation earns its place against a genuinely negative domain or a load-bearing convention",
          },
        },
      },
      message: "This code states a positive concept through stacked negations.",
    },
    "jev/no-hollow-delegation-chain": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this value cross three or more function hops whose combined effect is observationally close to the identity?",
          inspect: "Walk the delegation chain hop by hop: per-hop forwarding shape, renames, added defaults, and the end-to-end parameter delta in the supplied evidence.",
          focus: "Judge the chain jointly — hops that are each individually defensible yet only jointly hollow — not any single hop.",
          decision_boundary: [
            "Three or more hops forwarding all arguments unchanged or with pure renaming, with an empty end-to-end semantic delta, is strong evidence of a hollow chain.",
            "A hop that adds a branch, an effect, a type transformation, or a module-boundary crossing breaks the chain and answers the question negatively.",
            "A hop adding a default value that repository callers rely on weakens the claim toward a meaningful convenience.",
            "If the chain cannot be traced through three same-module hops, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "Three or more hops forward the value with no branch, effect, or transformation added",
            remedy: "Collapse the hollow hops so callers reach the hop that does the work",
          },
          false: {
            what: "A hop in the chain adds behavior, crosses a boundary, or the chain is shorter than three hops",
          },
        },
      },
      message: "This value crosses a delegation chain that adds nothing hop by hop.",
    },
    "jev/no-transitive-plumbing": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this function receive a value only to forward it unchanged to the next layer, as one link in a chain of three or more?",
          inspect: "Check that the parameter's only uses are forward-position arguments, count the same-name forward-only signatures establishing the chain depth, and weigh the public-boundary flag plus caller shapes in the supplied evidence.",
          focus: "Judge depth of unchanged forwarding of a narrow value, not the width of any one signature.",
          decision_boundary: [
            "One narrow value threaded byte-identical through three or more signatures, read only at the bottom, is strong evidence of transitive plumbing.",
            "An intermediate that reads the value for a decision, defaults it, or transforms it breaks the chain and answers the question negatively.",
            "Public API boundaries whose removal would break callers that should not know the depth answer the question negatively.",
            "If the value is read anywhere but the chain end, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "The function is one unread link in a three-or-more-layer forwarding chain for a narrow value",
            remedy: "Introduce a nearer channel for the value so intermediates stop declaring what only the leaf reads",
          },
          false: {
            what: "The function reads the value, the chain is shorter than three links, or the parameter is a public boundary",
          },
        },
      },
      message: "This function forwards a value it never reads as one link in a longer chain.",
    },
    "jev/no-distrustful-type-guard": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this guard re-check at runtime what the declared static type already guarantees, inside code with no boundary crossing?",
          inspect: "Compare each guard's excluded case with the annotated parameter type, confirm no any, unknown, or boundary-crossing signal sits between the annotation and the guard, and read the parameter nullability facts in the supplied evidence.",
          focus: "Judge whether the implementation distrusts its own declared machinery — vacuous in the typed reading yet reachable in the type-blind one.",
          decision_boundary: [
            "A typeof, null, or instanceof check excluding a case the annotated parameter type already excludes, with no boundary signal in the function, is strong evidence of a distrustful guard.",
            "Any boundary crossing — deserialization, network input, environment values, or an any or unknown annotation — answers the question negatively.",
            "Documented defense-in-depth at that layer answers the question negatively.",
            "If the guarded-out case is not already excluded by the declared type alone, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "The guard re-checks what the parameter's own declared type already guarantees with no boundary in between",
            remedy: "Remove the vacuous guard and let the declared type carry the contract",
          },
          false: {
            what: "The guard narrows a genuinely open case, or a boundary crossing justifies the runtime check",
          },
        },
      },
      message: "This guard re-checks what the declared type already guarantees.",
    },

    "jev/no-divergent-inverses": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this function and its named inverse cover different sets of cases, so a round trip can silently lose information?",
          inspect: "Compare the fields, keys, and variants handled on each side of the pair, the writer-only and reader-only sets, and whether any asymmetry is documented or domain-mandated in the supplied evidence.",
          focus: "Judge whether a value passing through both functions in sequence can come back with user-relevant data missing.",
          decision_boundary: [
            "A writer that emits fields carrying user data which the reader ignores is strong evidence of divergent inverses.",
            "A one-field difference where the extra field is a documented cache hint recomputed on read is weak evidence on its own.",
            "Pairs that are intentionally lossy and documented, or asymmetries required by the domain, answer the question negatively.",
            "A single function with no identifiable inverse in the module is insufficient; the pair must exist to compare coverage.",
            "If the evidence does not establish that the uncovered cases carry information a round trip must preserve, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "The function and its named inverse handle different case sets, so round-tripping a value drops information the reader never restores",
            remedy: "Extend the reader to cover the missing cases or narrow the writer to the documented round-trip contract",
          },
          false: {
            what: "Both sides cover the same cases, the difference is documented or domain-mandated, or no inverse pair exists to compare",
          },
        },
      },
      message: "This function and its named inverse cover different cases, so a round trip can lose information.",
    },
    "jev/no-lopsided-error-handling": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this function guard some same-kind operations against failure while leaving their siblings bare?",
          inspect: "Compare the guarded and unguarded operations within each same-kind group, whether one outer handler covers the whole body uniformly, and the callee contracts visible in the supplied evidence.",
          focus: "Judge whether parallel operations receive parallel failure treatment, or some siblings are left exposed without reason.",
          decision_boundary: [
            "Several same-service operations where most sit inside handlers and one sibling runs bare with no outer coverage is strong evidence of lopsided handling.",
            "One bare operation whose callee is marked non-throwing beside guarded throwing calls is weak evidence on its own.",
            "A single outer handler covering the whole body uniformly is symmetric handling, not lopsided.",
            "Operations that are provably infallible in context do not need guards and do not create asymmetry.",
            "If the evidence does not show same-kind operations with genuinely different failure exposure, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "Same-kind fallible operations in one body receive different failure treatment, leaving some siblings exposed",
            remedy: "Extend the existing guard to the bare siblings or add an outer handler that covers the group uniformly",
          },
          false: {
            what: "All same-kind operations share one handler, the bare operations cannot fail, or no comparable group exists",
          },
        },
      },
      message: "This function guards some same-kind operations while leaving their siblings bare.",
    },
    "jev/no-repeated-predicate": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this function test one identical predicate two or more times instead of testing it once and naming the outcome?",
          inspect: "Compare the repeated test expressions, their positions, whether any occurrence binds the result to a name, and whether intervening awaits or mutations sit between the tests in the supplied evidence.",
          focus: "Judge whether the function re-proves a fact it already established instead of naming it once and reusing the name.",
          decision_boundary: [
            "One predicate tested several times with no intervening mutation and never bound to a name is strong evidence of a repeated predicate.",
            "Two tests separated by an await that can plausibly change the underlying state are weak evidence on their own.",
            "Re-testing after code that mutates the predicate's inputs is legitimate revalidation, not repetition.",
            "One test bound to a name and reused through that name is the elegant shape and answers the question negatively.",
            "If the evidence does not show the same predicate evaluated more than once without a reason, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "The same predicate is evaluated multiple times without binding the outcome, missing a single named test",
            remedy: "Evaluate the predicate once, bind the result to a descriptive name, and reuse it",
          },
          false: {
            what: "Each test follows a state change, the outcome is already named and reused, or no predicate repeats",
          },
        },
      },
      message: "This function tests one predicate repeatedly instead of naming the outcome once.",
    },
    "jev/no-overloaded-boolean-return": {
      scope: "function",
      question: {
        instructions: {
          question: "Do callers read this function's boolean result under two or more distinct meanings?",
          inspect: "Compare the conditions behind each boolean return point with how each call site branches on the result and what each branch consequence assumes in the supplied evidence.",
          focus: "Judge whether one boolean carries several meanings that callers must disambiguate with extra state.",
          decision_boundary: [
            "Boolean returns from semantically distinct conditions, with call sites acting on different readings and one caller consulting extra state to tell which, is strong evidence of an overloaded return.",
            "Call sites that share one reading of the result while differing only in follow-up actions are weak evidence on their own.",
            "A genuine predicate over one property, however widely called, answers the question negatively.",
            "A single boolean return point with no distinct conditions is insufficient; multiple readings must be shown.",
            "If the evidence does not show callers assigning different meanings to the same result, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "One boolean result means different things on different paths, forcing callers to disambiguate with extra state",
            remedy: "Split the function per meaning or return a descriptive value that names the outcome",
          },
          false: {
            what: "All call sites share one reading of a single-property predicate, or no distinct meanings are shown",
          },
        },
      },
      message: "This function's boolean result carries more than one meaning across its callers.",
    },
    "jev/no-parallel-enumerations": {
      scope: "abstraction",
      question: {
        instructions: {
          question: "Do two literal sets in this codebase have to agree with each other while nothing derives one from the other?",
          inspect: "Compare the owning literal set with its corresponding sibling set, their shared and differing members, and any mapping function in the supplied evidence.",
          focus: "Judge whether parallel vocabularies must be kept in sync by hand, not whether the two sets merely overlap.",
          decision_boundary: [
            "Corresponding sets with a shared stem that evolved independently, where members were added to one side without the other, are strong evidence of manual sync burden.",
            "One set derived from the other through keyof, a mapped type, indexed access, or codegen answers the question negatively.",
            "Sets that are intentionally different projections with a documented mapping function between them answer the question negatively.",
            "Name correspondence alone is never enough. If no sibling set shares members with the candidate, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "Two corresponding literal sets enumerate the same concept independently, so every change must be replayed by hand",
            remedy: "Derive one set from the other with keyof, a mapped type, or codegen, or collapse them into one source of truth",
          },
          false: {
            what: "The sets are independent concepts, one derives from the other, a documented mapping owns the difference, or no corresponding sibling exists",
          },
        },
      },
      message: "Two literal sets must agree manually instead of deriving from one source.",
    },
    "jev/no-synonym-vocabulary": {
      scope: "abstraction",
      question: {
        instructions: {
          question: "Does this module use three or more verbs for one operation concept, forcing readers to learn false distinctions?",
          inspect: "Compare the verbs applied to each shared entity stem, their function sources, signatures, and effects in the supplied evidence.",
          focus: "Judge multiplicity per concept, not whether any single name is clear on its own.",
          decision_boundary: [
            "Three or more verbs on one entity stem with interchangeable signatures and effects are strong evidence of synonym sprawl.",
            "Verbs that mark real distinctions evidenced by contracts, such as network fetch versus cache lookup, answer the question negatively.",
            "Verbs attached to different entities, and vocabulary dictated by an external framework convention, answer the question negatively.",
            "Two verbs for one concept are pairing, not sprawl. If no entity carries three distinct verbs, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "One operation concept is spelled with several interchangeable verbs in one module",
            remedy: "Settle on one verb per concept and rename the outliers, keeping distinct verbs only where contracts genuinely differ",
          },
          false: {
            what: "Each verb marks a real contractual distinction, the verbs attach to different concepts, or no concept carries three verbs",
          },
        },
      },
      message: "One module uses several verbs for one operation concept.",
    },
    "jev/no-knob-multiplicity": {
      scope: "abstraction",
      question: {
        instructions: {
          question: "Is one operational concept governed by three or more distinct control mechanisms with no stated precedence?",
          inspect: "Compare the control mechanisms per concept stem, their repository sites, and any ordering code in the supplied evidence.",
          focus: "Judge mechanism count per concept, not total configuration volume.",
          decision_boundary: [
            "Three or more mechanisms for one stem, such as env var plus CLI flag plus config key, with contradictory values resolving by accident of read order, are strong evidence of knob sprawl.",
            "An explicit, exercised precedence chain that orders the mechanisms answers the question negatively.",
            "Mechanisms serving different audiences at different layers, such as deploy-time versus request-time, answer the question negatively.",
            "Two mechanisms are conventional pairing, not multiplicity. If fewer than three distinct mechanisms govern the concept, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "One concept answers to several independent control mechanisms whose conflicts resolve by accident",
            remedy: "Keep one mechanism per concept, or state and exercise an explicit precedence order among them",
          },
          false: {
            what: "The concept has at most two mechanisms, precedence is explicit and exercised, or the mechanisms serve distinct layered audiences",
          },
        },
      },
      message: "One operational concept is governed by several control mechanisms with no stated precedence.",
    },
    "jev/no-boolean-fanout": {
      scope: "abstraction",
      question: {
        instructions: {
          question: "Do three or more booleans sharing one stem enumerate the states of a single discriminant that is never named?",
          inspect: "Use the boolean cluster, its shared stem, the call sites setting several members, mutual-exclusion logic, and typed usages in the supplied evidence.",
          focus: "Judge whether the cluster is one enum-shaped choice missing its name, not whether correlated booleans risk contradiction.",
          decision_boundary: [
            "Same-stem booleans where call sites set exactly one each, or runtime checks enforce mutual exclusion, are strong evidence of an unnamed discriminant.",
            "Booleans that call sites freely combine, with no exclusion assumption anywhere, answer the question negatively.",
            "Genuinely independent flags that merely share a prefix, with no shared choice behind them, answer the question negatively.",
            "A nearby tagged union already naming the discriminant answers the question negatively.",
            "Fewer than three same-stem booleans are never enough. If no cluster reaches width three, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "An enum-shaped boolean cluster encodes one choice that the type never names, forcing exclusion by convention",
            remedy: "Replace the boolean cluster with a named discriminant such as a union or enum",
          },
          false: {
            what: "The booleans combine freely as independent dimensions, a tagged union already names the choice, or no cluster reaches width three",
          },
        },
      },
      message: "Several same-stem booleans enumerate states of an unnamed discriminant.",
    },

    "jev/no-hand-rolled-uuid": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this id generator reimplement crypto.randomUUID with no demonstrated need for a different id shape?",
          inspect: "Compare the random assembly calls and template shape with the id-shape classification, any fixed prefix, randomUUID availability in the module, and the repository callers in the supplied evidence.",
          focus: "Judge whether the local generator is gratuitous duplication of the platform capability for ordinary ids, not whether its randomness is strong enough for secrets.",
          decision_boundary: [
            "A v4-shaped random string assembled from Math.random for correlation ids on a runtime with randomUUID in scope is strong evidence of reimplementation.",
            "Orderable, short, or prefixed ids whose shape the callers sort on or expose, with tests pinning that shape, weaken the claim toward a demonstrated difference.",
            "A fixed namespace prefix or custom alphabet the replacement cannot express weakens the claim further.",
            "Values minted for adversary-facing secrets belong to the token-strength question, not this one; if the id guards a secret, answer no.",
            "If no id-shaped assembly reaches a non-security consumer, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "An id generator reimplements crypto.randomUUID for ordinary ids with no demonstrated need for its differences",
            remedy: "Call crypto.randomUUID for v4-shaped ids, or document the shape requirement the platform call cannot satisfy",
          },
          false: {
            what: "The id shape is orderable, short, or prefixed by a demonstrated caller need, or the value guards an adversary-facing secret",
          },
        },
      },
      message: "This id generator reimplements crypto.randomUUID.",
    },
    "jev/no-hand-rolled-promise-timeout": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this timeout race reimplement AbortSignal.timeout with no demonstrated need for its differences?",
          inspect: "Compare each setTimeout race leg and its timeout wording with the cleanup handling, whether an abort signal is already threaded to the task, and the repository callers in the supplied evidence.",
          focus: "Judge whether the manual deadline mechanism duplicates the platform timeout, not whether the attempt carries any deadline at all.",
          decision_boundary: [
            "A manual setTimeout race around a fetch call that natively accepts a signal, with no signal threaded, is strong evidence of reimplementation.",
            "Cleanup semantics beyond abort, such as resource release the signal path cannot run, weaken the claim toward a demonstrated difference.",
            "A task whose API accepts no signal and a legacy engine floor that predates AbortSignal.timeout weaken the claim further.",
            "A single attempt with no deadline mechanism at all belongs to the unbounded-wait question, not this one.",
            "If no manual timeout race reaches a signal-capable task, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "A timeout race reimplements AbortSignal.timeout with no demonstrated need for its differences",
            remedy: "Pass AbortSignal.timeout to the signal-capable task, or document the cleanup the signal path cannot express",
          },
          false: {
            what: "The deadline carries cleanup beyond abort, the task accepts no signal, or no manual timeout race exists",
          },
        },
      },
      message: "This timeout race reimplements AbortSignal.timeout.",
    },
    "jev/no-hand-rolled-event-bus": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this pub/sub wrapper reimplement EventTarget with no demonstrated need for its differences?",
          inspect: "Compare the listener registry shape and subscribe, unsubscribe, and emit methods with any wildcard, replay, or backpressure features, an installed emitter dependency, and the repository callers in the supplied evidence.",
          focus: "Judge whether the local bus duplicates platform event machinery, not whether the abstraction adds ceremony.",
          decision_boundary: [
            "A string-topic bus over a Map-of-Sets registry with a handful of subscribers and no advanced features is strong evidence of reimplementation.",
            "Wildcard topics, replay, or backpressure the subscribers demonstrably use weaken the claim toward a demonstrated difference.",
            "Typed-payload contracts the subscribers rely on weaken the claim further.",
            "A wrapper that merely forwards to EventTarget or an installed emitter without reimplementing the registry answers the question negatively.",
            "If no listener registry with subscribe and emit reaches real subscribers, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "A pub/sub wrapper reimplements EventTarget with no demonstrated need for its differences",
            remedy: "Consume EventTarget or the installed emitter directly, or document the wildcard, replay, or typing feature the platform call cannot satisfy",
          },
          false: {
            what: "Subscribers demonstrably use wildcard, replay, backpressure, or typed payloads, or no listener registry exists",
          },
        },
      },
      message: "This pub/sub wrapper reimplements EventTarget.",
    },
    "jev/no-hand-rolled-fetch-wrapper": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this transport helper rebuild what global fetch already does with no demonstrated need for lower-level control?",
          inspect: "Compare the node:http request assembly and chunk handling with any proxy, agent, socket, or streaming configuration, the JSON helper shape, and the repository callers in the supplied evidence.",
          focus: "Judge whether the helper duplicates the platform transport, not whether its contract hides I/O cost.",
          decision_boundary: [
            "A simple GET or POST JSON helper assembled over node:https chunk listeners on a runtime with global fetch is strong evidence of reimplementation.",
            "Proxy agents, custom socket handling, or streaming backpressure the call sites configure weaken the claim toward a demonstrated need for control.",
            "Keep-alive or connection-pool tuning the callers demonstrably rely on weakens the claim further.",
            "A correctly named wrapper that delegates to global fetch answers the question negatively.",
            "If no low-level request assembly reaches a plain JSON consumer, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "A transport helper rebuilds what global fetch already does with no demonstrated need for lower-level control",
            remedy: "Delegate to global fetch, or document the proxy, socket, or streaming control the platform call cannot satisfy",
          },
          false: {
            what: "Call sites configure proxy, socket, keep-alive, or streaming behavior the platform call cannot express",
          },
        },
      },
      message: "This transport helper rebuilds what global fetch already does.",
    },
    "jev/no-fs-recursive-reinvent": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this recursive walk reimplement the node:fs recursive options with no demonstrated extra semantics?",
          inspect: "Compare the readdir traversal or exists-check chain and the self-recursion with any filtering, dry-run reporting, or per-entry error tolerance, and the repository callers in the supplied evidence.",
          focus: "Judge whether the local recursion duplicates the platform recursive option, not whether similar logic exists elsewhere in the repo.",
          decision_boundary: [
            "A plain recursive remove or make with no filter, dry run, or error tolerance is strong evidence of reimplementation.",
            "Keep-glob filtering, dry-run reporting, or per-entry error tolerance the callers rely on weaken the claim toward demonstrated extra semantics.",
            "A walk that computes per-entry results rather than merely removing or creating weakens the claim further.",
            "A call that already passes the recursive option answers the question negatively.",
            "If no recursive traversal or exists-check chain reaches a plain remove or make, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "A recursive walk reimplements the node:fs recursive options with no demonstrated extra semantics",
            remedy: "Pass the recursive option to the node:fs call, or document the filtering, dry-run, or tolerance behavior the option cannot satisfy",
          },
          false: {
            what: "Callers rely on filtering, dry-run reporting, per-entry tolerance, or per-entry results, or the recursive option is already used",
          },
        },
      },
      message: "This recursive walk reimplements the node:fs recursive options.",
    },
    "jev/no-hand-rolled-string-hash": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this hash function reimplement available hashing for non-security bucketing with no demonstrated need for its exact values?",
          inspect: "Compare the bitwise fold loop and algorithm family with the bucketing callers, any test pinning of exact values, benchmark or hot-path notes, node:crypto availability, and seed support in the supplied evidence.",
          focus: "Judge whether the local hash gratuitously duplicates an available primitive for non-security use, not whether the digest is strong enough to protect data.",
          decision_boundary: [
            "A djb2 fold over char codes for cache-bucket keys beside node:crypto usage, with no pinning or benchmark note, is strong evidence of gratuitous reimplementation.",
            "A hot-path benchmark comment, stable cross-language values a contract pins, or seedable hashing the replacement lacks weaken the claim toward a demonstrated need.",
            "Exact values pinned by tests the callers depend on weaken the claim further.",
            "Digests that guard passwords, integrity checks, or authentication decisions belong to the strength question, not this one; if the digest sits in a security position, answer no.",
            "If the fold never serves a non-security consumer, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "A hash function reimplements available hashing for non-security bucketing with no demonstrated need for its exact values",
            remedy: "Hash with node:crypto or the installed hash dependency, or document the pinned values, benchmark, or seed behavior the replacement cannot satisfy",
          },
          false: {
            what: "Tests pin exact values, a benchmark justifies the hot path, seeding is exercised, or the digest guards a security decision",
          },
        },
      },
      message: "This hash function reimplements available hashing for non-security bucketing.",
    },

    "jev/no-mystery-literal-argument": {
      scope: "change",
      question: {
        instructions: {
          question: "Does a changed call site pass a literal whose meaning a reader cannot recover without opening the callee?",
          inspect: "Compare each changed call with its literal argument, the resolved parameter name and type, and the callee branches or literal comparisons selecting behavior in the supplied evidence.",
          focus: "Judge whether the literal selects behavior defined only inside the callee body, forcing readers to leave the call site to understand the call.",
          decision_boundary: [
            "A changed literal that selects a disjoint callee path compared against sibling literals is strong evidence of a mystery argument.",
            "Widely conventional literals such as encodings answer the question negatively even when the callee branches on them.",
            "Literals passed to parameters the callee never branches on or compares are ordinary data, not behavior selectors.",
            "Named arguments and options objects already label the value at the call site.",
            "If no changed call resolves to a callee that selects on the parameter, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "A changed call passes an unexplained literal that selects callee behavior defined only inside the callee",
            remedy: "Pass a named constant or an options object so the call site states its intent",
          },
          false: {
            what: "The literal is conventional, pure data, already labeled, or the callee does not select on it",
          },
        },
      },
      message: "This call passes a literal only the callee can explain.",
    },
    "jev/no-unexplained-domain-threshold": {
      scope: "function",
      question: {
        instructions: {
          question: "Does a comparison, equality check, index, or slice in this function embody domain knowledge no reader can recover?",
          inspect: "Compare each extracted literal threshold with the value it is tested against, nearby comments, constraining types, sibling named constants, and reuse of the same value elsewhere in the supplied evidence.",
          focus: "Judge whether a reader can answer why this value and not another without asking the author.",
          decision_boundary: [
            "A bare domain cap such as a retry limit with sibling values already named is strong evidence of unexplained knowledge.",
            "Boundary checks on 0 or 1 with self-evident meaning answer the question negatively.",
            "Thresholds owned by a configuration source belong to config-shadow reasoning; this question is about values no config owns.",
            "A named constant on either side of the comparison already explains the value.",
            "If every extracted threshold carries a nearby rationale or a constraining type, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "A bare literal threshold encodes a why-this-value choice no name, comment, or type explains",
            remedy: "Name the constant or record the rationale beside the comparison",
          },
          false: {
            what: "The value is self-evident, already named, explained nearby, constrained by a type, or no bare threshold exists",
          },
        },
      },
      message: "This threshold encodes domain knowledge no reader can recover.",
    },
    "jev/no-verbless-function-name": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this function name state no action, so callers cannot tell what the call does without reading the body?",
          inspect: "Compare the function name and its first word with the extracted body effects, branch selection, framework shaping, callers, and verb-aliased callers in the supplied evidence.",
          focus: "Judge whether the name leaves the action entirely to the implementation while the body performs effects or selection.",
          decision_boundary: [
            "A bare noun name over a body with effects and branches, with callers inventing verb aliases, is strong evidence of a missing verb.",
            "Vague verbs such as process or handle belong to mysterious-name reasoning; this question is about the absence of any verb.",
            "Conventional noun-named constructors, factories, or framework-mandated components answer the question negatively.",
            "Pure projections with no effects and no selection need no verb.",
            "If the name already carries a verb head or boolean-predicate prefix, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "A noun-only name hides the action of a body that performs effects or selection",
            remedy: "Rename with a verb phrase stating what the call does",
          },
          false: {
            what: "The name carries a verb, follows a framework convention, or the body is a pure projection",
          },
        },
      },
      message: "This function name states no action.",
    },
    "jev/no-misdirecting-error-message": {
      scope: "function",
      question: {
        instructions: {
          question: "Does an error message assert a cause the throwing code cannot establish, sending readers to the wrong fix?",
          inspect: "Compare each extracted message and its named cause with the checked signals in scope, catch enclosure, and cause linkage in the supplied evidence.",
          focus: "Judge whether the message invents a specific cause rather than reporting what the code actually verified.",
          decision_boundary: [
            "A specific cause such as network failure thrown on a path that never touches the network is strong evidence of misdirection.",
            "Messages restating the checked precondition that just failed answer the question negatively.",
            "Empty or generic messages belong to contextless-error reasoning; this question needs an asserted cause.",
            "Information dropped while translating a caught error belongs to lossy-error-translation; this question is about causes invented at the throw site.",
            "If the scope checks the named cause or links it via cause or interpolation, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "The message names a specific cause the throwing code never checked or linked",
            remedy: "Report what the code verified and attach the underlying cause",
          },
          false: {
            what: "The message restates a checked precondition, carries no specific cause, or the cause is verified and linked",
          },
        },
      },
      message: "This error message asserts a cause the code never established.",
    },
    "jev/no-ambiguous-positional-siblings": {
      scope: "function",
      question: {
        instructions: {
          question: "Do adjacent same-type parameters stay silently swappable at every call site, so readers cannot verify order without the callee open?",
          inspect: "Compare each adjacent same-type pair with its conventional ordering, the positional call sites and their argument shapes, and the object-argument callers in the supplied evidence.",
          focus: "Judge whether a reader at any call site can tell which value is which without opening the callee.",
          decision_boundary: [
            "Adjacent independent same-type parameters with computed same-shape arguments at every call site is strong evidence of order opacity.",
            "Same-type pairs with an established domain order and named callers answer the question negatively.",
            "Long signatures in general belong to unwieldy-signature reasoning and trailing growth to positional-extension-drift; this question is about one swappable adjacent pair.",
            "A coherent parameter group that wants an object belongs to unnamed-parameter-object reasoning; this question covers independent values with no object to name.",
            "If callers already pass an object or the types are branded apart, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "Adjacent same-type parameters are positionally interchangeable at every call site with nothing distinguishing the order",
            remedy: "Introduce distinct brands, an options object, or names that make the order self-evident",
          },
          false: {
            what: "The order follows an established convention, callers label their values, or the types already distinguish the positions",
          },
        },
      },
      message: "These adjacent parameters are silently swappable at every call site.",
    },

    "jev/no-deceptive-name": {
      scope: "function",
      question: {
        instructions: {
          question: "Does a name in this function assert a property its value contradicts?",
          inspect: "Compare each flagged identifier with its initializer or type annotation, the establishing operations found in the body, same-name reuses in other files, and repository callers in the supplied evidence.",
          focus: "Judge whether a reader reasoning from the name alone would start from a false premise about plurality, container shape, boolean type, or an established quality such as sorted or safe.",
          decision_boundary: [
            "A plural noun holding a singular value, a list or map word holding a different container, an is or has prefix on a non-boolean, or a sorted or safe claim with no establishing operation are strong evidence of deception.",
            "Mildly loose collective nouns over genuinely mixed bags answer the question negatively.",
            "Conventional denylist names such as status are not plural claims.",
            "If the evidence does not establish what the value actually holds, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "An identifier promises plurality, a container shape, a boolean predicate, or an established quality the value or body does not deliver",
            remedy: "Rename the identifier to state what the value actually is, or change the value to honor the name",
          },
          false: {
            what: "Names match their values, the looseness is conventional, or the evidence does not establish a contradiction",
          },
        },
      },
      message: "This name asserts a property its value contradicts.",
    },
    "jev/no-punned-name": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this function name carry a different meaning in another declaration, so callers import the wrong meaning?",
          inspect: "Compare the candidate signature with each same-name sibling signature and the repository callers in the supplied evidence.",
          focus: "Judge whether one name denotes two or more incompatible parameter or return shapes across its uses, where each individual use reads clearly on its own.",
          decision_boundary: [
            "Same name with divergent parameter counts, parameter types, or return types used by callers in different files is strong evidence of punning.",
            "Mild overloads sharing an obvious core idea answer the question negatively.",
            "Identical shapes under one name are one meaning, not a pun.",
          ],
        },
        criteria: {
          true: {
            what: "One name denotes incompatible shapes across declarations that different callers rely on",
            remedy: "Give each meaning its own name, or unify the shapes behind one contract",
          },
          false: {
            what: "The sibling shapes share one core idea, or no divergent same-name declaration exists",
          },
        },
      },
      message: "This name carries different meanings across its declarations.",
    },
    "jev/no-cryptic-abbreviation": {
      scope: "function",
      question: {
        instructions: {
          question: "Do abbreviated names in this function compress real words past recognition?",
          inspect: "Compare each flagged identifier and its suspect segments with the segment counts, the module context, and the expanded terms found nearby in the supplied evidence.",
          focus: "Judge whether a reader must keep a private decode table because consonant clusters or stacked shortenings replaced words the surrounding module states in full.",
          decision_boundary: [
            "Multiple vowel-stripped or stacked-shortened segments with the full terms present in adjacent types, docs, or tests are strong evidence of over-compression.",
            "One standard domain abbreviation used consistently, with no fuller term nearby, answers the question negatively.",
            "Ordinary dictionary words, however terse, are not abbreviations.",
          ],
        },
        criteria: {
          true: {
            what: "Identifiers compress real words past recognition while the module states the full terms nearby",
            remedy: "Expand the abbreviations to the full words the module already uses",
          },
          false: {
            what: "The shortenings are standard domain vocabulary used consistently, or the full terms appear nowhere nearby",
          },
        },
      },
      message: "These abbreviations compress real words past recognition.",
    },
    "jev/no-negative-boolean-name": {
      scope: "function",
      question: {
        instructions: {
          question: "Does a negated boolean name in this function force double negatives at read sites?",
          inspect: "Compare each flagged boolean binding with its negated reads and the repository callers in the supplied evidence.",
          focus: "Judge whether readers must resolve two mental negations, such as a logical not applied to an isNot or disable name, to know which arm runs.",
          decision_boundary: [
            "A negated name read under logical not or compared against false at multiple sites, including callers branching on the double negative, is strong evidence.",
            "One internal negative flag never negated at any read answers the question negatively.",
            "Positive-form names with a single negation are ordinary boolean use.",
          ],
        },
        criteria: {
          true: {
            what: "A negated boolean name is read under further negation, forcing double negatives",
            remedy: "Rename the boolean to its positive form and flip the reads",
          },
          false: {
            what: "The negative name is never negated at reads, or the negations shown are ordinary single negations of positive names",
          },
        },
      },
      message: "This negated boolean name forces double negatives at read sites.",
    },
    "jev/no-unitless-quantity": {
      scope: "function",
      question: {
        instructions: {
          question: "Does a numeric value flow through a time, size, angle, or rate position with no unit in its name or type?",
          inspect: "Compare each flagged quantity with its sink calls, the caller argument values at the same parameter position, and the repository callers in the supplied evidence.",
          focus: "Judge whether a reader can tell which scale applies, such as milliseconds versus seconds, from the name, the branded type, or the call sites.",
          decision_boundary: [
            "A unitless number passed to timer, date, buffer, or duration APIs, or sibling call sites passing differently scaled values to the same parameter, are strong evidence.",
            "A unitless count in a context where only one scale is physically plausible answers the question negatively.",
            "Unit suffixes or branded types that name the scale settle the question negatively.",
          ],
        },
        criteria: {
          true: {
            what: "A numeric quantity reaches a scale-sensitive position with no unit naming the scale",
            remedy: "Add the unit to the name or give the quantity a branded unit type",
          },
          false: {
            what: "The scale is named, branded, or physically unambiguous from context",
          },
        },
      },
      message: "This numeric quantity flows through a scale-sensitive position with no unit.",
    },

    "jev/no-layer-skipping-call": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this function call a deeper-layer module directly while bypassing an intermediate layer that enforces policy?",
          inspect: "Compare the direct call and its target layer with the intermediate modules the caller already imports that also reach the target, the guard excerpts in those intermediates, and how established each path is.",
          focus: "Judge whether the bypass skips validation, authorization, or shaping the repository routes through the intermediate, not whether direct calls are untidy in the abstract.",
          decision_boundary: [
            "A direct call to a target most callers reach through a guard-bearing intermediate is strong evidence of a skipped policy layer.",
            "An intermediate that merely re-exports without guards, validation, or shaping is a shell, not a policy layer.",
            "Nominal layers over a flat utility sprawl, and direct calls from tests or setup code, do not establish a bypassed policy.",
            "A pre-existing direct import used for an unrelated symbol weakens the claim that the new call is the bypass.",
            "If no guard-bearing intermediate sits on the established path, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "The call reaches a deeper module past an intermediate that guards the established path",
            remedy: "Route the call through the intermediate layer so its validation and policy apply",
          },
          false: {
            what: "The intermediate adds no policy, the layers are nominal, the call comes from tests or setup, or no guarded intermediate exists",
          },
        },
      },
      message: "This call reaches a deeper module past the intermediate layer that guards it.",
    },
    "jev/no-chatty-interface": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this function make repeated cross-module calls in a loop where one call would serve?",
          inspect: "Use the per-item calls inside each loop, which arguments stay invariant across iterations, whether the calls run sequentially, and whether the target already offers a batch-shaped sibling.",
          focus: "Judge whether the interface tells callers the wrong story about cost by forcing one round trip per item when a single call could carry the loop.",
          decision_boundary: [
            "Sequential per-item calls with loop-invariant arguments and an existing batch export are strong evidence of a chatty interface.",
            "Per-item failure isolation as the evident intent, with each item needing its own outcome, weakens the batch claim.",
            "A small bounded loop, or a target with no batch-shaped sibling anywhere nearby, leaves the caller no better shape to use.",
            "Same-module calls are local work, not cross-module round trips.",
            "If the loop carries no cross-module call or no batch alternative exists, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "The loop issues one cross-module round trip per item although a batch-shaped call would serve",
            remedy: "Add or use a batch entry point so the loop becomes a single call",
          },
          false: {
            what: "The loop is bounded, per-item isolation is the intent, no batch shape exists, or the calls stay inside the module",
          },
        },
      },
      message: "This loop makes one cross-module call per item where a single batch call would serve.",
    },
    "jev/no-partitioned-fat-interface": {
      scope: "abstraction",
      question: {
        instructions: {
          question: "Does this class expose a wide surface whose methods serve disjoint caller populations?",
          inspect: "Compare each public method's caller-file set with every other method's, noting pairs with no shared callers and whether one dominant client or a shared audience explains the surface.",
          focus: "Judge whether one client group carries the evolution risk of another group's methods, not whether the class is merely large or internally incohesive.",
          decision_boundary: [
            "Two sizable caller populations with near-zero file overlap across method groups are strong evidence of a partitioned surface.",
            "One dominant client, heavy caller overlap, or a deliberate facade over a stable domain keeps the surface coherent.",
            "Shared state between method groups does not by itself reunite audiences that never overlap.",
            "A handful of callers total is weak evidence of distinct populations.",
            "If the caller sets overlap heavily or one audience dominates, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "Disjoint caller populations share one surface, so each group absorbs the other's evolution risk",
            remedy: "Split the surface so each audience depends only on the methods it uses",
          },
          false: {
            what: "One audience dominates, caller sets overlap, the surface is a deliberate facade, or too few callers establish a partition",
          },
        },
      },
      message: "This class serves disjoint caller populations through one shared surface.",
    },
    "jev/no-dev-dependency-runtime-leak": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this runtime file reach a development-only dependency or test-marked module from a shipped path?",
          inspect: "Use the matched manifest section for each import, whether the imported symbol is used in a value position, the test markers on resolved targets, and whether the owner is build-script-adjacent.",
          focus: "Judge whether production behavior couples to dev tooling, not whether the import list mentions a dev package in passing.",
          decision_boundary: [
            "A shipped file importing a dev-listed package and using it at runtime is strong evidence of a dev-to-prod leak.",
            "Type-only imports erased at build, and packages correctly dual-listed in both sections, do not couple runtime behavior.",
            "Build scripts, tooling, and configuration-adjacent files legitimately reach dev dependencies.",
            "Test-marked targets reached from shipped paths couple production to test fixtures regardless of manifest section.",
            "If the symbol is type-only, the file is tooling, or the package is a runtime dependency, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "A shipped path uses a dev-only package or test-marked module at runtime",
            remedy: "Move the dependency to runtime dependencies or remove the shipped path's reliance on dev tooling",
          },
          false: {
            what: "The import is type-only, the file is tooling, the package is dual-listed, or no dev-section edge exists",
          },
        },
      },
      message: "This shipped file reaches a development-only dependency at runtime.",
    },
    "jev/no-cross-module-call-order": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this function call two same-target-module functions in an order the caller cannot verify, where the second reads state the first writes?",
          inspect: "Use the ordered callee pairs sharing one target module, the write and read evidence on the shared binding, the guard and combined-entry-point evidence, and the orderings at other call sites.",
          focus: "Judge whether a caller can trigger the wrong sequence without complaint because the ordering assumption lives invisibly across the module boundary.",
          decision_boundary: [
            "Target analysis confirming a write then read on one binding, with sibling call sites all using one order and no guard, is strong evidence of an unverifiable ordering assumption.",
            "A guard that rejects the uninitialized state, or a combined entry point that sequences the pair, makes the order explicit rather than assumed.",
            "Independent callees, a documented order, or a combined entry point the call site predates weaken the claim.",
            "Same-module reader and writer pairs belong to the temporal coupling judgment, not this one.",
            "If the callees share no write-read binding or the order is enforced, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "The call site assumes an order across a module boundary that nothing enforces or verifies",
            remedy: "Expose a combined entry point or guard so the order is explicit instead of assumed",
          },
          false: {
            what: "The callees are independent, a guard or combined entry verifies the order, or no shared write-read binding exists",
          },
        },
      },
      message: "These calls assume an order across a module boundary that nothing enforces.",
    },

    "jev/no-callback-return-split": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this function use a completion style that contradicts the surrounding module surface, forcing clients to hold two conventions?",
          inspect: "Compare the candidate's completion style with each sibling export's style, the module majority, and which outside importers touch each style in the supplied evidence.",
          focus: "Judge whether a client of this module must learn both callback and return conventions to use the surface, not whether either style is better in the abstract.",
          decision_boundary: [
            "A callback-shaped parameter beside return-styled siblings, with outside importers reaching both styles, is strong evidence of a split surface.",
            "A module mid-migration with adapter shims, or styles partitioned between internal helpers and the public surface, describes a transition rather than a contradiction.",
            "A lone export, or a surface where every sibling shares the candidate's style, leaves no convention to contradict.",
            "Handler-registration parameters for evented APIs are the API's subject matter, not a competing completion convention.",
            "If the evidence shows no minority style reachable by outside clients, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "The function completes differently from its module siblings while outside clients reach both styles",
            remedy: "Align the function with the module's majority completion style or split the surface into explicitly versioned alternatives",
          },
          false: {
            what: "The surface shares one completion style, the split is a documented migration, styles are partitioned by audience, or no outside client reaches the minority style",
          },
        },
      },
      message: "This function completes differently from its module siblings, splitting the surface convention.",
    },
    "jev/no-reentrant-entry": {
      scope: "function",
      question: {
        instructions: {
          question: "Is this exported function likely to run reentrantly against module state it mutates, through both registered-callback and direct-call reachability?",
          inspect: "Read the mutated module bindings, the direct callers, the registration-shaped call sites, and the guard scan in the supplied evidence.",
          focus: "Judge whether one activation can plausibly interleave with another against the same unguarded state, not whether shared state merely exists.",
          decision_boundary: [
            "Confirmed module-state mutation with both registration-shaped and direct call sites and no guard is strong evidence of reentrant exposure.",
            "An explicit in-progress flag, lock, depth counter, or disabled switch that the implementation checks is evidence the entry anticipates reentry.",
            "Registration and direct use that belong to one framework lifecycle, or mutation that only assigns an idempotent value, rarely produce a harmful interleave.",
            "A single reachability shape leaves no duality to judge.",
            "If the evidence does not establish both mutation and dual reachability, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "The function mutates module state and is reachable both as a registered callback and as a direct call without a reentry guard",
            remedy: "Guard the entry with an in-progress flag or lock, or separate the callback path from the direct-call path",
          },
          false: {
            what: "The entry is guarded, reachability follows one lifecycle, the mutation is idempotent, or dual reachability is not established",
          },
        },
      },
      message: "This exported entry mutates module state and is reachable both as a callback and as a direct call.",
    },
    "jev/no-implementation-type-in-signature": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this exported signature expose an infrastructure or library implementation type that binds callers to a detail they should not know?",
          inspect: "Compare each exposed parameter and return type with its origin, whether the target looks infrastructural, nearby domain alternatives, and the real callers in the supplied evidence.",
          focus: "Judge whether callers must now depend on the implementation detail to use the API, not whether the implementation itself uses the detail internally.",
          decision_boundary: [
            "A widely imported export naming a driver, client, or persistence type in its parameters or return, with a domain alternative nearby, is strong evidence of exposure.",
            "A module whose job is wrapping that library, with the type as its explicit subject matter, is an adapter doing its work rather than a leak.",
            "Standard builtins, locally declared domain aliases, and single-internal-caller helpers rarely bind an audience to a detail.",
            "An untyped signature, or one shaped only by local aliases, exposes nothing outside the module.",
            "If the evidence does not name an implementation type reachable by outside callers, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "An exported signature names an infrastructure or library type that outside callers must now depend on",
            remedy: "Introduce a domain-named alias or wrapper type and keep the implementation detail behind the module boundary",
          },
          false: {
            what: "The signature uses builtins or local domain types, the module is the adapter for that detail, or no outside caller reaches the exposure",
          },
        },
      },
      message: "This exported signature exposes an implementation type that callers should not need to know.",
    },
    "jev/no-unversioned-envelope-change": {
      scope: "change",
      question: {
        instructions: {
          question: "Does this changed message or envelope type alter its data contract without a versioning or compatibility affordance while cross-module consumers exist?",
          inspect: "Read the old-versus-new member diff, the consumer list, and the version field, discriminator, and shim signals in the supplied evidence.",
          focus: "Judge whether existing consumers can plausibly keep working, distinguishing additive-optional growth from required, removed, or retyped members.",
          decision_boundary: [
            "A newly required member, a removal, or a retype with several cross-module consumers and no version or discriminator field is strong evidence of an unversioned break.",
            "Purely additive-optional growth, a single-module envelope, or a version field or kind discriminator riding along usually keeps old consumers working.",
            "Explicit migration shims, compatibility aliases, or deprecation markers describe an author managing the transition.",
            "An unchanged member set, or a change with no cross-module consumers, leaves no contract evolution to judge.",
            "If the evidence shows no incompatible member change reaching outside consumers, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "The envelope gains a required member, loses a member, or retypes one while outside consumers exist and no versioning affordance accompanies the change",
            remedy: "Add the member as optional with a default, carry a version or discriminator field, or ship a migration shim for existing consumers",
          },
          false: {
            what: "The change is additive-optional, versioned, shimmed, confined to one module, or reaches no outside consumers",
          },
        },
      },
      message: "This envelope alters its data contract without a versioning or compatibility affordance.",
    },
    "jev/no-context-homonym-type": {
      scope: "abstraction",
      question: {
        instructions: {
          question: "Does this type share its name with a different-shaped type in another module, so the same word means two things across contexts?",
          inspect: "Compare the candidate's member set with each same-named declaration's members, the overlap ratios, and the import-confusion signals in the supplied evidence.",
          focus: "Judge whether a reader or importer can plausibly confuse the two meanings, not whether shared vocabulary is virtuous in the abstract.",
          decision_boundary: [
            "One name with disjoint members in modules that import each other, or that meet in a shared client, is strong evidence of a harmful homonym.",
            "Scoped or qualified usage that keeps the two meanings apart in practice weakens the confusion case.",
            "Mostly overlapping members describe genuine duplication, which belongs to the duplication rules rather than this one.",
            "A collision confined to tests, or a name unique across the project, leaves no cross-context confusion to judge.",
            "If the evidence shows no same-named, differently shaped declaration with a confusion path, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "The same type name denotes different member shapes in modules connected by imports or shared clients",
            remedy: "Rename one of the types to its bounded-context term, or extract the shared meaning into one imported definition",
          },
          false: {
            what: "The name is unique, the shapes genuinely duplicate each other, usage keeps the contexts apart, or the collision is test-only",
          },
        },
      },
      message: "This type name means different shapes in different modules, inviting cross-context confusion.",
    },
    "jev/no-wide-fan-in-edit": {
      scope: "change",
      question: {
        instructions: {
          question: "Does this edit touch a function with wide caller fan-in, so its ripple plausibly extends beyond the visible call sites?",
          inspect: "Read the caller total and distinct-file count, the export status, and whether the old-versus-new body comparison shows a behavioral change in the supplied evidence.",
          focus: "Judge whether the edit's observable behavior can reach callers the author may not have considered, not whether a widely used function merely exists.",
          decision_boundary: [
            "A behavioral body change to an exported function with callers across many files is strong evidence of wide ripple.",
            "An edit whose old and new bodies match observably, or callers confined to generated code and tests, rarely ripples beyond the visible sites.",
            "A narrow caller set, even with a behavioral change, keeps the blast radius inspectable.",
            "A function with no callers has no ripple to judge.",
            "If the evidence does not establish both fan-in and a behavioral change, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "A behavioral edit lands on a function whose callers span files beyond easy inspection",
            remedy: "Narrow the function's caller set first, or verify the changed behavior against each caller population",
          },
          false: {
            what: "The edit preserves observable behavior, callers are narrow or generated, or the function has no callers",
          },
        },
      },
      message: "This edit changes a widely called function, so its ripple extends beyond the visible call sites.",
    },

    "jev/no-unpinned-failure-path": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this function contain an error or failure path that no test or caller pins, so a wrong recovery stays green?",
          inspect: "Compare each extracted catch, throw, and error-return path with the test references naming the function, the repository callers, transitive pinning chains, and the related modules owning the error contract in the supplied evidence. A named transitive chain (test → seam → candidate) is one hop of test coverage reaching the function; weigh it against direct test references.",
          focus: "Judge the pinning gap, not whether the recovery is correct — a catch that maps a dependency failure to a domain error is only guarded when a test or caller depends on the mapping.",
          decision_boundary: [
            "A catch mapping a dependency failure to a domain error with zero test references and no caller depending on the mapped error is strong evidence of an unpinned failure path.",
            "A test that exercises a public seam which calls the function pins the failure path one hop away; weigh the named chain against direct test references.",
            "The same catch shape with callers visibly depending on the mapped error, or tests triggering the failure, pins the path even when the recovery looks odd.",
            "A rethrow that preserves the original error carries less weight than a mapping or a swallow, since callers still observe the failure.",
            "A function with no catch, throw, or error-return shape answers the question negatively.",
            "If no test reference or caller can be established either way, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "A reachable error or failure path has no test or caller pinning its recovery, so the suite cannot tell a wrong recovery from a right one",
            remedy: "Add a test triggering the failure and asserting the mapped error or recovery the callers depend on",
          },
          false: {
            what: "Tests or callers pin the failure path, the error propagates unchanged, or the function has no failure path",
          },
        },
      },
      message: "This function has an error path that no test or caller pins.",
    },
    "jev/no-incidental-snapshot": {
      scope: "function",
      question: {
        instructions: {
          question: "Do this test's snapshot assertions freeze incidental output that churns on unrelated changes, rather than pinning contractual behavior?",
          inspect: "Compare the snapshotted expression breadth with the outcome assertions on specific values, and whether the snapshotted shape is consumed by importers as a contract or only rendered incidentally, in the supplied evidence.",
          focus: "Judge what the snapshot pins, not snapshotting itself: a narrow snapshot of a versioned wire payload that callers consume is a contract, while a full-tree render with no focused assertion is incidental.",
          decision_boundary: [
            "A full-tree component snapshot with no other assertion on the rendered contract is strong evidence of incidental freezing.",
            "A narrow snapshot of a serialized wire payload that callers consume as a versioned contract pins deliberate behavior.",
            "Snapshot assertions alongside outcome assertions on the same contract weaken the claim, since the behavior is pinned twice.",
            "Inline snapshots with small explicit literals deserve less weight than large generated snapshots nobody reads.",
            "If the test states no snapshot assertion, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "The test's snapshots freeze broad incidental output while no assertion pins the contractual behavior underneath",
            remedy: "Replace the broad snapshot with focused assertions on the contractual values, keeping a narrow snapshot only for versioned wire shapes",
          },
          false: {
            what: "The snapshot pins a narrow contracted shape, outcome assertions carry the behavior, or the test uses no snapshots",
          },
        },
      },
      message: "This test's snapshot freezes incidental output instead of pinning contractual behavior.",
    },
    "jev/no-quarantined-test-coverage": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this disabled test leave behavior unpinned that no other test or caller covers, so the suite silently stops guarding it?",
          inspect: "Compare the disabled body — the subject exercised and assertions stated — with other test references to the same subject, repository callers covering the path, and any tracking-issue linkage, in the supplied evidence.",
          focus: "Judge the coverage gap left behind, not the reason for disabling: a skip with a tracking issue still leaves the behavior unguarded until something else covers it.",
          decision_boundary: [
            "The only test naming the subject is skipped and no caller exercises the path is strong evidence of silently lost coverage.",
            "A skipped case duplicating coverage that active tests still assert leaves the behavior guarded and answers the question weakly.",
            "Callers exercising the disabled path in production weaken the claim, since the behavior still runs under real use.",
            "A tracking-issue link explains the quarantine but does not restore coverage on its own.",
            "If the test holder carries no skip, todo, or quarantine modifier, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "A disabled test is the only guard for behavior that no other test or caller covers, so the suite silently stops checking it",
            remedy: "Re-enable the test, link it to its tracking issue, or move its assertions into an active test covering the same subject",
          },
          false: {
            what: "Active tests or callers still cover the disabled path, or the test is not disabled",
          },
        },
      },
      message: "This disabled test leaves behavior unpinned that nothing else covers.",
    },

    "jev/no-flag-shepherded-control-flow": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this function use a mutable local binding only to shepherd execution between statements instead of expressing the control flow directly?",
          inspect: "Compare each extracted flag with its write sites, later branch reads, write-to-branch distance, and escape signals in the supplied evidence.",
          focus: "Judge whether the binding carries control-flow information that direct branching, early returns, or structured control flow could state, not whether locals are used at all.",
          decision_boundary: [
            "A Boolean or nullish local written in one place and read only in later branch tests, with no other readers, is the central shape.",
            "Bindings that are returned, passed as arguments, captured by nested functions, or read as domain data carry meaning beyond shepherding and answer the question negatively.",
            "Numeric accumulators, string builders, and collection gatherers hold domain state rather than shepherd execution.",
            "A flag whose write and branch sit far apart forces more tracking than one set and tested together, but distance alone never decides.",
            "If the evidence shows no write-then-branch local, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "A mutable local exists only to ferry a decision between statements that direct control flow could express",
            remedy: "Return early, branch directly, or restructure so the decision is made where it is used",
          },
          false: {
            what: "Flag-shaped locals escape as values, hold domain state, or no write-then-branch local exists",
          },
        },
      },
      message: "This function shepherds execution through a mutable flag instead of expressing the control flow directly.",
    },
    "jev/no-inline-lifecycle-phases": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this function implement multiple lifecycle phases — input parsing or validation, computation, durable effects, presentation formatting — inline as one body, leaving no named seam where ordering, transaction, exception, or resource boundaries could attach?",
          inspect: "Compare the extracted phase regions and their spans, mixed statements, bindings shared across phases, per-phase collaborators and import sources, same-module phase helpers, and scopes spanning phases in the supplied evidence.",
          focus: "Judge whether the phases are implemented inline without seams, not how many collaborators the function touches or how long it is.",
          decision_boundary: [
            "Parsing, pricing, persisting, and rendering one record inline with shared bindings threaded through is the central shape even when the outcome is single.",
            "A boundary controller that parses input, invokes one use case, and maps its result already has seams at the use-case call and answers the question negatively.",
            "Pipelines threading one accumulator answer negatively where the work is one phase rather than several phases sharing dataflow.",
            "Same-module helpers that wrap a single phase, or a collaborator owning the middle of the pipeline, are seams even without extraction.",
            "Try or transaction scopes covering several phase regions show boundaries already attach somewhere; their absence strengthens the claim.",
            "If the evidence shows a single phase or none, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "The body implements several lifecycle phases inline with no named seam between them, so ordering, transaction, exception, and resource boundaries have nowhere to attach",
            remedy: "Split the phases behind named helpers or use-case calls so each boundary has a seam, preserving execution order",
          },
          false: {
            what: "The body covers one phase, delegates phases to named seams, or is already a thin boundary sandwich around a use-case call",
          },
        },
      },
      message: "This function implements multiple lifecycle phases inline with no named seam between them.",
    },

    "jev/no-unused-exported-helper": {
      scope: "function",
      question: {
        instructions: {
          question: "Is this exported function retained in the codebase although no production code uses it?",
          inspect: "Use the zero-production-caller reading with the named test callers, the symbol importers, the barrel re-export paths, the same-file references, the dynamic-import and registration leads, and the module initialization calls in the supplied evidence.",
          focus: "Judge whether retention is abandonment or unintegrated API rather than deliberate public surface. An export whose only callers live in test files is itself the finding, dead API or missing integration, never liveness.",
          decision_boundary: [
            "Zero production callers with zero symbol importers, no re-export path, no textual leads, and no module initialization work is strong evidence of an abandoned export.",
            "An export called only from test files remains evidence of dead API or missing integration: weigh the named test callers as the finding rather than as production use.",
            "A barrel re-export, a production symbol importer, a dynamic-import or framework-registration lead, or same-name callback passing answers the question negatively as deliberate retention. Test-path importers do not.",
            "jev/no-single-caller-exported-helper scores the exactly-one-production-caller seam and jev/no-retained-superseded-implementation scores the marked end; this scores the unmarked zero-production-caller remainder.",
          ],
        },
        criteria: {
          true: {
            what: "An unmarked exported function with no production callers, no production importers, no re-export path, and no liveness leads, including one called only from test files",
            remedy: "Delete the unused export, integrate it into production code, or keep it behind a documented public entry point if external consumers need it",
          },
          false: {
            what: "The function shows a production liveness signal such as a production caller, a re-export, a production importer, a registration lead, or initialization work",
          },
        },
      },
      message: "This exported function has no production callers and nothing re-exports it.",
    },
    "jev/no-commented-out-implementation": {
      scope: "comment",
      question: {
        instructions: {
          question: "Is this comment block a disabled implementation retained in the source rather than documentation of the live code?",
          inspect: "Compare the stripped text with its parsed statement shape, brace and semicolon signals, prose-line mixing, unresolved identifiers, and the adjacent live duplicate in the supplied evidence.",
          focus: "Judge whether the block is dead code wearing comment syntax, not whether any single line looks executable.",
          decision_boundary: [
            "Multi-line parseable statements referring to symbols absent from the repository, beside a live duplicate of the same logic, are strong evidence of a disabled implementation.",
            "Fragmentary content, prose mixed with code such as usage examples or wire formats, and identifiers that still resolve to live declarations answer the question negatively.",
            "Example-shaped comments are the persistent liveness alternative this rule must weigh, not dismiss.",
            "jev/no-stale-comment scores prose claims contradicting code; this scores code-shaped text that prose rules never examine.",
          ],
        },
        criteria: {
          true: {
            what: "A comment block holding parseable implementation statements disconnected from live declarations",
            remedy: "Delete the commented-out implementation, or restore it as live code with tests if it is still needed",
          },
          false: {
            what: "The block is documentation, an example, a config sample, or prose that merely mentions code",
          },
        },
      },
      message: "This comment block is a disabled implementation retained in the source.",
    },
    "jev/no-unmarked-abandoned-compat-layer": {
      scope: "function",
      question: {
        instructions: {
          question: "Is this compatibility-named implementation retained although its migration appears complete?",
          inspect: "Use the compat-naming match with the zero-caller reading, each token-overlapping successor and its use count, and the symbol importers and re-export paths in the supplied evidence.",
          focus: "Judge whether the migration is finished and the old layer remains as history, not whether compat naming alone looks stale.",
          decision_boundary: [
            "Compat naming with zero callers and an actively used token-overlapping successor is strong evidence of a completed migration left behind.",
            "Compat naming alone is weak, since many versioned modules are the current contract; zero callers without an in-use successor belongs to the unused-export question, not this one.",
            "A barrel re-export or external-consumer exposure lowers the probability without clearing it.",
            "jev/no-retained-superseded-implementation scores the marked end and jev/no-change-stranded-code scores the migration moment; this scores the unmarked post-migration remainder.",
          ],
        },
        criteria: {
          true: {
            what: "An unmarked compat-named implementation with no callers beside an actively used successor",
            remedy: "Remove the abandoned compat layer now that the successor carries the callers",
          },
          false: {
            what: "The naming is current-contract versioning, no in-use successor exists, or callers and consumers remain",
          },
        },
      },
      message: "This compat layer has no callers while its successor serves the repository.",
    },

    "jev/no-variant-partitioned-helper": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this shared helper route disjoint caller slices through per-variant special cases behind a string or options discriminant, so each slice would be clearer as its own operation?",
          inspect: "Compare the discriminant parameter declaration with each variant arm's branch test and behavior, the opcode overlap between arms, whether each arm returns a data literal, and the repository callers grouped by the literal discriminant value each site passes in the supplied evidence.",
          focus: "Judge whether one helper hosts separate operations selected by a variant discriminant, rather than one parameterized concept or a data mapping.",
          decision_boundary: [
            "A string or options-bag discriminant with literal values at callsites selecting arms that share little behavior, where each caller group exercises one arm, is strong evidence each slice should be its own operation.",
            "A boolean discriminant belongs to mode-flag-parameter, not this rule; this rule never fires on boolean-annotated or boolean-defaulted parameters.",
            "Arms that each return a data literal for the discriminant value belong to table-shaped-conditional; arms whose behavior the variant types should own belong to type-code-dispatch.",
            "Callers that mix variants at one site, arms sharing substantial helpers, or a discriminant tuning one concept rather than selecting operations answer the question negatively.",
            "If the evidence does not show a non-boolean discriminant selecting between at least two variant arms, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "The helper partitions callers by discriminant value into per-variant special cases with little shared behavior",
            remedy: "Divide the helper so each caller slice invokes its own named operation",
          },
          false: {
            what: "The discriminant tunes one concept, the arms share behavior or map to data, callers mix variants, or no variant partition is established",
          },
        },
      },
      message: "This helper partitions callers by variant instead of exposing separate operations.",
    },
    "jev/no-coincidental-similarity": {
      scope: "function",
      question: {
        instructions: {
          question: "Do these structurally similar spans encode different domain concepts, so consolidating them would create a false abstraction?",
          inspect: "Compare the similarity trigger with each lookalike's divergence signals: member and literal names only one side uses, shared versus distinct domain tokens in the names, whether the files share a module role, and whether caller populations and imports overlap in the supplied evidence.",
          focus: "Judge whether the resemblance is coincidence between distinct concepts that must stay separate, rather than one behavior with two spellings.",
          decision_boundary: [
            "High structural overlap together with disjoint domain vocabulary, different module roles, and disjoint callers is strong evidence that merging would forge a false abstraction.",
            "Shared literals, shared domain member names, common callers, or shared imports indicate one genuine concept and answer the question negatively; the merge-side rules then own the finding.",
            "Generic scaffolding alone, such as matching try/catch shape with no shared domain tokens, is not a merge risk worth scoring.",
            "This rule reads the same similarity trigger as duplicated-logic in the opposite direction: high here means do not consolidate, which inverts the usual consolidation remedy.",
            "If the evidence does not establish both a concrete similarity trigger and divergence in what the spans mean, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "Structurally similar spans encode distinct domain concepts with disjoint vocabulary, roles, or audiences, so merging them would invent a false shared abstraction",
            remedy: "Keep the spans separate and let each evolve under its own domain owner",
          },
          false: {
            what: "The spans share a genuine concept shown by common literals, members, callers, or imports, or no concrete lookalike is established",
          },
        },
      },
      message: "These lookalikes encode different concepts; consolidating them would forge a false abstraction.",
    },
    "jev/no-entangled-mechanical-change": {
      scope: "change",
      question: {
        instructions: {
          question: "Does this change mix mechanical-only edits with behavior-changing edits, so the behavioral delta is obscured by mechanical noise?",
          inspect: "Compare the per-hunk classifications within each touched file, the ratio of mechanical to behavioral lines, whether the two kinds interleave in the same files, and the coverage metadata identifying omitted or unclassifiable modules in the supplied evidence.",
          focus: "Judge whether reformat or rename noise hides the behavioral delta a reviewer must find, not whether the change is large.",
          decision_boundary: [
            "Large whitespace-only or rename-only hunks surrounding small behavioral hunks in the same files, especially interleaved, are strong evidence the behavioral delta is obscured.",
            "Mechanical and behavioral edits landing in separate files answer the question negatively; the reviewer can read each file on its own terms.",
            "An all-mechanical or all-behavioral change never reaches this judgment; so does a rename that provably preserves binding resolution with no behavioral hunk beside it.",
            "Unrelated reasons colliding in one module belong to divergent-change, and moved complexity belongs to complexity-displacement; this rule scores mechanical noise hiding behavior.",
            "If the coverage metadata shows omitted modules or the evidence shows only one kind of hunk, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "Mechanical-only hunks obscure the behavioral delta inside the same files, forcing reviewers to excavate the real change from noise",
            remedy: "Split the change so mechanical reformatting or renames land separately from the behavioral delta",
          },
          false: {
            what: "The mechanical and behavioral edits are separated by file, the change is all one kind, or the behavioral delta stands clear of the noise",
          },
        },
      },
      message: "This change buries its behavioral delta under mechanical-only edits.",
    },

    "jev/no-predicate-name-deception": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this predicate-shaped name return a non-boolean value, so callers branching on it test the wrong thing?",
          inspect: "Compare the function name prefix with each return path's value shape, the declared return type, and how repository callers consume the result in the supplied evidence.",
          focus: "Judge whether a caller reading only the name would branch on a truthiness the implementation does not deliver as a boolean.",
          decision_boundary: [
            "A predicate prefix such as is, has, can, should, or needs promising a boolean while a return path yields a string, object, number, or absent value is strong evidence of deception.",
            "Type predicates written as x is T annotations are boolean by construction and answer the question negatively.",
            "Documented tri-states and conventional truthy idioms whose callers branch correctly answer the question negatively.",
            "A non-predicate name, or a predicate whose every return path is boolean-shaped, is outside this proposition.",
          ],
        },
        criteria: {
          true: {
            what: "The predicate-shaped name promises a boolean answer while at least one return path yields a non-boolean-shaped value",
            remedy: "Return a boolean on every path or rename the function to state what it actually returns",
          },
          false: {
            what: "The name carries no predicate prefix, every return path is boolean-shaped, or the shape is a boolean by construction",
          },
        },
      },
      message: "This predicate-shaped name returns a non-boolean value.",
    },
    "jev/no-confusion-confessing-comment": {
      scope: "comment",
      question: {
        instructions: {
          question: "Does this comment transfer the author's confusion to the reader instead of recording what was tried or verified?",
          inspect: "Compare the confession wording with the adjoining code's behavior, any test pinning the behavior, and any tracked-work pointer in the supplied evidence.",
          focus: "Judge whether every future reader must re-pay the investigation the author declined to record.",
          decision_boundary: [
            "A confession of ignorance above branching or retry logic with no pinning test and no tracked-work pointer is strong evidence of transferred confusion.",
            "An honest scope note naming the heuristic, the dataset it was tuned on, and the test pinning current behavior answers the question negatively.",
            "A confession beside a tracked issue with pinned behavior answers the question negatively.",
            "A comment that names a concrete verification is outside this proposition.",
          ],
        },
        criteria: {
          true: {
            what: "The comment confesses uncertainty or fragility without pointing at a test, issue, or measured verification of the adjoining behavior",
            remedy: "Investigate the behavior, pin it with a test, and record what was verified or file tracked work",
          },
          false: {
            what: "The comment records what was tried or verified, or points at tracked work pinning the behavior",
          },
        },
      },
      message: "This comment confesses confusion without recording what was verified.",
    },
    "jev/no-unexplained-suppression": {
      scope: "comment",
      question: {
        instructions: {
          question: "Does this suppression disable a check without recording why, so future readers cannot tell whether the exception is still earned?",
          inspect: "Compare the suppression directive and its scope with the rationale words beside it, the family of the suppressed check, and the risky shapes in the adjoined code from the supplied evidence.",
          focus: "Judge whether a future reader can tell from the comment why the check may stay off.",
          decision_boundary: [
            "A file-scoped or type-safety suppression with no rationale words beside a risky cast or dynamic boundary crossing is strong evidence of an unearned exception.",
            "A directive with an adjacent reason or issue link answers the question negatively.",
            "A line-scoped formatting-rule suppression, or a suppression whose rationale the adjoined code makes self-evident, answers the question negatively.",
            "A suppression carrying a rationale clause is outside this proposition.",
          ],
        },
        criteria: {
          true: {
            what: "The suppression disables a check with no recorded reason while the adjoined code carries shapes the check exists to catch",
            remedy: "Record why the exception is safe beside the directive, or remove the suppression and satisfy the check",
          },
          false: {
            what: "The directive carries its reason, suppresses only a low-risk check in a narrow scope, or is self-evidently earned",
          },
        },
      },
      message: "This suppression disables a check without recording why.",
    },

    "jev/no-ambient-dependency-grab": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this function reach a shared dependency through an ambient accessor instead of receiving it through its parameters, so callers can neither see nor substitute the dependency?",
          inspect: "Compare each extracted accessor or locator call with the function's parameter list, the resolved target where shown, and the repository callers in the supplied evidence.",
          focus: "Judge whether a caller can tell from the signature what the function depends on and supply a substitute, not whether shared dependencies exist at all.",
          decision_boundary: [
            "A static singleton call such as Db.getInstance, a Config.shared read, or a container get or resolve call inside domain behavior is strong evidence of an ambient grab.",
            "Reading request-scoped context through a store accessor deep in domain behavior hides the same caller-invisible input.",
            "A receiver that arrives as a parameter is explicit dependency passing, even when the method called on it resolves something.",
            "Composition roots, boundary adapters, and test seams exist to resolve dependencies and answer the question negatively.",
            "Fixed environment, clock, randomness, or browser reads belong to hidden runtime input, and inline construction belongs to construction in use; if the evidence shows only those, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "The function pulls a shared dependency through a singleton accessor, service locator, or context store while its parameters hide that dependency from callers",
            remedy: "Accept the dependency as a parameter so callers can see it, substitute it, and control its lifetime",
          },
          false: {
            what: "The dependency arrives through parameters, the function is a composition root or adapter, or the evidence does not establish an ambient accessor",
          },
        },
      },
      message: "This function grabs a shared dependency through an ambient accessor.",
    },
    "jev/no-singly-owned-lazy-shared-state": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this function lazily create module-shared state on first use, so the dependency's creation timing, lifetime, and invalidation stay invisible to callers and persist across calls?",
          inspect: "Use the extracted initialized binding, the guard-then-assign sequence, the reader set beyond the writer, any reset or inspect export, and the observed callers in the supplied evidence.",
          focus: "Judge whether callers share one invisible lifetime they cannot reset or observe, not whether caching as such is wrong.",
          decision_boundary: [
            "An initialized module binding assigned behind a first-use guard inside the only writer, read by other functions, with no reset export is strong evidence of hidden lifetime.",
            "A documented, explicitly resettable cache owned by one module with invalidation callers answers the question negatively.",
            "Load-time initialization is configuration, not lazy creation.",
            "Bindings written from two or more functions belong to shared mutable module state; if the evidence shows a second writer, answer no.",
            "Uninitialized declarations assigned by a separate initializer belong to hidden initialization order; if the declaration carries no initializer, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "The function creates shared state on first use behind an initialized declaration while callers inherit a lifetime they cannot see, reset, or invalidate",
            remedy: "Create the state once at load or composition time, or expose explicit creation and invalidation the callers can control",
          },
          false: {
            what: "The state is created at load time, explicitly resettable, written from several functions, or lacks evidence of cross-call shared lifetime",
          },
        },
      },
      message: "This function lazily creates state that callers silently share.",
    },
    "jev/no-unit-ambiguous-quantity": {
      scope: "function",
      question: {
        instructions: {
          question: "Is this quantity's unit stated nowhere in its name, type, or documentation, so a caller must guess the scale?",
          inspect: "Compare each extracted numeric parameter, its quantity stem and bare number type, the absence of unit suffixes, brands, or documented units, and the raw literals callers pass in the supplied evidence.",
          focus: "Judge whether a caller can tell the scale without reading the implementation, not whether numbers appear in the signature.",
          decision_boundary: [
            "A duration or size stem such as timeout, duration, or size typed as a bare number with no unit suffix, brand, or documented unit is strong evidence of an ambiguous quantity.",
            "A unit suffix, branded or nominal type, or documented unit answers the question negatively.",
            "Unit-free counts and indexes such as count, index, or page are not quantities and answer the question negatively.",
            "A body that already converts named scales belongs to unit scale mismatch; if the evidence shows a named conversion or scale factor, answer no.",
            "Raw numeric literals at call sites support the claim but are not required; the signature alone can leave the scale unstated.",
          ],
        },
        criteria: {
          true: {
            what: "A quantity parameter leaves its unit unstated in name, type, and documentation so callers must guess the scale",
            remedy: "Rename with a unit suffix, brand the type, or document the unit in one line",
          },
          false: {
            what: "The unit is stated in the name, type, or documentation, the parameter is a count or index, or the body already converts named scales",
          },
        },
      },
      message: "This quantity leaves its unit unstated for callers.",
    },
    "jev/no-partially-narrowed-nullable": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this value's type admit two absences while the code narrows only one before use, leaving the other to reach the use unhandled?",
          inspect: "Compare the extracted union annotation admitting both null and undefined with each narrowing test, which absence member it names, the missing member, and the subsequent uses in the supplied evidence.",
          focus: "Judge whether one promised absence case still reaches a use, not whether any null or undefined check exists.",
          decision_boundary: [
            "A T, null, undefined union or an optional T, null parameter checked only against null and then dereferenced is strong evidence of partial narrowing.",
            "Narrowing both absences, whether by two checks, a loose equality against null, or a truthiness guard with an early exit, answers the question negatively.",
            "A type predicate or assertion function covering the union answers the question negatively.",
            "A nullish coalescing fallback handles both absences and answers the question negatively.",
            "A single-absence type, or a narrowing test with no subsequent use of the value, is insufficient; if either holds, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "The type promises two absences but the code narrows only one while the other still reaches a use",
            remedy: "Narrow both absences explicitly, adopt a type predicate, or fall back with nullish coalescing before use",
          },
          false: {
            what: "Both absences are narrowed, a predicate or coalescing covers the union, the type admits one absence, or no use follows the narrowing",
          },
        },
      },
      message: "This value narrows one absence while the other still reaches its use.",
    },
    "jev/no-heterogeneous-primitive-callers": {
      scope: "function",
      question: {
        instructions: {
          question: "Do callers pass differently-stemmed values into this one bare-primitive parameter, so the type accepts what the domain distinguishes?",
          inspect: "Compare the single bare-primitive parameter with the argument expressions at each repository call site, the distinct domain stems feeding that one slot, and the consumer sources in the supplied evidence.",
          focus: "Judge whether the callers prove the slot carries distinct domain identities the type erases, not whether primitives appear.",
          decision_boundary: [
            "One exported id parameter of type string fed by user-rooted values at some call sites and org-rooted values at others is strong evidence of heterogeneous callers.",
            "Fewer than two callers, or caller argument stems that agree, answer the question negatively.",
            "A branded, union, or object parameter type already says what the slot carries and answers the question negatively.",
            "Two or more same-primitive parameters in one signature belong to interchangeable domain primitives; if the signature carries such a group, answer no.",
            "Stemming is heuristic; a single shared stem across all callers is never enough, no matter how suggestive the parameter name.",
          ],
        },
        criteria: {
          true: {
            what: "Distinct domain identities flow into one bare-primitive slot from different callers while the type erases the distinction",
            remedy: "Brand the parameter type per domain role or split the signature so each role has its own slot",
          },
          false: {
            what: "Caller stems agree, callers are too few to compare, the parameter type already distinguishes the domain, or the signature carries a same-primitive group",
          },
        },
      },
      message: "Distinct domain values flow into this one bare-primitive slot.",
    },

    "jev/no-cross-area-export-break": {
      scope: "module",
      question: {
        instructions: {
          question: "Does this module's export change break consumers spread across distinct repo areas, so the ripple exceeds what the author can verify from the changed file alone?",
          inspect: "Compare each removed export with the per-area importer groups, how many distinct top-dir areas hold importers, whether those importers are runtime or test files, which importers the same diff already updates, and whether the barrel re-exports the broken symbol.",
          focus: "Judge the consumer geography of the break, not whether the export shape changed.",
          decision_boundary: [
            "A removed export with runtime importers in several distinct top-dir areas and no same-diff call-site updates is strong evidence of a cross-area break.",
            "A break whose consumers all live in the owning directory or in tests answers the question negatively.",
            "A diff that updates every affected importer alongside the break weakens the claim.",
            "A barrel re-export of the broken symbol widens the reach beyond the direct importer list.",
            "If no export is removed, or nothing imports the module, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "An export removal whose runtime consumers span distinct repo areas the same diff leaves unupdated",
            remedy: "Keep a compatibility re-export, update every affected importer in the same diff, or split the break into per-area migrations",
          },
          false: {
            what: "The break touches only same-directory or test consumers, every importer moves in the same diff, or no export is removed",
          },
        },
      },
      message: "This module's export change breaks consumers spread across distinct repo areas.",
    },
    "jev/no-efferent-coupling-burst": {
      scope: "module",
      question: {
        instructions: {
          question: "Does this diff scatter the module's outbound dependencies across architectural areas it previously did not touch?",
          inspect: "Compare each added import edge with its resolved target area, whether the edge crosses the owning top-dir, the target's layer role, whether the import is type-only, and the before/after distinct-area counts against the repo's feature-grouping norm.",
          focus: "Judge the breadth the diff adds to what the module depends on, not whether any single dependency is justified.",
          decision_boundary: [
            "Added first-time edges into several new feature areas in a by-feature repo are strong evidence of a coupling burst.",
            "New edges that stay inside the owning area or land in shared utilities answer the question negatively.",
            "Type-only edges and composition roots whose job is wiring carry less weight than runtime edges from a domain module.",
            "If the diff adds no new outbound edge, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "A diff that opens first-time runtime dependencies from the module into several new architectural areas",
            remedy: "Depend on the owning area's entry point or a shared abstraction instead of reaching directly into each new area",
          },
          false: {
            what: "The new edges stay in-area or in shared utilities, are type-only, belong to a wiring root, or no edge is added",
          },
        },
      },
      message: "This diff scatters the module's outbound dependencies across areas it previously did not touch.",
    },
    "jev/no-stable-to-volatile-edge": {
      scope: "module",
      question: {
        instructions: {
          question: "Does this widely-imported module add a new dependency on a volatile detail, so churn below now threatens the calm surface above?",
          inspect: "Compare the owner's importer count and area spread with each new edge's target volatility markers: the target's own importer count, test or fixture or internal path markers, @internal documentation, newly-added status, and whether the edge is type-only or runtime.",
          focus: "Judge the direction of the new edge from a stable surface toward volatility, not the size of the diff.",
          decision_boundary: [
            "A heavily imported module newly importing a zero-importer internal helper on an executed path is strong evidence of a stable-to-volatile edge.",
            "A type-only import, or a target that is version-pinned and calm despite few importers, weakens the claim.",
            "An owner that is itself internal with a single caller is not a stable surface, so the direction carries little weight.",
            "If the diff adds no new resolved edge, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "A widely-consumed module newly depending at runtime on a volatile detail with no importers of its own",
            remedy: "Move the shared behavior up beside the stable surface, or depend on a pinned contract the volatile detail already honors",
          },
          false: {
            what: "The new edge is type-only, the target is calm and versioned, the owner is itself internal, or no new edge exists",
          },
        },
      },
      message: "This widely-imported module adds a new dependency on a volatile detail.",
    },
    "jev/no-new-foreign-state-write-edge": {
      scope: "module",
      question: {
        instructions: {
          question: "Does this change open the first cross-module write channel into another module's state?",
          inspect: "Compare each new import edge with the writes the candidate performs through the imported binding, whether the written binding is mutable state the target owns, and whether the target offers a setter or entry point the change bypassed.",
          focus: "Judge the precedent the diff sets — the first write channel between the two modules — not whether writes are ever acceptable.",
          decision_boundary: [
            "A first-ever edge between the modules with a direct assignment to the target's binding and no offered setter is strong evidence of a new foreign write channel.",
            "A target whose whole purpose is a store, where writing is its contract, answers the question negatively.",
            "A long-standing edge that merely adds another write beside existing ones belongs to foreign-mutation, not to this question.",
            "If the new edge carries no write, or the write travels through the target's own setter, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "A diff that first connects two modules and writes the target's state outside any setter the target offers",
            remedy: "Write through a setter or entry point the target offers, or keep the state beside the module that mutates it",
          },
          false: {
            what: "The edge is long-standing, the target is a store by contract, the write uses the target's setter, or no write crosses the new edge",
          },
        },
      },
      message: "This change opens the first cross-module write channel into another module's state.",
    },

    "jev/no-shared-kernel-new-consumer": {
      scope: "module",
      question: {
        instructions: {
          question: "Does this change make a previously-unconnected context a consumer of the shared kernel, widening the blast radius of every future kernel change?",
          inspect: "Read the new edge into the shared kernel, the kernel markers on the target, how widely the kernel is already consumed across areas, and whether the candidate's own area already depends on it.",
          focus: "Judge whether this consumer deepens the kernel's entrenchment across contexts, not whether shared code is ever reused.",
          decision_boundary: [
            "A new edge from a fresh area into a kernel already consumed across several areas, used for a single symbol, is strong evidence of deepening entrenchment.",
            "A target with no shared-kernel markers, or a candidate area that already consumes the kernel, leaves no new spread to judge.",
            "Genuinely generic utilities with no domain concepts carry less weight than domain-named kernel surface.",
            "Narrow single-symbol use deepens entrenchment more quietly than broad reuse, which at least pays for its coupling.",
            "If the edge is not new or the target is not kernel-shaped, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "A new consumer from an unconnected context deepens the shared kernel's cross-area entrenchment",
            remedy: "Depend on a narrower owned interface, or duplicate the small piece so the kernel's consumer set does not grow",
          },
          false: {
            what: "The target is generic or not kernel-shaped, the area already consumes the kernel, or the edge is not new",
          },
        },
      },
      message: "This change makes a new context a consumer of the shared kernel.",
    },
    "jev/no-direction-reversing-edge": {
      scope: "module",
      question: {
        instructions: {
          question: "Does this new dependency run against the established direction between the two areas, making the reliance mutual without closing a cycle?",
          inspect: "Compare the new edge's target area with the history of imports flowing the other way, how deep that history runs, and whether the areas already depend on each other freely.",
          focus: "Judge whether the edge reverses a settled direction the repo's own import history establishes, not whether any cross-area edge is suspect.",
          decision_boundary: [
            "A lone new edge back against a long one-way history across many files is strong evidence of a reversed direction.",
            "A single stray incoming import is not an established direction, and areas that already import each other freely have no direction to reverse.",
            "An edge that closes a dependency cycle belongs to cycle analysis, not to this question.",
            "A new edge accompanying a documented responsibility move carries less weight than an unexplained reversal.",
            "If no established one-way history exists or the edge closes a cycle, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "A new edge reverses the settled import direction between two areas without closing a cycle",
            remedy: "Move the shared responsibility so the dependency follows the established direction, or make the reversal explicit and mutual by design",
          },
          false: {
            what: "No one-way history exists, the areas already depend on each other, or the edge closes a cycle",
          },
        },
      },
      message: "This dependency runs against the established direction between the two areas.",
    },
    "jev/no-cross-context-test-reach": {
      scope: "module",
      question: {
        instructions: {
          question: "Does this runtime module newly depend on another context's test or fixture sources, promoting a private test seam to a cross-context contract?",
          inspect: "Read the new edge's test markers on the target, whether the import crosses areas, whether the use is type-only or runtime, and whether other areas already reach the same fixture.",
          focus: "Judge whether runtime code turns another area's private test seam into a dependency, not whether test utilities are ever shared.",
          decision_boundary: [
            "A new runtime import of another area's fixture factory used on an executed path is strong evidence of a promoted test seam.",
            "Type-only imports, same-area test utilities, and published testkits with their own consumers carry less weight.",
            "A fixture already consumed across areas describes an established pattern, not a lone new reach.",
            "Test sources are not a public surface; cross-area value reuse makes them one silently.",
            "If the edge is not new, the target is not a test source, or no area is crossed, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "Runtime code newly depends on another context's test or fixture sources across areas",
            remedy: "Promote the shared piece to a real runtime module both contexts may depend on, or stop reaching across contexts",
          },
          false: {
            what: "The import is type-only, stays within one area, targets a published testkit, or follows an established cross-area pattern",
          },
        },
      },
      message: "This runtime module newly depends on another context's test sources.",
    },
    "jev/no-twin-gateway-emergence": {
      scope: "module",
      question: {
        instructions: {
          question: "Does this change wrap an external package that another context already gateways, creating a second anticorruption layer for the same outside world?",
          inspect: "Read the new external edge, the existing gateway in another area, how established that gateway is, and whether reusing it was one edge away.",
          focus: "Judge whether the change duplicates gateway responsibility for one external dependency across contexts, not whether external packages are ever wrapped.",
          decision_boundary: [
            "A new direct wrap of a dependency an established gateway with several consumers already fronts, when reuse was one edge away, is strong evidence of a twin gateway.",
            "A first wrap with no existing gateway, or an existing one-off with no consumers, leaves nothing to twin.",
            "Two wraps serving disjoint capability slices evidenced by disjoint used symbols are separate gateways, not twins.",
            "An incidental import is not a gateway; look for a domain-named surface with real consumers.",
            "If no other-area gateway exists or the edge is not new, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "A new wrap duplicates an established gateway for the same external dependency in another context",
            remedy: "Reuse the existing gateway instead of wrapping the dependency again",
          },
          false: {
            what: "No other-area gateway exists, the existing use is incidental, or the wraps serve disjoint capabilities",
          },
        },
      },
      message: "This change wraps an external package another context already gateways.",
    },
    "jev/no-unwrapped-service-edge": {
      scope: "module",
      question: {
        instructions: {
          question: "Does this change call an external service host never before seen in the repo without going through the established client wrapper, adding an unmediated outbound edge?",
          inspect: "Read the novel host in the added lines, the outbound-call evidence at the site, the repo's established wrappers and whether the change uses one, and any retry or observability markers nearby.",
          focus: "Judge whether the new outbound edge bypasses mediation the repo already owns, not whether HTTP calls are ever risky.",
          decision_boundary: [
            "A brand-new external host called ad hoc with no timeout, retry, or tracing, while an established wrapper with wide use sits unused, is strong evidence of an unmediated edge.",
            "A host already used elsewhere, a call routed through the wrapper, or a repo with no wrapper to conform to carries less weight.",
            "Retry and telemetry markers at the call site weaken the claim even when the wrapper is bypassed.",
            "Local and example hosts are not external service edges.",
            "If the host is not novel or no outbound call exists in the added lines, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "A novel external host is called without the repo's established client wrapper or reliability markers",
            remedy: "Route the call through the established client wrapper, or establish one wrapper for the new host with retry and observability",
          },
          false: {
            what: "The host is already used, the call uses the wrapper, no wrapper exists to conform to, or no outbound call was added",
          },
        },
      },
      message: "This change calls a new external service host outside the established client wrapper.",
    },

    "jev/no-unpinned-compat-quirk": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this function contain behavior that looks redundant or wrong on its face — a special case, redundant path, or unusual return — that existing in-repo callers actually depend on, with no comment or test pinning the dependency, so a well-meaning cleanup would silently break them?",
          inspect: "Use the quirk spans with their source, the observed callers with their argument lists, which callers exercise each quirk, the pinning signals, and any transitive pinning chains in the supplied evidence. A named transitive chain (test → seam → candidate) is one hop of test coverage reaching the function; weigh it against direct test references.",
          focus: "Judge whether removal of the odd-looking span would silently break current callers. Undocumented-or-apparently-wrong does not make change harmless.",
          decision_boundary: [
            "A special case or unusual return that callers demonstrably exercise, with no comment or test naming the compatibility obligation, is strong evidence of an unpinned quirk.",
            "A test that exercises a public seam which calls the function pins the quirk one hop away; weigh the named chain against direct test references.",
            "A span no caller exercises is dead weight, not a compat quirk.",
            "A comment above the function or a test referencing the quirky behavior pins the obligation and answers the question negatively.",
            "A span that states the module's documented convention is not a quirk merely because it looks unusual in isolation.",
            "If the function has no observable in-repo callers, dependence cannot be established; answer no.",
          ],
        },
        criteria: {
          true: {
            what: "An odd-looking span that current callers depend on survives on convention alone, with nothing pinning the obligation for the next cleanup",
            remedy: "Name the compatibility obligation in a comment and pin the quirky value in a regression test",
          },
          false: {
            what: "The span is dead, already pinned by a comment or test, the module's stated convention, or caller dependence cannot be established",
          },
        },
      },
      message: "This function keeps an odd-looking span alive only because current callers depend on it.",
    },

    "jev/no-hidden-collaborator-read": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this function let an imported binding's state or receiver state change its result, decision, or effect while that input is absent from its parameters?",
          inspect: "Compare the function parameters with each extracted collaborator read, its ownership, the imported targets, the stable constants set aside before judgment, any writers observed in other modules, and the repository callers in the supplied evidence.",
          focus: "Judge whether a caller can see or supply the deciding input from the signature, not whether the collaborator is documented or the read looks convenient.",
          decision_boundary: [
            "A domain result or policy branch decided by imported mutable state, such as a flags set or config object another module can change, is strong evidence of a hidden collaborator read.",
            "Calling an imported function as a visible step, such as format(order.total), is collaboration through the contract rather than a hidden input.",
            "Reads of literal-valued constants with no writer anywhere in the repository are set aside before judgment; they do not establish a hidden input.",
            "A read that never reaches the result, decision, or effect answers the question negatively even when the import is mutable.",
            "If the evidence cannot establish that collaborator state decides behavior, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "Imported or receiver state the parameters do not show decides the function's result, policy choice, or effect",
            remedy: "Accept the deciding state as a parameter so callers can see, supply, and substitute it",
          },
          false: {
            what: "The collaborator is used as a visible call step, the read is a stable constant, or no hidden state decides behavior",
          },
        },
      },
      message: "This function reads collaborator state its parameters do not disclose.",
    },
    "jev/no-mixed-calculation-and-interaction": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this function interleave deterministic calculation with environmental interaction so the calculation cannot be exercised or reasoned about without the environment?",
          inspect: "Compare each extracted interaction with each extracted calculation, the interaction-result names, whether the calculation consumes them or the interaction consumes calculated values, and the repository callers in the supplied evidence.",
          focus: "Judge whether the calculation could be lifted behind a parameter while the interaction stays at the boundary, not whether the function has one business purpose.",
          decision_boundary: [
            "A formula, branch, or loop over values sitting beside a file, network, clock, or randomness read that callers cannot substitute is strong evidence of mixing.",
            "A thin adapter that performs the interaction with no calculation half answers the question negatively; there is nothing to separate.",
            "A pure calculation that consumes an already-supplied value answers negatively even when the value originated from I/O elsewhere.",
            "One narrow pipeline where the interaction result flows straight through a single transform with no separable pure half weakens the claim.",
            "If the evidence cannot establish both an interaction and a separable calculation, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "Deterministic calculation is embedded with environmental interaction so tests and readers must bring the environment to reach the logic",
            remedy: "Move the interaction to the boundary, pass its result in as a parameter, and keep the calculation pure",
          },
          false: {
            what: "The function is a thin interaction adapter, a pure calculation, or a single narrow pipeline with no separable pure half",
          },
        },
      },
      message: "This function mixes calculation with environmental interaction.",

    },
    "jev/no-fragmented-stateful-procedure": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this function scatter one stateful procedure across single-use helpers so the order of its state transitions is only visible by following calls?",
          inspect: "Use the ordered helper calls in the entry body, each helper's writes and reads of shared bindings, the write-then-read edges between helpers, caller counts with export and re-export signals per helper, the entry's own interleaved state operations, and helper sizes in the supplied evidence.",
          focus: "Judge whether the reader must chase calls to see the state-transition order, not whether the helpers are small or the code works.",
          decision_boundary: [
            "Three or more calls to single-caller same-module helpers in a load-bearing order, each mutating shared state, with at least one write-then-read dependency between helpers, is strong evidence of a fragmented stateful procedure.",
            "Helpers with several callers, pure helpers with no outer writes, or an entry that interleaves its own state logic between calls weaken the claim toward readable structure.",
            "A helper that is exported or re-exported through a public entry point is a documented seam rather than fragmentation.",
            "Fewer than three helpers, or helpers too substantial to read inline without loss, answer the question negatively.",
            "If the evidence does not establish shared-state mutation across the helpers, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "The entry scatters one stateful procedure across single-use helpers whose shared-state transitions are ordered only by the call sequence",
            remedy: "Inline the helper bodies at the call sites so the full state-transition sequence reads in one place",
          },
          false: {
            what: "The helpers are independently reused, pure, separated by real seams, or lack shared-state dependencies that force an invisible order",
          },
        },
      },
      message: "This function scatters one stateful procedure across single-use helpers.",
    },

    "jev/no-stable-surface-widening": {
      scope: "module",
      question: {
        instructions: {
          question: "Does this change widen the export surface of an already widely-consumed module, growing the contract every future change must preserve?",
          inspect: "Read the added export names, the import fan-in with its distinct-area spread, whether the additions are domain concepts or utilities, and whether a barrel re-exports the new symbols.",
          focus: "Judge whether additive growth of a used surface is a release-sized event, not whether new exports are ever useful.",
          decision_boundary: [
            "Several new domain-concept exports on a module imported from several areas, blessed through the barrel, is strong evidence of surface widening.",
            "New utility-shaped exports, or growth on a module with narrow same-area fan-in, answers the question negatively.",
            "Removals or renames belong to the export-breakage judgment; this question fires on purely additive growth only.",
            "Test-only exports carry less weight than runtime surface growth.",
            "If the diff adds no exports or the module has no consuming surface to grow, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "The change adds exports to a widely-consumed module, growing a contract future changes must preserve",
            remedy: "Place the new surface behind its own module or release it as an explicit surface expansion",
          },
          false: {
            what: "The additions are utilities, the fan-in is narrow or same-area, or the diff adds no exports",
          },
        },
      },
      message: "This change widens the export surface of an already widely-consumed module.",
    },
    "jev/no-team-boundary-crossing": {
      scope: "module",
      question: {
        instructions: {
          question: "Does this new dependency reach into an area owned by a different team, creating coordination cost no in-team review can clear alone?",
          inspect: "Compare the owner and target owner codes from the ownership file, whether the edge is new, whether it uses the target's documented entry, and whether precedent between the same owners exists.",
          focus: "Judge whether the diff creates first-time cross-team coupling, not whether cross-area imports are ever convenient.",
          decision_boundary: [
            "A first-ever edge between two owner codes that bypasses the target's barrel entry is strong evidence of a team-boundary crossing.",
            "An edge through the target's documented entry, with established precedent between the same owners, answers the question negatively.",
            "Ownership read from directory shape alone is not evidence; without a visible ownership file there is no judgment to make.",
            "Edges within one owner code, or into unowned paths, are not crossings.",
            "If no ownership file is visible or the edge stays inside one team's area, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "A new dependency reaches from one team's area into another team's area without precedent or entry discipline",
            remedy: "Enter through the owning team's documented entry point or agree the coupling with the owning team first",
          },
          false: {
            what: "The edge uses the documented entry, precedent between the owners exists, or both sides share one owner",
          },
        },
      },
      message: "This new dependency reaches into an area owned by a different team.",
    },
    "jev/no-cross-service-source-reach": {
      scope: "module",
      question: {
        instructions: {
          question: "Does this change wire two separately-deployable units together at source level, so neither can be built, versioned, or deployed in isolation anymore?",
          inspect: "Read the owner and target deployment units from their nearest manifests, the specifier shape, whether the edge is new, and whether it uses the target unit's entry.",
          focus: "Judge whether source-level coupling defeats independent deployability, not whether the two units ever communicate.",
          decision_boundary: [
            "A new relative climb across a manifest boundary where a package-name import or entry point exists is strong evidence of cross-service source reach.",
            "An edge through the workspace package name, which at least versions the coupling, answers the question more weakly than a raw relative reach.",
            "A single-manifest repository is a monolith by choice; there is no deployment boundary to cross.",
            "Manifest boundaries read from directory shape alone are not evidence; without two visible manifests there is no judgment to make.",
            "If fewer than two manifests are visible or the edge stays inside one unit, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "A new source-level edge crosses a deployment-unit boundary without versioning or entry discipline",
            remedy: "Depend on the other unit through its workspace package name or a service boundary instead of a relative source reach",
          },
          false: {
            what: "The edge uses the versioned package name, stays inside one unit, or the repo ships as one unit",
          },
        },
      },
      message: "This change wires two separately-deployable units together at source level.",
    },
    "jev/no-same-stem-divergent-role": {
      scope: "module",
      question: {
        instructions: {
          question: "Does this module's file stem collide with a same-named module elsewhere whose exports serve a different role, so the shared name promises a sameness the code does not keep?",
          inspect: "Compare the candidate's export set with each same-stem twin's exports, the export overlap, the sibling-suffix context of each twin, and whether one client area imports both.",
          focus: "Judge whether the identical stem misleads importers about sameness, not whether shared names are ever coincidental.",
          decision_boundary: [
            "An identical stem with disjoint exports, where both twins are imported into one client area, is strong evidence of a divergent role.",
            "Stems that collide but share exports describe genuine duplication, which belongs to the duplication judgments rather than this one.",
            "Twins whose sibling-suffix profiles show each follows its own directory's conventions look native in both places, deepening the confusion.",
            "Collisions confined to tests, or twins qualified callers never confuse in practice, answer the question negatively.",
            "If no same-stem twin in another area exists or the exports overlap, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "A same-named module elsewhere serves a different role while the shared name promises sameness",
            remedy: "Rename one of the twins to state its distinct role or converge them onto one shared contract",
          },
          false: {
            what: "The twins share exports, the collision is test-confined, or no cross-area twin exists",
          },
        },
      },
      message: "This module shares its file stem with a same-named module serving a different role.",
    },

    "jev/no-non-exhaustive-domain-handling": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this function branch over a declared finite domain while leaving member cases unhandled with no explicit fallback policy?",
          inspect: "Compare the switch or if-chain discriminant with the declared domain members, which members the arms handle, which members are missing, the absence of a default or terminal else, the absence of an exhaustiveness anchor, the fallthrough shape, and repository callers in the supplied evidence.",
          focus: "Judge whether a valid domain value falls through silently, not whether branching exists at all.",
          decision_boundary: [
            "A switch over a declared literal union or enum where handled cases intersect the members, one or more members are missing, and no default, terminal else, or exhaustiveness anchor exists is strong evidence a valid value falls through silently.",
            "A default clause, terminal else, or assertNever-style anchor answers the question negatively even when members look unhandled, since the fallback is explicit.",
            "An open string or number discriminant with no declared finite domain in the repository answers the question negatively; the evidence abstains before judgment in that case.",
            "Silent fallthrough that falls off the end or returns undefined to cross-module callers strengthens the claim toward a load-bearing gap.",
            "If every declared member is handled or the discriminant cannot be tied to the declared domain, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "The function branches over a declared finite domain with member cases silently unhandled and no exhaustiveness anchor",
            remedy: "Handle the missing members explicitly or add a default that states the unknown-value policy",
          },
          false: {
            what: "Every declared member is handled, an explicit default, else, or exhaustiveness anchor covers the rest, or no declared finite domain is established",
          },
        },
      },
      message: "This function leaves declared domain members unhandled with no explicit fallback.",
    },
    "jev/no-misplaced-coordination": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this entity method perform application coordination that belongs in a coordinating service or use-case owner rather than on the data it operates on?",
          inspect: "Compare the enclosing type and its own-field reads with each imported collaborator call, the collaborator module ownership and role signals, and the repository callers in the supplied evidence.",
          focus: "Judge placement of the workflow, not call or collaborator counts; a method can misplace a single foreign step.",
          decision_boundary: [
            "Sequencing persistence, network, notification, or other service-owned effects while reading little or none of its own state is strong evidence the workflow belongs with a coordinating owner.",
            "Delegating one persistence write behind the type's own repository seam answers the question negatively.",
            "Coordination inside a *Service*, *UseCase*, orchestrator, or other coordinator-home module is the right home and answers negatively.",
            "A framework-required lifecycle hook answers negatively even when it touches collaborators.",
            "If the enclosing type or collaborator ownership cannot be established from the evidence, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "The method sequences cross-role effects owned by service or infrastructure collaborators instead of operating on its own state",
            remedy: "Move the sequencing to a coordinating service or use-case owner and keep the type focused on its own state and invariants",
          },
          false: {
            what: "The method operates on its own state, delegates behind its own repository seam, coordinates from a coordinator home, or implements a required lifecycle hook",
          },
        },
      },
      message: "This entity method performs application coordination that belongs in a coordinating owner.",
    },
    "jev/no-coupled-index-collections": {
      scope: "function",
      question: {
        instructions: {
          question: "Do two collections in this function advance in lockstep under one shared index, so that pairing by position is the real structure?",
          inspect: "Compare the two array bindings, each paired access site, the loop source showing the lockstep, and whether a pairing record already exists in the supplied evidence.",
          focus: "Judge whether the position is the pairing and one record collection preserves order and identity, not whether indexed access appears at all.",
          decision_boundary: [
            "Siblings declared together at equal length with the shared index as their only link, where the loop body treats each position as one logical item, are strong evidence of position pairing.",
            "Differing stride or offset arithmetic between the collections answers the question negatively.",
            "Independent lengths, standalone uses of either collection, or domain-required separate buffers such as typed arrays or FFI interop answer the question negatively.",
            "A pairing record that already exists and is used where the lockstep runs answers the question negatively.",
            "If fewer than two collections share one index identifier in one loop, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "The position is the pairing and one collection of records preserves the order the index was maintaining and the identity the position was implying",
            remedy: "Store one array of records instead of position-paired collections",
          },
          false: {
            what: "The collections are independently shaped, constrained to separate buffers, already paired where it matters, or never share one index in lockstep",
          },
        },
      },
      message: "Two collections advance in lockstep under one shared index instead of one record collection.",
    },
    "jev/no-tautological-test": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this test assert an expected value recomputed the same way the code under test computes it, so the assertion passes by construction and cannot catch an implementation error?",
          inspect: "Use each assertion's exercised expression and expected-value expression with the classified shape and shared identifiers, plus the count of companion assertions grounded in literal worked examples, in the supplied evidence.",
          focus: "Judge whether the expected value holds an independent oracle, not whether the test calls the subject or states an expectation at all.",
          decision_boundary: [
            "An expected expression that recomputes the exercised computation from the same identifiers, such as asserting add(a, b) against a + b, is strong evidence of a tautology: any implementation returning that recomputation stays green.",
            "An expected value compared against itself, or a bare snapshot with no companion literal assertion, passes by construction and answers the question affirmatively.",
            "An expected literal worked example independent of the subject computation, such as asserting add(1, 2) against 3, is evidence against the claim, and each such companion oracle weakens a bare snapshot.",
            "Interaction assertions on calls, arguments, or order, throw assertions pinning control flow, and assertions with no outcome comparison to judge are outside this question; answer no when none remain.",
            "If the evidence states no outcome assertion, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "The expected value is recomputed from the same computation, compared against itself, or snapshotted with no independent oracle, so the test cannot fail on implementation error",
            remedy: "Replace the recomputed expectation with a literal worked example derived from the specification, independent of how the code computes it",
          },
          false: {
            what: "The expected values are grounded in independent oracles, or the test states no outcome assertion to judge",
          },
        },
      },
      message: "This test recomputes its expected value from the same computation it exercises, so the assertion passes by construction.",
    },

    "jev/no-stacked-error-boilerplate": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this changed error construction restate the obvious or duplicate context the cause chain already carries, instead of adding new information?",
          inspect: "Use each extracted error construction, its boilerplate phrases, whether the static text carries anything beyond boilerplate, cause linkage, catch placement, duplication of the caught error in the message, and interpolations naming values beyond the caught error in the supplied evidence.",
          focus: "Judge whether the new message earns its existence with facts the cause chain does not already carry, not whether error wrapping appears at all.",
          decision_boundary: [
            "A message built only from boilerplate phrases such as failed to, could not, or something went wrong, with no named values and no cause linkage, is strong evidence of restating the obvious.",
            "An outer message that reprints the caught error alongside a cause linkage duplicates context the chain already carries and answers the question affirmatively.",
            "A message that interpolates operation values beyond the caught error, such as identifiers, paths, or limits, adds new information and answers the question negatively.",
            "A specific static message with no boilerplate phrase and no duplication of the caught error answers the question negatively.",
            "If the function constructs no error with a message, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "The error message restates the obvious with boilerplate or duplicates the cause chain without adding new facts",
            remedy: "Name the operation values involved or drop the wrapper and let the original error propagate",
          },
          false: {
            what: "The message adds specific facts the cause chain lacks, or the function constructs no error message",
          },
        },
      },
      message: "This error message restates the obvious or duplicates the cause chain instead of adding new information.",
    },

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

    "jev/no-indiscriminable-error": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this change throw or propagate an error callers cannot discriminate, where distinct failures need distinct handling?",
          inspect: "Use each extracted throw and rejection site, its error type, code, status, cause linkage, message genericity, bare-rethrow shape, and the repository catch sites that branch on failure kind in the supplied evidence.",
          focus: "Judge whether callers can programmatically tell this failure apart from other failures, not whether the message reads clearly to a human.",
          decision_boundary: [
            "A bare Error construction with a generic message and no code, status, cause, or distinguishing subclass is strong evidence callers cannot tell this failure apart from others.",
            "An operation-naming message still leaves callers without a programmatic discriminant; human-readable text is not a failure kind.",
            "A custom error subclass, a code or status field, or a cause linkage already gives callers a discriminant and answers the question negatively.",
            "A repository catch site that branches on error kind with instanceof, code, or status checks confirms distinct failures need distinct handling.",
            "A bare rethrow preserves whatever discriminability the original error had; judge the originating site, not the relay.",
            "If the function raises no error, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "The change raises failures callers cannot tell apart — bare errors with no code, status, cause, or distinguishing type — where handling must branch on failure kind",
            remedy: "Raise a distinguishing error subclass or attach a code and cause so each failure kind is programmatically identifiable",
          },
          false: {
            what: "Each raised failure is identifiable by type, code, status, or cause, handling never branches on failure kind, or the function raises nothing",
          },
        },
      },
      message: "This error gives callers no way to tell failures apart.",
    },

    "jev/no-any-widened-interface": {
      scope: "function",
      question: {
        instructions: {
          question: "Does this change expose `any` in this function's caller-visible signature (parameters, return) where a narrower type was available, rather than confining `any` to generic internals?",
          inspect: "Use each widened parameter and return annotation, the internal any notes, the generic-constraint and disable-comment exceptions, the narrower types available in the module, and the repository callers in the supplied evidence.",
          focus: "Judge whether callers lose type information they could have had, not whether `any` appears anywhere in the body.",
          decision_boundary: [
            "An `any` parameter or return annotation on an exported function, with a domain interface or imported type available in the module, is strong evidence the interface was widened past a narrower alternative.",
            "An `any` confined to locals, `as any` casts, or the function body answers the question negatively on its own; casts are escape-rule territory and appear only as notes.",
            "A generic rest-forwarding constraint such as `(...args: any[]) => any`, or an adjacent explicit-any disable or ts-expect-error comment, marks a deliberate documented exception.",
            "A non-exported helper narrows the audience; judge how much of the widening still reaches callers through the module's exports.",
            "If no `any` appears in a caller-visible annotation, answer no.",
          ],
        },
        criteria: {
          true: {
            what: "Callers receive or return `any` where a narrower module type was available, so misuse the compiler could have caught compiles silently",
            remedy: "Narrow the parameter and return annotations to the domain or imported types the module already has, and keep `any` inside generic bodies only",
          },
          false: {
            what: "The signature is fully typed, the `any` stays in generic constraints or body internals, or a documented exception covers the widening",
          },
        },
      },
      message: "This function exposes `any` in its caller-visible signature where a narrower type was available.",

    },
  },
};

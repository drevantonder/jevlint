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
  },
};

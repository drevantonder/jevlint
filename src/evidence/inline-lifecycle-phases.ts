import { parseSync, Visitor } from "oxc-parser";
import type { Expression, Node } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import {
  findDirectFunction,
  findFunctionCallers,
  functionName,
  isFunctionExported,
  moduleImports,
  nestedFunctionRanges,
} from "./repository.js";
import type { FunctionCaller } from "./repository.js";

export type LifecyclePhase = "parse" | "compute" | "effect" | "present";

export type PhaseRegion = {
  phase: LifecyclePhase;
  line: number;
  endLine: number;
  text: string;
};

export type PhaseCollaborator = {
  phase: LifecyclePhase;
  call: string;
  line: number;
  importedFrom: string | null;
};

export type PhaseHelper = {
  name: string;
  phases: LifecyclePhase[];
  calledByCandidate: boolean;
};

export type SpanningScope = {
  kind: "try" | "transaction";
  line: number;
  phases: LifecyclePhase[];
};

export type InlineLifecyclePhasesEvidence = {
  function: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
  };
  phases: LifecyclePhase[];
  regions: PhaseRegion[];
  mixedStatements: Array<{ line: number; phases: LifecyclePhase[]; text: string }>;
  sharedBindings: string[];
  importSources: string[];
  collaborators: PhaseCollaborator[];
  phaseHelpers: PhaseHelper[];
  spanningScopes: SpanningScope[];
  callers: FunctionCaller[];
};

type Range = { start: number; end: number };

const PHASE_PRIORITY: LifecyclePhase[] = ["effect", "present", "parse", "compute"];

const EFFECT_CALL = /\b(fetch|axios|prisma|save|persist|insert|update|delete|remove|upsert|query|execute|publish|produce|enqueue|sendMail|sendEmail|writeFile|appendFile|mkdir|rm|mailer|repository|bucket|queue|topic)\b/i;
const EFFECT_ROOT = /^(db|sql|prisma|fs|mailer|repository|store|bucket|queue|client)$/i;
const RESPONSE_SEND = /\b(res|reply|response|ctx)\.(send|json|render|end|write|status)\b/;
const PRESENT_CALL = /\b(JSON\.stringify|render|toHTML|serialize)\b|format|toISOString|toLocaleString/;
const PARSE_CALL = /\b(JSON\.parse|safeParse|\.parse|validate|assert|invariant|ensure|checkSchema|decode)\b/;
const CONVERT_CALL = /^(Number|String|Boolean)$/;
const COMPUTE_CALL = /\.(map|filter|reduce|flatMap|find|some|every|sort)\b|\bMath\./;
const SKIP_ROOT = /^(console|path|Object|Array|JSON|Promise|Math|Number|String|Boolean)$/;
const REQUEST_ROOT = /^(req|request|input|raw|body|query|params|form|payload|event)$/;
const MARKUP = /<[A-Za-z][^>]*>/;

function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (source[index] === "\n") line += 1;
  }
  return line;
}

function nodeSource(node: Node, source: string): string {
  return source.slice(node.start, node.end);
}

function rootIdentifier(expression: Expression): string | undefined {
  if (expression.type === "Identifier") return expression.name;
  if (expression.type === "MemberExpression") {
    return expression.object.type === "Super" ? undefined : rootIdentifier(expression.object);
  }
  if (expression.type === "ChainExpression") return rootIdentifier(expression.expression);
  return undefined;
}

function phasesInText(text: string): LifecyclePhase[] {
  const phases = new Set<LifecyclePhase>();
  if (EFFECT_CALL.test(text) || /\b(fs|db|prisma|sql)\./.test(text)) phases.add("effect");
  if (/JSON\.stringify/.test(text) || MARKUP.test(text) || /format|render|toISOString|toLocaleString/.test(text)) {
    phases.add("present");
  }
  if (
    /JSON\.parse|\.safeParse|[^a-zA-Z]parse\(|new\s+URL\s*\(|validate|assert|invariant|ensure|decode|\.split\(/.test(text)
  ) {
    phases.add("parse");
  }
  if (/\.(map|filter|reduce|flatMap)\(|\bMath\./.test(text)) phases.add("compute");
  return [...phases];
}

export function buildInlineLifecyclePhasesEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): InlineLifecyclePhasesEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseSync(owner.filePath, owner.source, { range: true });
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;
  const name = functionName(parsed.program, fn);
  if (!name) return undefined;
  if (!fn.body || fn.body.type !== "BlockStatement") return undefined;

  const nested = nestedFunctionRanges(parsed.program, candidate);
  const eligible = (node: Range): boolean =>
    node.start >= candidate.start && node.end <= candidate.end
    && !nested.some((range) => range.start <= node.start && range.end >= node.end);

  const statements = fn.body.body.filter((statement) => eligible(statement));
  if (statements.length === 0) return undefined;
  const statementIndexAt = (offset: number): number =>
    statements.findIndex((statement) => statement.start <= offset && statement.end >= offset);

  const imports = moduleImports(parsed.program);
  const importedLocals = new Map(imports.map(({ local, source }) => [local, source] as const));

  const sameModuleHelpers = new Map<string, { start: number; end: number }>();
  new Visitor({
    FunctionDeclaration(node) {
      if (!node.id || node.id.name === name) return;
      if (node.start >= candidate.start && node.end <= candidate.end) return;
      sameModuleHelpers.set(node.id.name, { start: node.start, end: node.end });
    },
    VariableDeclarator(node) {
      if (node.id.type !== "Identifier") return;
      if (node.start >= candidate.start && node.end <= candidate.end) return;
      if (node.init?.type !== "ArrowFunctionExpression" && node.init?.type !== "FunctionExpression") return;
      sameModuleHelpers.set(node.id.name, { start: node.start, end: node.end });
    },
  }).visit(parsed.program);

  const statementPhases: Array<Set<LifecyclePhase>> = statements.map(() => new Set());
  const collaborators: PhaseCollaborator[] = [];

  const attribute = (node: Range, phase: LifecyclePhase): void => {
    const index = statementIndexAt(node.start);
    if (index >= 0) statementPhases[index]?.add(phase);
  };

  const classifyCall = (calleeText: string, root: string | undefined): LifecyclePhase | null => {
    if (!root || SKIP_ROOT.test(root)) {
      if (!RESPONSE_SEND.test(calleeText) && !PRESENT_CALL.test(calleeText) && !PARSE_CALL.test(calleeText)) {
        return null;
      }
    }
    if (RESPONSE_SEND.test(calleeText) || PRESENT_CALL.test(calleeText)) return "present";
    if (root && EFFECT_ROOT.test(root)) return "effect";
    if (EFFECT_CALL.test(calleeText)) return "effect";
    if (PARSE_CALL.test(calleeText)) return "parse";
    if (root && CONVERT_CALL.test(root)) return "parse";
    if (COMPUTE_CALL.test(calleeText)) return "compute";
    if (root && (importedLocals.has(root) || sameModuleHelpers.has(root))) return "compute";
    return null;
  };

  new Visitor({
    CallExpression(node) {
      if (!eligible(node)) return;
      if (node.callee.type !== "Identifier" && node.callee.type !== "MemberExpression" && node.callee.type !== "ChainExpression") return;
      const calleeText = nodeSource(node.callee, owner.source);
      const root = node.callee.type === "Identifier"
        ? node.callee.name
        : rootIdentifier(node.callee);
      const phase = classifyCall(calleeText, root);
      if (!phase) return;
      attribute(node, phase);
      if (root && importedLocals.has(root)) {
        collaborators.push({
          phase,
          call: nodeSource(node, owner.source).slice(0, 120),
          line: lineAt(owner.source, node.start),
          importedFrom: importedLocals.get(root) ?? null,
        });
      }
    },
    NewExpression(node) {
      if (!eligible(node)) return;
      const text = nodeSource(node, owner.source);
      if (/\bnew\s+URL\s*\(|\bnew\s+URLSearchParams\s*\(/.test(text)) attribute(node, "parse");
    },
    VariableDeclaration(node) {
      if (!eligible(node)) return;
      if (node.declarations.some((declaration) => declaration.id.type === "ObjectPattern" || declaration.id.type === "ArrayPattern")) {
        attribute(node, "parse");
      }
    },
    MemberExpression(node) {
      if (!eligible(node)) return;
      if (node.object.type !== "Identifier") return;
      if (REQUEST_ROOT.test(node.object.name)) attribute(node, "parse");
    },
    TemplateLiteral(node) {
      if (!eligible(node)) return;
      if (MARKUP.test(nodeSource(node, owner.source))) attribute(node, "present");
    },
    BinaryExpression(node) {
      if (!eligible(node)) return;
      if (node.operator === "+" && MARKUP.test(nodeSource(node, owner.source))) {
        attribute(node, "present");
      }
    },
    IfStatement(node) {
      if (!eligible(node)) return;
      if (/\bthrow\b/.test(nodeSource(node, owner.source))) attribute(node, "parse");
    },
  }).visit(parsed.program);

  const regions: PhaseRegion[] = [];
  const mixedStatements: Array<{ line: number; phases: LifecyclePhase[]; text: string }> = [];
  statements.forEach((statement, index) => {
    const found = statementPhases[index];
    if (!found || found.size === 0) return;
    const ordered = PHASE_PRIORITY.filter((phase) => found.has(phase));
    const primary = ordered[0] ?? "compute";
    if (ordered.length > 1) {
      mixedStatements.push({
        line: lineAt(owner.source, statement.start),
        phases: ordered,
        text: nodeSource(statement, owner.source).slice(0, 120),
      });
    }
    regions.push({
      phase: primary,
      line: lineAt(owner.source, statement.start),
      endLine: lineAt(owner.source, statement.end),
      text: nodeSource(statement, owner.source).slice(0, 120),
    });
  });

  const distinct = PHASE_PRIORITY.filter((phase) => regions.some((region) => region.phase === phase));
  if (distinct.length < 2) return undefined;

  const declared = new Map<string, LifecyclePhase>();
  statements.forEach((statement, index) => {
    if (statement.type !== "VariableDeclaration") return;
    const primary = PHASE_PRIORITY.find((phase) => statementPhases[index]?.has(phase));
    if (!primary) return;
    for (const declaration of statement.declarations) {
      if (declaration.id.type === "Identifier" && !declared.has(declaration.id.name)) {
        declared.set(declaration.id.name, primary);
      }
    }
  });
  const shared = new Set<string>();
  statements.forEach((statement, index) => {
    const phases = statementPhases[index];
    if (!phases || phases.size === 0) return;
    const text = nodeSource(statement, owner.source);
    for (const [binding, phase] of declared) {
      if (phases.has(phase)) continue;
      if (new RegExp(`\\b${binding}\\b`).test(text)) shared.add(binding);
    }
  });

  const candidateText = owner.source.slice(candidate.start, candidate.end);
  const phaseHelpers: PhaseHelper[] = [...sameModuleHelpers]
    .slice(0, 12)
    .map(([helperName, range]) => ({
      name: helperName,
      phases: phasesInText(owner.source.slice(range.start, range.end)),
      calledByCandidate: new RegExp(`\\b${helperName}\\s*\\(`).test(candidateText),
    }));

  const spanningScopes: SpanningScope[] = [];
  const collectScopePhases = (scope: Range): LifecyclePhase[] => {
    const found = new Set<LifecyclePhase>();
    statements.forEach((statement, index) => {
      if (statement.start >= scope.start && statement.end <= scope.end) {
        for (const phase of statementPhases[index] ?? []) found.add(phase);
      }
    });
    return PHASE_PRIORITY.filter((phase) => found.has(phase));
  };
  new Visitor({
    TryStatement(node) {
      if (!eligible(node)) return;
      const phases = collectScopePhases(node);
      if (phases.length >= 2 && spanningScopes.length < 8) {
        spanningScopes.push({ kind: "try", line: lineAt(owner.source, node.start), phases });
      }
    },
    CallExpression(node) {
      if (!eligible(node)) return;
      if (node.callee.type !== "Identifier" && node.callee.type !== "MemberExpression") return;
      if (!/transaction/i.test(nodeSource(node.callee, owner.source))) return;
      const phases = collectScopePhases(node);
      if (phases.length >= 2 && spanningScopes.length < 8) {
        spanningScopes.push({ kind: "transaction", line: lineAt(owner.source, node.start), phases });
      }
    },
  }).visit(parsed.program);

  return {
    function: {
      name,
      exported: isFunctionExported(parsed.program, fn, name),
      filePath: candidate.filePath,
      source: candidate.source,
    },
    phases: distinct,
    regions: regions.slice(0, 16),
    mixedStatements: mixedStatements.slice(0, 8),
    sharedBindings: [...shared].slice(0, 12),
    importSources: [...new Set(imports.map(({ source }) => source))].slice(0, 12),
    collaborators: collaborators.slice(0, 12),
    phaseHelpers,
    spanningScopes,
    callers: findFunctionCallers(candidate.filePath, name, projectFiles),
  };
}

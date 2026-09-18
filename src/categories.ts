// Rule categories: static per-rule display-order metadata.
//
// A category names the kind of harm a rule's proposition is about. It is
// assigned once by the rule author, carried on the rule and each judgment as
// metadata, and used ONLY to order displayed judgments (category rank first,
// probability second). Categories never filter, never gate, and never enter
// propositions or evidence: hiding by category would be a threshold by
// another name, and touching probabilities would break their meaning as
// P(proposition).
//
// There is deliberately no severity axis. A severity would either duplicate
// the probability signal or invite threshold-style reading ("low severity"
// as a hiding gate), while adding author-subjective weights with no display
// decision left to make: category rank plus probability already orders every
// pair of judgments.

export const RULE_CATEGORIES = [
  "security",
  "correctness",
  "reliability",
  "performance",
  "maintainability",
  "style",
] as const;

export type RuleCategory = (typeof RULE_CATEGORIES)[number];

const RULE_CATEGORY_VALUES: readonly string[] = RULE_CATEGORIES;

export function isRuleCategory(value: string): value is RuleCategory {
  return RULE_CATEGORY_VALUES.includes(value);
}

export function categoryRank(category: RuleCategory): number {
  return RULE_CATEGORIES.indexOf(category);
}

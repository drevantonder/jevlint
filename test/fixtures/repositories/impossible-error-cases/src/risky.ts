export function readLimit(plan: string): number {
  if (plan.length === 0) throw new Error("plan required");
  return plan.length * 3;
}

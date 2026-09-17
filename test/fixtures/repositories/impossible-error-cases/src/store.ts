export function lookupRate(plan: string): number {
  if (plan === "pro") return 20;
  if (plan === "team") return 10;
  return 5;
}

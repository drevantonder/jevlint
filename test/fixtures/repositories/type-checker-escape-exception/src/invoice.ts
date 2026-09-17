export function parseCount(input: unknown): number {
  if (typeof input !== "number") {
    throw new Error("expected a number");
  }
  const value = input as number;
  return value + 1;
}

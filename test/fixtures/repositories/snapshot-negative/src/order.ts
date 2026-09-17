export function serializeOrder(input: { id: number }): { id: number; version: string } {
  return { id: input.id, version: "v2" };
}

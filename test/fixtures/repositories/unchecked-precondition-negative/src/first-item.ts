import assert from "node:assert";

export interface Item {
  id: string;
}

export function firstItemId(items: Item[]): string {
  assert(items.length > 0, "items must not be empty");
  const first = items[0];
  return first.id;
}

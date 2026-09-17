export interface Item {
  id: string;
}

export function firstItemId(items: Item[]): string {
  const first = items[0];
  return first.id;
}

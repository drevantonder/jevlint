export async function reserveItems(items: Array<{ sku: string; quantity: number }>): Promise<void> {
  await inventory.reserve(items);
}

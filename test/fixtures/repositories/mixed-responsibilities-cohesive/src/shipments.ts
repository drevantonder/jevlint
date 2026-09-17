export async function createShipment(items: unknown[], address: string): Promise<{ id: string }> {
  return carrier.createShipment({ items, address });
}

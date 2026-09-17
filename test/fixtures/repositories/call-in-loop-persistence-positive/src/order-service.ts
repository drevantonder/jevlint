import { orderRepo } from "./order-repo.js";

export async function saveOrders(items: Array<{ id: string }>): Promise<void> {
  for (const item of items) {
    await orderRepo.save(item);
  }
}

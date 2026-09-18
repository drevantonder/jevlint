export interface Store {
  users: string[];
  orders: string[];
}

export async function fetchUser(id: string): Promise<string> {
  return id;
}

export async function getOrder(id: string): Promise<string> {
  return id;
}

export async function deleteOrder(id: string): Promise<void> {
}

export interface Store {
  users: string[];
  orders: string[];
}

export async function getUser(id: string): Promise<string> {
  return id;
}

export async function deleteUser(id: string): Promise<void> {
}

export async function getOrder(id: string): Promise<string> {
  return id;
}

export async function createOrder(id: string): Promise<string> {
  return id;
}

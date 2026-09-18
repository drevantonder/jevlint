export interface User {
  id: string;
  name: string;
}

export async function getUser(id: string): Promise<User> {
  return { id, name: "cached" };
}

export async function fetchUser(id: string): Promise<User> {
  return { id, name: "fetched" };
}

export async function createUser(name: string): Promise<User> {
  return { id: "new", name };
}

export async function getOrder(id: string): Promise<string> {
  return id;
}

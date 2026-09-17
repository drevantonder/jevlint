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

export async function retrieveUser(id: string): Promise<User> {
  return { id, name: "retrieved" };
}

export async function loadUser(id: string): Promise<User> {
  return { id, name: "loaded" };
}

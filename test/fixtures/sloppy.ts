import { normalize } from "./normalize.js";

// Return the normalized user
export function normalizeUser(user: User): User {
  return normalize(user);
}

export function saveUser(user: User): Promise<void> {
  audit("saving user");
  return repository.save(user);
}

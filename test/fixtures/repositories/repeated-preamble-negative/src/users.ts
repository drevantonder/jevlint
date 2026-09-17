export function createUser(payload: unknown): string {
  if (typeof payload !== "object" || payload === null) {
    throw new Error("invalid user payload");
  }
  return "user";
}

export function deleteUser(id: string): string {
  if (id.length === 0) {
    throw new Error("missing user id");
  }
  return "deleted";
}

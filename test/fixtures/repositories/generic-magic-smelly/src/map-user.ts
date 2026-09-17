export function hydrateUser(row: Record<string, unknown>): User {
  const user = {} as Record<string, unknown>;
  const columns = {
    id: "user_id",
    name: "display_name",
    email: "email_address",
  };
  for (const [property, column] of Object.entries(columns)) {
    Reflect.set(user, property, row[column]);
  }
  return user as User;
}

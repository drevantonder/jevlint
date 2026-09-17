export type User = { id: string; name: string };

export async function fetchUser(id: string): Promise<{ data: { user: User } }> {
  if (!id) throw new Error("UserNotFound: id is required");
  const response = await fetch(`/users/${id}`);
  const user = (await response.json()) as User;
  return { data: { user } };
}

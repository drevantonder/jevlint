export type NewUser = {
  name: string;
  email?: string;
};

export type User = NewUser & {
  id: string;
};

export function getUser(id: string): User {
  return { id, name: "ada", email: "ada@example.com" };
}

export function createUser(input: NewUser): User {
  if (!input.email) throw new Error("email is required");
  return { ...input, email: input.email, id: "u1" };
}

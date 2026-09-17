import { z } from "zod";

export const userSchema = z.object({
  name: z.string(),
  age: z.number(),
  email: z.string().email(),
});

export type User = z.infer<typeof userSchema>;

export function parseUser(input: unknown): User {
  return userSchema.parse(input);
}

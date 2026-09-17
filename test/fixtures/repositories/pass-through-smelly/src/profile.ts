import { getUserById } from "./get-user.js";

export async function loadProfile(userId: string) {
  const user = await getUserById(userId);
  return { name: user.displayName };
}

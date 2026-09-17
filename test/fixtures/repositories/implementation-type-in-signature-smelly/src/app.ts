import { getUser } from "./service";

export async function handle(db: never, id: string): Promise<string> {
  const user = await getUser(db, id);
  return user?.displayName ?? "unknown";
}

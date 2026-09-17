import type { DbClient } from "db-driver";

export interface User {
  id: string;
  displayName: string;
}

export async function getUser(db: DbClient, id: string): Promise<User | undefined> {
  return db.findUser(id);
}

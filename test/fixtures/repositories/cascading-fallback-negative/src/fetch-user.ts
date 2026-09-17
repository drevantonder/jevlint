import { pool } from "./db.js";

const staticCache = new Map<number, unknown>();

export async function fetchUser(id: number): Promise<unknown> {
  try {
    return await pool.query(`select * from users where id = ${id}`);
  } catch {
    return staticCache.get(id) ?? { id, name: "unknown" };
  }
}

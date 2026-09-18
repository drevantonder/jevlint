import { pool } from "./db.js";

export async function fetchUser(id: number): Promise<unknown> {
  try {
    return await pool.query(`select * from users where id = ${id}`);
  } catch {
    return await pool.query(`select * from users where id = ${id}`);
  }
}

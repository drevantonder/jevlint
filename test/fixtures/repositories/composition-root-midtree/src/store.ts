import type { Db } from "./db.js";

export type Order = { id: string; amount: number };

export class PostgresStore {
  constructor(private connectionString: string) {}

  save(record: { order: Order; db: Db; legacy: unknown }): void {
    void this.connectionString;
    void record;
  }

  all(): Order[] {
    return [];
  }
}

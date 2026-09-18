import type { Db } from "./db.js";

export class PostgresStore {
  constructor(private root: string) {}

  save(record: { verbose: boolean; db: Db; legacy: unknown }): number {
    void this.root;
    void record;
    return 1;
  }
}

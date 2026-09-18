export class Db {
  private static instance: Db | undefined;

  static getInstance(): Db {
    if (!Db.instance) Db.instance = new Db();
    return Db.instance;
  }
}

export function getDatabase(): Db {
  return Db.getInstance();
}

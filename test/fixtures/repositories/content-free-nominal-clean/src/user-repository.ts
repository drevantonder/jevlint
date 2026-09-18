export class UserRepository {
  private users: Map<string, string> = new Map();

  findById(id: string): string | undefined {
    return this.users.get(id);
  }

  save(id: string, name: string): void {
    this.users.set(id, name);
  }

  remove(id: string): void {
    this.users.delete(id);
  }
}

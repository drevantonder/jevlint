function audit(entry: string): void {
  console.log(entry);
}

export class Ledger {
  private entries: string[] = [];

  post(entry: string): void {
    if (entry.length === 0) {
      throw new Error("empty entry");
    }
    this.entries.push(entry);
    audit(entry);
  }

  count(): number {
    return this.entries.length;
  }
}

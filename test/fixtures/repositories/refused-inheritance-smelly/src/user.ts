export class User {
  name = "";

  save(): void {
    this.name = this.name.trim();
  }

  delete(): void {
    this.name = "";
  }

  rename(name: string): void {
    this.name = name;
  }
}

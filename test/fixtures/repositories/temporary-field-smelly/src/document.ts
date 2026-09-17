export class Document {
  title: string;
  private parsed?: string[];

  constructor(title: string) {
    this.title = title;
  }

  parse(source: string): void {
    this.parsed = source.split("\n");
  }

  render(): string {
    if (!this.parsed) {
      throw new Error("parse first");
    }
    return this.parsed.join("");
  }
}

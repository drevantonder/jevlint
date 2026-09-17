export class Strict {
  value: string;

  constructor(value: string) {
    this.value = value;
  }

  read(): string {
    return this.value;
  }
}

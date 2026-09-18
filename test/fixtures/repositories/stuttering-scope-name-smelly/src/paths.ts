export class Router {
  private prefix: string;

  constructor(prefix: string) {
    this.prefix = prefix;
  }

  resolve(path: string): string {
    return `${this.prefix}${path}`;
  }
}

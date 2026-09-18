export class Config {
  private baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
  }

  configPath(name: string): string {
    return `${this.baseDir}/${name}`;
  }

  configDir(): string {
    return this.baseDir;
  }
}

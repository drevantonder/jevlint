export const logger = {
  error(message: string, details: unknown): void {
    void message;
    void details;
  },
  warn(message: string, details: unknown): void {
    void message;
    void details;
  },
};

export const store = {
  async read(key: string): Promise<string> {
    return key;
  },
};

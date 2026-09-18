export const client = {
  embed: async (inputs: string[]): Promise<number[][]> =>
    inputs.map((input) => [input.length]),
};

export function isTokenLimit(error: unknown): boolean {
  return error instanceof Error && /token/i.test(error.message);
}

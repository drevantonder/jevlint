export const pool = {
  query: async (sql: string): Promise<{ id: number }[]> => [{ id: 1, sql: sql.length }],
};

export function selectFields<T extends object>(
  record: T,
  fields: readonly (keyof T)[],
): Partial<T> {
  return Object.fromEntries(fields.map((field) => [field, record[field]])) as Partial<T>;
}

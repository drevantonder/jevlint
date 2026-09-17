export type ValidationError = { field: string; message: string };

export function validateUser(input: unknown): ValidationError[] {
  const errors: ValidationError[] = [];
  if (typeof input !== "object" || input === null) {
    errors.push({ field: "$", message: "expected an object" });
    return errors;
  }
  const record = input as Record<string, unknown>;
  if (typeof record.name !== "string") {
    errors.push({ field: "name", message: "expected a string" });
  }
  if (typeof record.age !== "number") {
    errors.push({ field: "age", message: "expected a number" });
  }
  if (typeof record.email !== "string") {
    errors.push({ field: "email", message: "expected a string" });
  }
  return errors;
}

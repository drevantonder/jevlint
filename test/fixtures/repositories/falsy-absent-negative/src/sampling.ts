import { labelSchema } from "./schema.js";

export function displayLabel(input: unknown): string {
  const parsed = labelSchema.parse(input);
  if (parsed.label) {
    return parsed.label;
  }
  return "untitled";
}

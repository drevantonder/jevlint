import { displayLabel } from "./sampling.js";

export function configure(input: unknown) {
  return { label: displayLabel(input) };
}

import { effectiveSampleRate } from "./sampling.js";

export function configure(input: unknown) {
  return { rate: effectiveSampleRate(input) };
}

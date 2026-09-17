import { samplingSchema } from "./schema.js";

export function effectiveSampleRate(input: unknown): number {
  const parsed = samplingSchema.parse(input);
  if (parsed.sampleRate) {
    return parsed.sampleRate;
  }
  return 1;
}

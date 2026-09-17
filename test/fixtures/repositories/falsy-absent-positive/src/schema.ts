import { z } from "zod";

export const samplingSchema = z.object({
  sampleRate: z.number().min(0).max(1),
});

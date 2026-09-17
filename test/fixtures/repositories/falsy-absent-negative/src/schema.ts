import { z } from "zod";

export const labelSchema = z.object({
  label: z.string().min(1),
});

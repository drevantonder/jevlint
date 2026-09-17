import { z } from "zod";

export const userSchema = z.object({ name: z.string() });
export const orgSchema = z.object({ slug: z.string() });
export const tokenSchema = z.string().min(8);

import { z } from "zod";

export function parseName(raw: unknown): string {
  return z.string().parse(raw);
}

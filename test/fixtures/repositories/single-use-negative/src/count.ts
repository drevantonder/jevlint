import { z } from "zod";

export function parseCount(raw: unknown): number {
  return z.number().parse(raw);
}

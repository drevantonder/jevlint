import { format } from "./format";

export function labelB(code: string): string {
  return `b:${format(code)}`;
}

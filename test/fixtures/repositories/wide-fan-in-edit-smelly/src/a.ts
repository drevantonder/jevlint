import { format } from "./format";

export function labelA(code: string): string {
  return `a:${format(code)}`;
}

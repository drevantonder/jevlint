import { format } from "./format";

export function labelC(code: string): string {
  return `c:${format(code)}`;
}

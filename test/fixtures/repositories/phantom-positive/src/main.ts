import { parse } from "date-fns-tz-extended";

export function convertTimestamp(raw: string): number {
  return parse(raw).getTime();
}

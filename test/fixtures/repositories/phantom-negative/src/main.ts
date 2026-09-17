import { format } from "date-fns";
import { join } from "node:path";
import { readCount } from "./util.js";

export function renderStamp(raw: string): string {
  return join(readCount(), format(new Date(raw), "yyyy-MM-dd"));
}

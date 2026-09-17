import { format } from "date-fns";

export function renderStamp(raw: string): string {
  return format(new Date(raw), "yyyy-MM-dd");
}

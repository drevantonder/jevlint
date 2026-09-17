import dayjs from "dayjs";

export function renderLedger(raw: string): string {
  return dayjs(raw).format("YYYY-MM-DD");
}

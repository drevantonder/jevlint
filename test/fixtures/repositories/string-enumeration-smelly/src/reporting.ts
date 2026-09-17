export function reportLabel(status: string): string {
  if (status === "active" || status === "paused") {
    return `account ${status}`;
  }
  if (status === "archived") {
    return "account archived";
  }
  return "account unknown";
}

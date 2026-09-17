export function readTimeoutFlag(args: Record<string, string>): number {
  return Number(args["--request-timeout"] ?? "5000");
}

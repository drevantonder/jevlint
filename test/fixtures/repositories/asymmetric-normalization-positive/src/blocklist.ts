import { blockedSenders } from "./email-policy.js";

export function isBlocked(inputEmail: string): boolean {
  const normalized = blockedSenders.map((entry) => entry.toLowerCase());
  return normalized.includes(inputEmail);
}

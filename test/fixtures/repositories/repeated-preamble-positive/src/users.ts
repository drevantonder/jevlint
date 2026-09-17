import { reportError } from "./telemetry";

export function createUser(payload: unknown): string {
  if (!payload) {
    reportError("empty payload");
    throw new Error("empty payload");
  }
  return "user";
}

export function deleteUser(payload: unknown): string {
  if (!payload) {
    reportError("empty payload");
    throw new Error("empty payload");
  }
  return "deleted";
}

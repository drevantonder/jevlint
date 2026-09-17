import { contractStatus } from "./contract.js";

export const DEFAULT_STATUS = "ACTIVE_V1";

export function isActive(status: string = DEFAULT_STATUS): boolean {
  return status === contractStatus;
}

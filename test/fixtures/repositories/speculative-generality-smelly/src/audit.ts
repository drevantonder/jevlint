import { formatUserName } from "./format-user-name.js";

export function auditLabel(user: User): string {
  return formatUserName(user);
}

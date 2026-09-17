import { formatUserName } from "./format-user-name.js";

export function profileTitle(user: User): string {
  return formatUserName(user);
}

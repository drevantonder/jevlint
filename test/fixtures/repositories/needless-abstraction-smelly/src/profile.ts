import { DefaultUserNameFormatter } from "./user-name-formatter.js";

const formatter = new DefaultUserNameFormatter();

export function profileTitle(user: User): string {
  return formatter.format(user);
}

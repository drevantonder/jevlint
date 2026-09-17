import { memberDisplayName } from "./member.js";

export function renderMember(id: string) {
  return { name: memberDisplayName(id) };
}

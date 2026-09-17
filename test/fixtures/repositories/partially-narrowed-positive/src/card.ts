import { displayName } from "./member.js";

export function renderCard(id: string) {
  return { label: displayName({ id, profile: { name: "a" } }) };
}

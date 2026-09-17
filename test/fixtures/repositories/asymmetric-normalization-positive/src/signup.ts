import { isBlocked } from "./blocklist.js";

export function signup(inputEmail: string) {
  if (isBlocked(inputEmail)) throw new Error("blocked");
  return { inputEmail };
}

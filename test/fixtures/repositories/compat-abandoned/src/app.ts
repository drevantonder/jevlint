import { authenticate } from "./auth.js";

export function login(token: string): string {
  return authenticate(token) ? "ok" : "denied";
}

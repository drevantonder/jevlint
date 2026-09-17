import { registerUser } from "./register-user.js";

export function signup(form: RegistrationInput) {
  return registerUser({
    normalizeEmail: (value) => value.trim().toLowerCase(),
    validateEmail: (value) => value.includes("@"),
    normalizeName: (value) => value.trim(),
    persist: (user) => users.insert(user),
  }, form);
}

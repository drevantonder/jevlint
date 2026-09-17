import { registerUser } from "./register-user.js";

export function signup(form: RegistrationInput) {
  return registerUser(form);
}

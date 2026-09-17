import { directory } from "./directory.js";

export class InvalidCredentialsError extends Error {}

export async function authenticate(email: string, password: string) {
  try {
    return await directory.verify(email, password);
  } catch {
    // Deliberately collapse missing-account and password failures to prevent account enumeration.
    throw new InvalidCredentialsError("Email or password is incorrect");
  }
}
